/**
 * 采集流水线依赖编排：把流水线步骤编译成按波次执行的计划，并派生就绪批次清单。
 *
 * 这里的函数全部是纯函数（不读写 localStorage、不依赖浏览器），页面、本地数据层和终端
 * 校验脚本共用同一套判定，避免「页面显示一套、真正执行另一套」。
 *
 * 参与编排的记录必须同时带齐「步骤编号、输入数据源、处理逻辑、输出目标、依赖步骤」，
 * 缺任何一项都按缺失输入处理，不生成半张执行计划。
 */

export type StepStatus = string

export type PipelineStepRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  stepNo: string
  name: string
  input: string
  logic: string
  output: string
  dependsOn: string[]
  /** 原始行，编排只读取上面这些字段，其余字段仅做展示 */
  raw: Record<string, string | number | boolean>
}

export type BatchPolicy = 'conflict-serial' | 'parallel-merge'
export type BatchMode = BatchPolicy | 'blocked'
/** 写入方式与批次策略一一对应：串行写，或并行写、末步合并。 */
export type WriteMode = BatchPolicy

export const POLICY_LABEL: Record<BatchPolicy, string> = {
  'conflict-serial': '按输出目标冲突串行执行',
  'parallel-merge': '允许并行并在末步合并文件',
}

export const WRITE_MODE_LABEL: Record<WriteMode, string> = { ...POLICY_LABEL }

export const PIPELINE_STATUS = {
  draft: '草稿',
  submitted: '待校验',
  enabled: '已启用',
  disabled: '已停用',
} as const

export type IssueCode =
  | 'empty-pipeline'
  | 'missing-step-no'
  | 'duplicate-step-no'
  | 'missing-field'
  | 'unknown-dependency'
  | 'self-dependency'
  | 'dependency-cycle'
  | 'dependency-not-ready'
  | 'no-runnable-steps'

export type PipelineIssue = {
  code: IssueCode
  stepId: number | null
  stepNo: string
  field: string
  message: string
}

export type BatchConflict = {
  output: string
  /** 先写的步骤 → 被串行后移的步骤 */
  stepNos: [string, string]
  /** 冲突串行策略下两步各自的波次 */
  serialWaves: [number, number]
  /** 允许并行策略下两步同处的波次 */
  sharedWave: number
}

export type PlanBatch = {
  wave: number
  steps: PipelineStepRow[]
  /** 因输出目标冲突被后移到这一波的步骤编号 */
  serialized: string[]
  /** 在这一波被记录的冲突（与上一波写入者的冲突） */
  conflicts: BatchConflict[]
}

export type CompiledPlan = {
  policy: BatchPolicy
  writeMode: WriteMode
  batches: PlanBatch[]
  waveCount: number
  /** 依赖边：from 是前置步骤，to 是后继步骤 */
  edges: { from: string; to: string }[]
  /** 每个步骤实际落入的波次 */
  assignments: Record<string, number>
  conflicts: BatchConflict[]
}

export type ValidationResult = {
  ok: boolean
  issues: PipelineIssue[]
  /** 登记齐全、通过校验的步骤 */
  steps: PipelineStepRow[]
  /** 已启用、可进入就绪批次的步骤 */
  runnable: PipelineStepRow[]
  /** 未启用、本批不参与的步骤 */
  skipped: PipelineStepRow[]
}

function text(value: unknown): string {
  return String(value ?? '').trim()
}

/** 「A,B」/「A、B」/「A；B」/换行都能识别；去重后按出现顺序保留。 */
export function parseDependencies(value: unknown): string[] {
  const parts = text(value)
    .split(/[,，、;；\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
  return [...new Set(parts)]
}

/** 输出目标允许写多个（逗号/竖线分隔），每个都要参与冲突判定。 */
export function parseOutputs(step: PipelineStepRow): string[] {
  return text(step.output)
    .split(/[,，、;；|]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function fieldOf(row: Record<string, string | number | boolean>, field: string): string {
  return text(row[field])
}

export function normalizeStep(row: Record<string, string | number | boolean>): PipelineStepRow {
  return {
    id: Number(row.id),
    status: text(row.status),
    pending: Boolean(row.pending),
    abnormal: Boolean(row.abnormal),
    stepNo: fieldOf(row, '步骤编号'),
    name: fieldOf(row, '步骤名称'),
    input: fieldOf(row, '输入数据源'),
    logic: fieldOf(row, '处理逻辑'),
    output: fieldOf(row, '输出目标'),
    dependsOn: parseDependencies(row['依赖步骤']),
    raw: row,
  }
}

export function normalizeSteps(rows: Record<string, string | number | boolean>[]): PipelineStepRow[] {
  return rows.map((row) => normalizeStep(row))
}

export function isEnabled(step: PipelineStepRow): boolean {
  return step.status === PIPELINE_STATUS.enabled
}

export function hasCompleteShape(step: PipelineStepRow): boolean {
  return Boolean(step.stepNo && step.input && step.logic && step.output)
}

export function inputsReady(step: PipelineStepRow, rows: PipelineStepRow[]): boolean {
  if (!hasCompleteShape(step) || !isEnabled(step)) {
    return false
  }
  if (step.dependsOn.length === 0) {
    return true
  }
  const byNo = new Map(rows.map((item) => [item.stepNo, item]))
  return step.dependsOn.every((no) => {
    const dependency = byNo.get(no)
    return Boolean(dependency && isEnabled(dependency))
  })
}

/** 拓扑排序（Kahn）：返回可推进的顺序与剩余成环的步骤编号。 */
export function topologicalOrder(steps: PipelineStepRow[]): {
  order: string[]
  cycle: string[]
} {
  const byNo = new Map(steps.map((item) => [item.stepNo, item]))
  const indegree = new Map<string, number>()
  const children = new Map<string, string[]>()
  for (const step of steps) {
    indegree.set(step.stepNo, 0)
    children.set(step.stepNo, [])
  }
  for (const step of steps) {
    for (const parent of step.dependsOn) {
      if (!byNo.has(parent) || parent === step.stepNo) {
        continue
      }
      indegree.set(step.stepNo, (indegree.get(step.stepNo) ?? 0) + 1)
      children.get(parent)?.push(step.stepNo)
    }
  }
  const queue = steps
    .map((item) => item.stepNo)
    .filter((no) => (indegree.get(no) ?? 0) === 0)
    .sort((a, b) => a.localeCompare(b))
  const order: string[] = []
  while (queue.length > 0) {
    const current = queue.shift() as string
    order.push(current)
    for (const child of [...(children.get(current) ?? [])].sort((a, b) => a.localeCompare(b))) {
      const left = (indegree.get(child) ?? 0) - 1
      indegree.set(child, left)
      if (left === 0) {
        queue.push(child)
      }
    }
    queue.sort((a, b) => a.localeCompare(b))
  }
  const cycle = steps
    .map((item) => item.stepNo)
    .filter((no) => !order.includes(no))
    .sort((a, b) => a.localeCompare(b))
  return { order, cycle }
}

/**
 * 校验依赖：编号唯一、字段齐全、依赖存在、无自依赖、无环路、被依赖步骤必须已启用。
 * 任何一条不通过都返回 issues，调用方据此拒绝发布计划。
 */
export function validatePipeline(rows: Record<string, string | number | boolean>[]): ValidationResult {
  const steps = normalizeSteps(rows)
  const issues: PipelineIssue[] = []
  if (steps.length === 0) {
    return {
      ok: false,
      issues: [
        {
          code: 'empty-pipeline',
          stepId: null,
          stepNo: '',
          field: '',
          message: '没有可编排的流水线步骤，不生成执行计划',
        },
      ],
      steps: [],
      runnable: [],
      skipped: [],
    }
  }
  const byNo = new Map<string, PipelineStepRow[]>()
  for (const step of steps) {
    if (!step.stepNo) {
      issues.push({
        code: 'missing-step-no',
        stepId: step.id,
        stepNo: '',
        field: '步骤编号',
        message: `记录 ${step.id} 缺少步骤编号，无法作为依赖依据`,
      })
      continue
    }
    const bucket = byNo.get(step.stepNo) ?? []
    bucket.push(step)
    byNo.set(step.stepNo, bucket)
  }
  for (const [no, bucket] of byNo) {
    if (bucket.length > 1) {
      issues.push({
        code: 'duplicate-step-no',
        stepId: bucket[0].id,
        stepNo: no,
        field: '步骤编号',
        message: `步骤编号 ${no} 被 ${bucket.length} 条记录重复使用，依赖指向不唯一`,
      })
    }
  }
  const known = new Set(steps.map((item) => item.stepNo).filter(Boolean))
  for (const step of steps) {
    if (!step.stepNo) {
      continue
    }
    for (const field of ['输入数据源', '处理逻辑', '输出目标'] as const) {
      if (!fieldOf(step.raw, field)) {
        issues.push({
          code: 'missing-field',
          stepId: step.id,
          stepNo: step.stepNo,
          field,
          message: `步骤 ${step.stepNo} 缺少${field}，输入不完整`,
        })
      }
    }
    for (const parent of step.dependsOn) {
      if (parent === step.stepNo) {
        issues.push({
          code: 'self-dependency',
          stepId: step.id,
          stepNo: step.stepNo,
          field: '依赖步骤',
          message: `步骤 ${step.stepNo} 依赖了自己`,
        })
      } else if (!known.has(parent)) {
        issues.push({
          code: 'unknown-dependency',
          stepId: step.id,
          stepNo: step.stepNo,
          field: '依赖步骤',
          message: `步骤 ${step.stepNo} 依赖的步骤 ${parent} 不存在`,
        })
      }
    }
  }
  const shaped = steps.filter((step) => step.stepNo)
  const { cycle } = topologicalOrder(shaped)
  if (cycle.length > 0) {
    issues.push({
      code: 'dependency-cycle',
      stepId: null,
      stepNo: cycle.join(' → '),
      field: '依赖步骤',
      message: `依赖步骤形成环路：${cycle.join(' → ')}，整张执行计划拒绝生成`,
    })
  }
  const runnable = steps.filter((step) => isEnabled(step))
  const skipped = steps.filter((step) => !isEnabled(step) && step.stepNo)
  if (issues.length === 0 && runnable.length === 0) {
    issues.push({
      code: 'no-runnable-steps',
      stepId: null,
      stepNo: '',
      field: '当前状态',
      message: '没有任何已启用的流水线步骤，不生成就绪批次',
    })
  }
  if (issues.length === 0) {
    const runnableByNo = new Map(runnable.map((step) => [step.stepNo, step]))
    for (const step of runnable) {
      for (const parent of step.dependsOn) {
        if (!runnableByNo.has(parent)) {
          issues.push({
            code: 'dependency-not-ready',
            stepId: step.id,
            stepNo: step.stepNo,
            field: '依赖步骤',
            message: `步骤 ${step.stepNo} 依赖的 ${parent} 未启用，输入未就绪，不进入就绪批次`,
          })
        }
      }
    }
  }
  return { ok: issues.length === 0, issues, steps, runnable, skipped }
}

function dependencyDepth(order: string[], byNo: Map<string, PipelineStepRow>): Map<string, number> {
  const depth = new Map<string, number>()
  for (const no of order) {
    const step = byNo.get(no)
    if (!step) {
      continue
    }
    let level = 1
    for (const parent of step.dependsOn) {
      level = Math.max(level, (depth.get(parent) ?? 0) + 1)
    }
    depth.set(no, level)
  }
  return depth
}

/**
 * 生成波次：
 * - conflict-serial：同波次内多个步骤写同一个输出目标时，按步骤编号排序后只有第一个留在本波，
 *   其余整体后移一波；后移会继续推高它们下游步骤的波次。
 * - parallel-merge：不因输出目标拆分波次，冲突留给末步合并文件。
 *
 * 无论哪种策略，每一步都必须等它的全部依赖落在更早的波次。
 */
function assignWaves(
  order: string[],
  byNo: Map<string, PipelineStepRow>,
  depth: Map<string, number>,
  policy: BatchPolicy,
): Map<string, number> {
  const assignments = new Map<string, number>()
  for (const no of order) {
    const step = byNo.get(no)
    if (!step) {
      continue
    }
    const dependencyFloor = step.dependsOn.reduce(
      (level, parent) => Math.max(level, (assignments.get(parent) ?? 0) + 1),
      1,
    )
    let wave = Math.max(depth.get(no) ?? 1, dependencyFloor)
    if (policy === 'conflict-serial') {
      // 同波次里已经有步骤要写同一个输出目标时，按拓扑顺序把当前步骤继续后移。
      // 后移只发生在当前步骤上，已排好的步骤不会再被挪动，重复扫描不会重复入批。
      let moved = true
      while (moved) {
        moved = false
        for (const other of order) {
          if (other === no || (assignments.get(other) ?? 0) !== wave) {
            continue
          }
          const shared = parseOutputs(step).find((output) =>
            parseOutputs(byNo.get(other) as PipelineStepRow).includes(output),
          )
          if (shared) {
            wave += 1
            moved = true
            break
          }
        }
      }
    }
    assignments.set(no, wave)
  }
  return assignments
}

/** 收集所有「多个步骤写同一个输出目标」的冲突对，并给出两种策略下的波次。 */
function collectConflicts(
  runnable: PipelineStepRow[],
  serialAssignments: Map<string, number>,
  parallelAssignments: Map<string, number>,
): BatchConflict[] {
  const buckets = new Map<string, string[]>()
  for (const step of runnable) {
    for (const output of parseOutputs(step)) {
      const bucket = buckets.get(output) ?? []
      bucket.push(step.stepNo)
      buckets.set(output, bucket)
    }
  }
  const conflicts: BatchConflict[] = []
  for (const [output, stepNos] of buckets) {
    if (stepNos.length < 2) {
      continue
    }
    const sorted = [...stepNos].sort((a, b) => a.localeCompare(b))
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const first = sorted[i]
        const second = sorted[j]
        conflicts.push({
          output,
          stepNos: [first, second],
          serialWaves: [serialAssignments.get(first) ?? 0, serialAssignments.get(second) ?? 0],
          sharedWave: Math.max(
            parallelAssignments.get(first) ?? 0,
            parallelAssignments.get(second) ?? 0,
          ),
        })
      }
    }
  }
  return conflicts
}

export function compileBatches(
  runnable: PipelineStepRow[],
  policy: BatchPolicy,
): CompiledPlan {
  const byNo = new Map(runnable.map((step) => [step.stepNo, step]))
  const { order } = topologicalOrder(runnable)
  const depth = dependencyDepth(order, byNo)
  const serialAssignments = assignWaves(order, byNo, depth, 'conflict-serial')
  const parallelAssignments = assignWaves(order, byNo, depth, 'parallel-merge')
  const assignments = policy === 'conflict-serial' ? serialAssignments : parallelAssignments
  const conflicts = collectConflicts(runnable, serialAssignments, parallelAssignments)
  // 只有「自己的输出目标被别人先写」而整体后移的步骤才算冲突后移；
  // 单纯被上游拖后的步骤不标记，避免把依赖等待误报成写冲突。
  const serialized = new Set(
    policy === 'conflict-serial'
      ? conflicts
          .filter((item) => item.serialWaves[0] < item.serialWaves[1])
          .map((item) => item.stepNos[1])
      : [],
  )

  const waves = [...new Set([...assignments.values()])].sort((a, b) => a - b)
  const batches: PlanBatch[] = waves.map((wave, index) => {
    const members = order
      .filter((no) => assignments.get(no) === wave)
      .map((no) => byNo.get(no) as PipelineStepRow)
      .sort((a, b) => a.stepNo.localeCompare(b.stepNo))
    return {
      wave: index + 1,
      steps: members,
      serialized: members.filter((step) => serialized.has(step.stepNo)).map((step) => step.stepNo),
      conflicts:
        policy === 'conflict-serial'
          ? conflicts.filter(
              (item) =>
                (assignments.get(item.stepNos[1]) ?? 0) === wave &&
                item.serialWaves[0] < item.serialWaves[1],
            )
          : [],
    }
  })
  const edges = runnable.flatMap((step) =>
    step.dependsOn.map((parent) => ({ from: parent, to: step.stepNo })),
  )
  return {
    policy,
    writeMode: policy,
    batches,
    waveCount: batches.length,
    edges,
    assignments: Object.fromEntries(assignments),
    conflicts,
  }
}

export type PipelinePlan = {
  validation: ValidationResult
  plan: CompiledPlan | null
}

/**
 * 编排入口：先校验，再按策略生成波次。校验不通过时 plan 为 null——调用方不得写入任何
 * 半成品，这是「环路或缺失输入不能生成半张执行计划」的落点。
 */
export function planPipeline(
  rows: Record<string, string | number | boolean>[],
  policy: BatchPolicy,
): PipelinePlan {
  const validation = validatePipeline(rows)
  if (!validation.ok) {
    return { validation, plan: null }
  }
  return { validation, plan: compileBatches(validation.runnable, policy) }
}

/** 双策略比对：同一个输入分别按冲突串行与并行合并编译，用于冲突边界核对。 */
export function comparePolicies(
  rows: Record<string, string | number | boolean>[],
): Record<BatchPolicy, PipelinePlan> {
  return {
    'conflict-serial': planPipeline(rows, 'conflict-serial'),
    'parallel-merge': planPipeline(rows, 'parallel-merge'),
  }
}

// ---------------------------------------------------------------------------
// 批次视图
// ---------------------------------------------------------------------------

export type BatchViewRow = {
  batchId: string
  policy: BatchPolicy
  wave: number
  stepNos: string
  stepCount: number
  /** 批次内步骤明细，清单发布后随批次一起冻结 */
  stepDetails: BatchStepView[]
  dependencies: string
  inputStatus: string
  writeMode: WriteMode
  serialized: string
  conflicts: string
}

export type BatchStepView = {
  batchId: string
  stepNo: string
  name: string
  input: string
  output: string
  dependencies: string
  inputStatus: '输入完整' | '缺依赖' | '未启用'
  status: string
  writeMode: WriteMode
}

/** 批次视图：概览按波次排列，明细列出每一步的依赖与输入状态。 */
export function buildBatchView(
  plan: CompiledPlan,
  rows: PipelineStepRow[],
): { batches: BatchViewRow[]; steps: BatchStepView[] } {
  const writeMode = plan.writeMode
  const steps: BatchStepView[] = []
  const batches = plan.batches.map((batch) => {
    const batchId = `W${String(batch.wave).padStart(2, '0')}`
    const allDependencies = new Set<string>()
    let blocked = false
    const stepDetails: BatchStepView[] = []
    for (const step of batch.steps) {
      const ready = inputsReady(step, rows)
      if (!ready) {
        blocked = true
      }
      for (const parent of step.dependsOn) {
        allDependencies.add(parent)
      }
      const detail: BatchStepView = {
        batchId,
        stepNo: step.stepNo,
        name: step.name,
        input: step.input,
        output: step.output,
        dependencies: step.dependsOn.join('、') || '—',
        inputStatus: ready ? (isEnabled(step) ? '输入完整' : '未启用') : '缺依赖',
        status: step.status,
        writeMode,
      }
      stepDetails.push(detail)
      steps.push(detail)
    }
    return {
      batchId,
      policy: plan.policy,
      wave: batch.wave,
      stepNos: batch.steps.map((step) => step.stepNo).join('、'),
      stepCount: batch.steps.length,
      stepDetails,
      dependencies: [...allDependencies].sort().join('、') || '无（首批）',
      inputStatus: blocked ? '存在缺依赖步骤' : '输入完整',
      writeMode,
      serialized: batch.serialized.join('、') || '—',
      conflicts:
        batch.conflicts
          .map((item) => `${item.output}：${item.stepNos[0]} → ${item.stepNos[1]}`)
          .join('；') || '—',
    }
  })
  return { batches, steps }
}

/** 冲突边界摘要：串行策略与并行策略在波次、文件版本上的差异。 */
export type ConflictBoundary = {
  output: string
  stepNos: string[]
  serialWaves: number[]
  sharedWave: number
  serialWrite: string
  parallelWrite: string
  serialFileVersion: string
  parallelFileVersion: string
}

export function describeConflictBoundaries(
  rows: Record<string, string | number | boolean>[],
): ConflictBoundary[] {
  const serial = planPipeline(rows, 'conflict-serial')
  const parallel = planPipeline(rows, 'parallel-merge')
  if (!serial.plan || !parallel.plan) {
    return []
  }
  const seen = new Set<string>()
  const boundaries: ConflictBoundary[] = []
  for (const item of serial.plan.conflicts) {
    if (item.serialWaves[0] === item.serialWaves[1] || seen.has(item.output)) {
      continue
    }
    seen.add(item.output)
    const stepNos = [...new Set(
      serial.plan.conflicts.filter((entry) => entry.output === item.output).flatMap((entry) => entry.stepNos),
    )].sort((a, b) => a.localeCompare(b))
    const serialWaves = [...new Set(stepNos.map((no) => serial.plan?.assignments[no] ?? 0))].sort(
      (a, b) => a - b,
    )
    const sharedWave = Math.max(...stepNos.map((no) => parallel.plan?.assignments[no] ?? 0))
    boundaries.push({
      output: item.output,
      stepNos,
      serialWaves,
      sharedWave,
      serialWrite: serialWaves
        .map((wave) => {
          const writer = stepNos.find((no) => serial.plan?.assignments[no] === wave)
          return `${writer} 第 ${wave} 波写入`
        })
        .join(' → '),
      parallelWrite: `${stepNos.join('、')} 同日并行写入，第 ${sharedWave} 波末步合并`,
      serialFileVersion: `${item.output} 产生 ${serialWaves.length} 个串行版本，按波次递增`,
      parallelFileVersion: `${item.output} 只保留末步合并后的 1 个版本，覆盖中间版本`,
    })
  }
  return boundaries
}

/**
 * 核对条件：把「依赖未就绪不执行」和「环路明确拒绝」做成可回查的自检。
 * 自检只读取传入的行并在内存里构造变体，不修改任何登记数据。
 */
export type VerificationCheck = {
  key: string
  name: string
  condition: string
  passed: boolean
  detail: string
}

export function runVerificationChecks(
  rows: Record<string, string | number | boolean>[],
): VerificationCheck[] {
  const checks: VerificationCheck[] = []
  const validation = validatePipeline(rows)
  const shaped = validation.steps.filter((step) => step.stepNo)

  if (validation.ok) {
    const serial = compileBatches(validation.runnable, 'conflict-serial')
    const seen = new Set<string>()
    let duplicated = ''
    for (const batch of serial.batches) {
      for (const step of batch.steps) {
        if (seen.has(step.stepNo)) {
          duplicated = step.stepNo
        }
        seen.add(step.stepNo)
      }
    }
    checks.push({
      key: 'unique-batch',
      name: '重复扫描不重复入批',
      condition: '同一步骤只出现在一个就绪批次',
      passed: duplicated === '' && seen.size === validation.runnable.length,
      detail: duplicated
        ? `步骤 ${duplicated} 出现在多个批次`
        : `${seen.size} 个可运行步骤分布在 ${serial.batches.length} 个批次，无重复`,
    })
    checks.push({
      key: 'downstream-release',
      name: '下游按批次释放',
      condition: '每步的依赖波次都严格早于自身波次',
      passed: validation.runnable.every((step) =>
        step.dependsOn.every(
          (parent) => (serial.assignments[parent] ?? 0) < (serial.assignments[step.stepNo] ?? 0),
        ),
      ),
      detail: validation.runnable
        .filter((step) =>
          step.dependsOn.some(
            (parent) => (serial.assignments[parent] ?? 0) >= (serial.assignments[step.stepNo] ?? 0),
          ),
        )
        .map((step) => step.stepNo)
        .join('、') || '所有依赖都在更早波次完成',
    })
  } else {
    checks.push({
      key: 'unique-batch',
      name: '重复扫描不重复入批',
      condition: '同一步骤只出现在一个就绪批次',
      passed: false,
      detail: '当前登记未通过依赖校验，没有可发布的就绪批次',
    })
    checks.push({
      key: 'downstream-release',
      name: '下游按批次释放',
      condition: '每步的依赖波次都严格早于自身波次',
      passed: false,
      detail: '当前登记未通过依赖校验，没有可发布的就绪批次',
    })
  }

  if (shaped.length > 0) {
    // 取一条现成的依赖边 parent → child，再给 parent 补上依赖 child 的回边，
    // 这一步必然构成二元环；把「构造后是否被拒绝」作为核对依据。
    const edgeStep = validation.steps.find((step) => step.dependsOn.length > 0)
    if (edgeStep) {
      const child = edgeStep.stepNo
      const parent = edgeStep.dependsOn[0]
      const cyclic = rows.map((row) => {
        if (String(row['步骤编号']) !== parent) {
          return row
        }
        const dependencies = parseDependencies(row['依赖步骤'])
        return { ...row, 依赖步骤: [...new Set([...dependencies, child])].join('、') }
      })
      const cyclicValidation = validatePipeline(cyclic)
      const cycleIssue = cyclicValidation.issues.find((item) => item.code === 'dependency-cycle')
      checks.push({
        key: 'cycle-rejected',
        name: '环路明确拒绝',
        condition: `给 ${parent} 补上依赖 ${child} 的回边后必须拒绝出计划`,
        passed: Boolean(cycleIssue) && !cyclicValidation.ok && planPipeline(cyclic, 'conflict-serial').plan === null,
        detail: cycleIssue
          ? cycleIssue.message
          : '构造回边后仍未识别为环路',
      })
    } else {
      checks.push({
        key: 'cycle-rejected',
        name: '环路明确拒绝',
        condition: '含回边的依赖图必须拒绝出计划',
        passed: false,
        detail: '当前没有依赖边，无法构造回边样例',
      })
    }

    const notReadyStep = validation.steps.find((step) => isEnabled(step) && step.dependsOn.length > 0)
    if (notReadyStep) {
      const blockedRows = rows.map((row) => {
        if (String(row['步骤编号']) !== notReadyStep.dependsOn[0]) {
          return row
        }
        return { ...row, status: PIPELINE_STATUS.disabled }
      })
      const blockedValidation = validatePipeline(blockedRows)
      const blockedIssue = blockedValidation.issues.find(
        (item) => item.code === 'dependency-not-ready',
      )
      checks.push({
        key: 'not-ready-blocked',
        name: '未就绪步骤不执行',
        condition: `停用 ${notReadyStep.dependsOn[0]} 后，下游 ${notReadyStep.stepNo} 不得进入就绪批次`,
        passed: Boolean(blockedIssue) && !blockedValidation.ok,
        detail: blockedIssue ? blockedIssue.message : '停用上游后下游仍被判为就绪',
      })
    }
  }

  return checks
}
