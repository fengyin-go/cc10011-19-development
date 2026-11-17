import {
  describeConflictBoundaries,
  normalizeSteps,
  parseOutputs,
  planPipeline,
  PIPELINE_STATUS,
  POLICY_LABEL,
  runVerificationChecks,
  buildBatchView,
  topologicalOrder,
  validatePipeline,
  type BatchPolicy,
  type BatchStepView,
  type BatchViewRow,
  type CompiledPlan,
  type ConflictBoundary,
  type PipelineIssue,
  type PipelineStepRow,
  type VerificationCheck,
  type WriteMode,
} from '@/domain/pipeline'
import { listRows, orchestrationDoc, saveOrchestrationDoc, saveRows } from '@/data/local-store'
import type {
  LandingFile,
  LandingReview,
  LandingTrail,
  Manifest,
  ReceivedManifest,
} from '@/data/types'

/** 复核依据固定为冲突串行口径：并行合并只是候选路径，复核时必须回到串行边界。 */
export const REVIEW_BASIS: WriteMode = 'conflict-serial'
export const REVIEW_BASIS_LABEL = POLICY_LABEL['conflict-serial']

function now(): string {
  return new Date().toISOString()
}

export function dayKey(at: string = now()): string {
  const date = new Date(at)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function nextId(rows: { id: number }[]): number {
  return rows.reduce((max, row) => Math.max(max, row.id), 0) + 1
}

function pipelineRows(): Record<string, string | number | boolean>[] {
  return listRows('pipeline')
}

export type PlanDraft = {
  policy: BatchPolicy
  ok: boolean
  issues: PipelineIssue[]
  plan: CompiledPlan | null
  batches: BatchViewRow[]
  steps: BatchStepView[]
  boundaries: ConflictBoundary[]
  checks: VerificationCheck[]
  warnings: string[]
}

/**
 * 编排草稿：读取步骤的输入数据源、处理逻辑、输出目标与依赖步骤，校验后生成批次。
 * 校验不通过时 plan / batches 为空——页面拿到的是完整问题清单，而不是半张计划。
 */
export function planDraft(policy: BatchPolicy): PlanDraft {
  const rows = pipelineRows()
  const { validation, plan } = planPipeline(rows, policy)
  const steps = normalizeSteps(rows)
  const view = plan ? buildBatchView(plan, steps) : { batches: [], steps: [] }
  const boundaries = describeConflictBoundaries(rows)
  const checks = runVerificationChecks(rows)
  const warnings: string[] = []
  if (plan && policy === 'parallel-merge' && boundaries.length > 0) {
    warnings.push(
      `当前策略为${POLICY_LABEL['parallel-merge']}，${boundaries
        .map((item) => item.output)
        .join('、')} 存在多步同目标写入，文件版本只在末步合并后定型。`,
    )
  }
  if (!validation.ok) {
    warnings.push('依赖校验未通过，本次不会生成任何就绪批次。')
  }
  return {
    policy,
    ok: validation.ok && Boolean(plan),
    issues: validation.issues,
    plan,
    batches: view.batches,
    steps: view.steps,
    boundaries,
    checks,
    warnings,
  }
}

export type PublishResult = {
  ok: boolean
  message: string
  manifest: Manifest | null
  issues: PipelineIssue[]
}

/**
 * 发布流水线就绪批次清单：依赖图、步骤状态、就绪批次同一次写入，版本 +1。
 * 已有清单转为「已替代」，但数据落盘侧已接收的那份不自动跟随，需要显式同步。
 */
export function publishManifest(policy: BatchPolicy, note = ''): PublishResult {
  const draft = planDraft(policy)
  if (!draft.ok || !draft.plan) {
    return {
      ok: false,
      message: `依赖校验未通过，未生成流水线就绪批次清单（${draft.issues.length} 项问题）`,
      manifest: null,
      issues: draft.issues,
    }
  }
  const doc = orchestrationDoc()
  const version = doc.manifests.reduce((max, item) => Math.max(max, item.version), 0) + 1
  const at = now()
  const manifest: Manifest = {
    version,
    policy,
    status: '已确认',
    publishedAt: at,
    confirmedAt: at,
    note: note || `${POLICY_LABEL[policy]} · 第 ${version} 版`,
    batches: draft.batches,
    steps: draft.steps,
    edges: draft.plan.edges,
    assignments: draft.plan.assignments,
    writtenModes: { ...POLICY_LABEL },
    boundaries: draft.boundaries,
    checks: draft.checks,
    warnings: draft.warnings,
  }
  const manifests = doc.manifests.map((item) =>
    item.status === '已确认' ? { ...item, status: '已替代' as const } : item,
  )
  const trails: LandingTrail[] = [
    ...doc.trails,
    {
      id: nextId(doc.trails),
      at,
      day: dayKey(at),
      action: `发布流水线就绪批次清单 v${version}`,
      version,
      policy,
      writeMode: policy,
      outcome: '成功',
      detail: `${manifest.batches.length} 个波次 / ${manifest.steps.length} 个步骤 · ${POLICY_LABEL[policy]}`,
    },
  ]
  saveOrchestrationDoc({ ...doc, manifest, manifests: [...manifests, manifest], trails })
  return {
    ok: true,
    message: `已发布流水线就绪批次清单 v${version}：${manifest.batches.length} 个波次，${manifest.steps.length} 个步骤`,
    manifest,
    issues: [],
  }
}

export function confirmedManifest(): Manifest | null {
  const doc = orchestrationDoc()
  if (doc.manifest) {
    return doc.manifest
  }
  return [...doc.manifests].reverse().find((item) => item.status === '已确认') ?? null
}

export function latestManifest(): Manifest | null {
  const doc = orchestrationDoc()
  return [...doc.manifests].sort((a, b) => b.version - a.version)[0] ?? null
}

export function manifestHistory(): Manifest[] {
  return [...orchestrationDoc().manifests].sort((a, b) => b.version - a.version)
}

/**
 * 采集流水线处理失败：本次不再产出新清单，接着沿用上一份确认版本先完成落盘；
 * 失败本身按冲突串行口径记录，当天处理轨迹留存，供复核。
 */
export function recordPipelineFailure(message: string): { ok: boolean; message: string } {
  const manifest = confirmedManifest()
  const at = now()
  const doc = orchestrationDoc()
  const trail: LandingTrail = {
    id: nextId(doc.trails),
    at,
    day: dayKey(at),
    action: '采集流水线处理失败，沿用上一份确认版本',
    version: manifest?.version ?? null,
    policy: 'conflict-serial',
    writeMode: 'conflict-serial',
    outcome: '失败',
    detail: `${message} · ${manifest ? `清单 v${manifest.version} 继续生效` : '当前没有已确认清单'}`,
  }
  saveOrchestrationDoc({
    ...doc,
    lastFailure: { at, day: dayKey(at), message, version: manifest?.version ?? null },
    trails: [...doc.trails, trail],
  })
  return {
    ok: true,
    message: manifest
      ? `已记录失败，清单沿用上一份确认版本 v${manifest.version}；复核依据为${REVIEW_BASIS_LABEL}`
      : `已记录失败，但当前没有已确认清单可沿用`,
  }
}

export function lastFailure(): ReturnType<typeof orchestrationDoc>['lastFailure'] {
  return orchestrationDoc().lastFailure
}

/** 数据落盘接收清单后，待处理清单才与流水线同步。 */
export function receiveManifest(): { ok: boolean; message: string; received: ReceivedManifest | null } {
  const manifest = confirmedManifest()
  if (!manifest) {
    return { ok: false, message: '当前没有已确认的流水线就绪批次清单，无法接收', received: null }
  }
  const at = now()
  const received: ReceivedManifest = {
    version: manifest.version,
    policy: manifest.policy,
    receivedAt: at,
    batches: manifest.batches,
    steps: manifest.steps,
    edges: manifest.edges,
    assignments: manifest.assignments,
  }
  const doc = orchestrationDoc()
  saveOrchestrationDoc({
    ...doc,
    received,
    trails: [
      ...doc.trails,
      {
        id: nextId(doc.trails),
        at,
        day: dayKey(at),
        action: `数据落盘接收流水线就绪批次清单 v${manifest.version}`,
        version: manifest.version,
        policy: manifest.policy,
        writeMode: manifest.policy,
        outcome: '成功',
        detail: `${received.batches.length} 个波次进入待处理清单 · ${POLICY_LABEL[manifest.policy]}`,
      },
    ],
  })
  return { ok: true, message: `已接收流水线就绪批次清单 v${manifest.version}，待处理清单已同步`, received }
}

/**
 * 数据落盘刷新清单：沿当前数据流重新按冲突串行口径出版本，
 * 再让待处理清单接收新版本，确保刷新后的波次与文件版本可复核。
 */
export function refreshManifestSerial(): { ok: boolean; message: string } {
  const published = publishManifest(
    'conflict-serial',
    `数据落盘刷新：${POLICY_LABEL['conflict-serial']}`,
  )
  if (!published.ok) {
    return { ok: false, message: published.message }
  }
  const received = receiveManifest()
  return {
    ok: received.ok,
    message: `${published.message}；${received.message}`,
  }
}

export function receivedManifest(): ReceivedManifest | null {
  return orchestrationDoc().received
}

export function pendingManifestVersion(): {
  stale: boolean
  confirmed: number | null
  received: number | null
} {
  const confirmed = confirmedManifest()
  const received = receivedManifest()
  return {
    stale: Boolean(confirmed && (!received || received.version !== confirmed.version)),
    confirmed: confirmed?.version ?? null,
    received: received?.version ?? null,
  }
}

export type NextBatch = {
  batch: BatchViewRow | null
  files: LandingFile[]
  waiting: boolean
  reason: string
}

/**
 * 下一批要创建哪些输出文件：只读已接收的清单，只释放第一个未完成波次。
 * 未就绪步骤不会出现在这里，也不会预留任何目标路径。
 */
export function nextLandingBatch(): NextBatch {
  const received = receivedManifest()
  if (!received) {
    return { batch: null, files: [], waiting: true, reason: '尚未接收流水线就绪批次清单' }
  }
  const doc = orchestrationDoc()
  // 按波次顺序找第一个未完成的批次；在它之前的批次按定义都已完成，
  // 因此「上一个批次完成时才允许释放下游」在这里自然成立。
  for (const batch of received.batches) {
    const files = doc.files.filter(
      (file) => file.version === received.version && file.batchId === batch.batchId,
    )
    const done = batch.stepDetails.every((step) =>
      files.some(
        (file) =>
          file.stepNo === step.stepNo && (file.status === '已创建' || file.status === '已合并'),
      ),
    )
    if (!done) {
      return {
        batch,
        files: files.filter((file) => file.status === '待处理' || file.status === '失败'),
        waiting: false,
        reason: '',
      }
    }
  }
  return { batch: null, files: [], waiting: false, reason: '清单内全部批次已创建输出文件' }
}

export type LandResult = {
  ok: boolean
  message: string
  files: LandingFile[]
  conflicts: string[]
}

/**
 * 落盘下一批：按已接收清单创建输出文件。
 * - conflict-serial：同输出目标在更早波次写过，就不会出现在同一批里；
 * - parallel-merge：同波次多步写同一目标时并行写分片，末步合并成最终版本。
 * 上批未完成时直接拒绝，未就绪步骤不预留路径。
 */
export function landNextBatch(): LandResult {
  const received = receivedManifest()
  const next = nextLandingBatch()
  if (!received) {
    return { ok: false, message: next.reason, files: [], conflicts: [] }
  }
  if (next.waiting || !next.batch) {
    return {
      ok: next.reason === '清单内全部批次已创建输出文件',
      message: next.reason,
      files: [],
      conflicts: [],
    }
  }
  const doc = orchestrationDoc()
  const at = now()
  // 已接收清单里上游批次没有完成时，下游不释放、也不预留目标路径。
  const receivedBatchIds = received.batches.map((item) => item.batchId)
  const upstreamIncomplete = receivedBatchIds
    .slice(0, receivedBatchIds.indexOf(next.batch.batchId))
    .find((batchId) => {
      const previous = received.batches.find((item) => item.batchId === batchId)
      return (
        previous?.stepDetails.some(
          (step) =>
            !doc.files.some(
              (file) =>
                file.version === received.version &&
                file.stepNo === step.stepNo &&
                (file.status === '已创建' || file.status === '已合并'),
            ),
        ) ?? false
      )
    })
  if (upstreamIncomplete) {
    return {
      ok: false,
      message: `上一批次 ${upstreamIncomplete} 尚未完成，下游步骤不释放`,
      files: [],
      conflicts: [],
    }
  }
  const batch = next.batch
  const existing = doc.files.filter((file) => file.version === received.version)
  const created: LandingFile[] = []
  const conflicts: string[] = []
  const claimed = new Map<string, LandingFile>()

  for (const step of batch.stepDetails) {
    const outputs = parseOutputs({
      id: 0,
      status: step.status,
      pending: false,
      abnormal: false,
      stepNo: step.stepNo,
      name: step.name,
      input: step.input,
      logic: '',
      output: step.output,
      dependsOn: [],
      raw: {},
    })
    for (const output of outputs) {
      const previous = [...existing, ...created].find(
        (file) => file.output === output && (file.status === '已创建' || file.status === '已合并'),
      )
      if (previous && received.policy === 'conflict-serial') {
        conflicts.push(`${output} 已由 ${previous.stepNo} 在 W${String(previous.wave).padStart(2, '0')} 写入`)
      }
      const writer = claimed.get(output)
      if (writer && received.policy === 'parallel-merge') {
        writer.status = '已合并'
        writer.mergedFrom = [writer.stepNo, step.stepNo].join('、')
        writer.fileVersion = `${writer.stepNo}+${step.stepNo}·merge@W${String(batch.wave).padStart(2, '0')}`
        writer.note = `与 ${step.stepNo} 并行写入，末步 ${step.stepNo} 合并为最终版本`
        conflicts.push(`${output} 本波并行写入 ${writer.mergedFrom}，末步合并`)
        const mergeFile: LandingFile = {
          id: nextId([...doc.files, ...created]),
          version: received.version,
          batchId: batch.batchId,
          wave: batch.wave,
          stepNo: step.stepNo,
          output,
          path: writer.path,
          status: '已合并',
          fileVersion: writer.fileVersion,
          mergedFrom: writer.mergedFrom,
          createdAt: at,
          note: `并入最终版本，末步 ${step.stepNo} 落盘`,
        }
        created.push(mergeFile)
        continue
      }
      const file: LandingFile = {
        id: nextId([...doc.files, ...created]),
        version: received.version,
        batchId: batch.batchId,
        wave: batch.wave,
        stepNo: step.stepNo,
        output,
        path: `/landing/v${received.version}/${output}`,
        status: '已创建',
        fileVersion: `v${received.version}@W${String(batch.wave).padStart(2, '0')}`,
        mergedFrom: '',
        createdAt: at,
        note:
          received.policy === 'conflict-serial'
            ? `按输出目标冲突串行执行，${batch.batchId} 独占写入`
            : `允许并行并在末步合并文件，${batch.batchId} 并行写入`,
      }
      claimed.set(output, file)
      created.push(file)
    }
  }

  const trails: LandingTrail[] = [...doc.trails]
  if (conflicts.length > 0) {
    trails.push({
      id: nextId(trails),
      at,
      day: dayKey(at),
      action: `落盘批次 ${batch.batchId} 输出目标冲突`,
      version: received.version,
      policy: received.policy,
      writeMode: received.policy,
      outcome: '冲突',
      detail: conflicts.join('；'),
    })
  }
  trails.push({
    id: nextId(trails),
    at,
    day: dayKey(at),
    action: `落盘批次 ${batch.batchId}`,
    version: received.version,
    policy: received.policy,
    writeMode: received.policy,
    outcome: '成功',
    detail: `${created.length} 个输出文件 · ${POLICY_LABEL[received.policy]}`,
  })
  saveOrchestrationDoc({ ...doc, files: [...doc.files, ...created], trails })
  return {
    ok: true,
    message: `${batch.batchId} 已创建 ${created.length} 个输出文件`,
    files: created,
    conflicts,
  }
}

export function landingFiles(): LandingFile[] {
  return orchestrationDoc().files
}

export function landingTrails(day?: string): LandingTrail[] {
  const trails = orchestrationDoc().trails
  return [...trails]
    .filter((trail) => (day ? trail.day === day : true))
    .sort((a, b) => b.at.localeCompare(a.at))
}

export function landingDays(): string[] {
  return [...new Set(orchestrationDoc().trails.map((trail) => trail.day))].sort((a, b) => b.localeCompare(a))
}

export function landingReviews(): LandingReview[] {
  return [...orchestrationDoc().reviews].sort((a, b) => b.at.localeCompare(a.at))
}

/**
 * 冲突复核：比较清单在冲突串行口径下的另一套边界，判定落盘记录，
 * 把清单与落盘结果一起留作复核材料。
 */
export function recordConflictReview(output: string, decision: string): { ok: boolean; message: string } {
  const manifest = confirmedManifest()
  if (!manifest) {
    return { ok: false, message: '当前没有已确认的流水线就绪批次清单，无法复核' }
  }
  const rows = pipelineRows()
  const serialBoundary = describeConflictBoundaries(rows).find((item) => item.output === output)
  const manifestBoundary = manifest.boundaries.find((item) => item.output === output)
  const doc = orchestrationDoc()
  const at = now()
  const related = doc.files.filter((file) => file.output === output && file.version === manifest.version)
  const landingRecord =
    related.length === 0
      ? '尚无落盘记录'
      : related
          .map((file) => `${file.stepNo} ${file.batchId} ${file.status} ${file.fileVersion}`)
          .join('；')
  const boundary = serialBoundary ?? manifestBoundary
  const review: LandingReview = {
    id: nextId(doc.reviews),
    at,
    output,
    version: manifest.version,
    serialBoundary: boundary
      ? `${boundary.serialWrite}；${boundary.serialFileVersion}`
      : '当前登记下没有可比的串行边界',
    parallelBoundary: boundary
      ? `${boundary.parallelWrite}；${boundary.parallelFileVersion}`
      : '当前登记下没有可比的并行边界',
    decision: decision || '以冲突串行口径为准',
    basis: REVIEW_BASIS_LABEL,
    landingRecord,
  }
  saveOrchestrationDoc({
    ...doc,
    reviews: [...doc.reviews, review],
    trails: [
      ...doc.trails,
      {
        id: nextId(doc.trails),
        at,
        day: dayKey(at),
        action: `输出目标 ${output} 冲突复核`,
        version: manifest.version,
        policy: 'conflict-serial',
        writeMode: 'conflict-serial',
        outcome: '冲突',
        detail: `${review.decision} · 依据：${review.basis} · 落盘：${landingRecord}`,
      },
    ],
  })
  return { ok: true, message: `已记录 ${output} 的冲突复核，依据为${REVIEW_BASIS_LABEL}` }
}

// ---------------------------------------------------------------------------
// 查询入口：流水线步骤 / 步骤编号 → 就绪批次清单
// ---------------------------------------------------------------------------

export type StepTrace = {
  stepNo: string
  name: string
  status: string
  dependencies: string
  outputs: string
  manifests: {
    version: number
    policy: BatchPolicy
    status: string
    batchId: string
    wave: number
    inputStatus: string
    writeMode: WriteMode
  }[]
  landing: LandingFile[]
}

/** 保留步骤与步骤编号的查询入口：按步骤编号回查它进入过哪些批次、有没有落盘。 */
export function stepTraces(): StepTrace[] {
  const doc = orchestrationDoc()
  const steps = normalizeSteps(pipelineRows())
  return steps
    .filter((step) => step.stepNo)
    .map((step) => {
      const manifests: StepTrace['manifests'] = []
      for (const manifest of doc.manifests) {
        for (const entry of manifest.steps.filter((item) => item.stepNo === step.stepNo)) {
          manifests.push({
            version: manifest.version,
            policy: manifest.policy,
            status: manifest.status,
            batchId: entry.batchId,
            wave: parseInt(entry.batchId.replace('W', ''), 10) || 0,
            inputStatus: entry.inputStatus,
            writeMode: entry.writeMode,
          })
        }
      }
      return {
        stepNo: step.stepNo,
        name: step.name,
        status: step.status,
        dependencies: step.dependsOn.join('、') || '—',
        outputs: step.output || '—',
        manifests: manifests.sort((a, b) => b.version - a.version),
        landing: doc.files.filter((file) => file.stepNo === step.stepNo),
      }
    })
}

export type DependencyEdge = {
  from: string
  to: string
  released: boolean
}

/** 依赖图：按当前登记生成边，并标出下游是否已经进入就绪批次。 */
export function dependencyGraph(): {
  edges: DependencyEdge[]
  cycle: string[]
  order: string[]
  steps: PipelineStepRow[]
} {
  const steps = normalizeSteps(pipelineRows())
  const shaped = steps.filter((step) => step.stepNo)
  const { order, cycle } = topologicalOrder(shaped)
  const view = planPipeline(pipelineRows(), 'conflict-serial')
  const assigned = new Set(Object.keys(view.plan?.assignments ?? {}))
  return {
    edges: shaped.flatMap((step) =>
      step.dependsOn.map((parent) => ({
        from: parent,
        to: step.stepNo,
        released: assigned.has(step.stepNo) && assigned.has(parent),
      })),
    ),
    cycle,
    order,
    steps,
  }
}

/** 批次清单导出：按波次排列，列出步骤、依赖、输入状态与写入方式。 */
export function manifestCsv(manifest: Manifest): { filename: string; content: string } {
  const header = [
    '清单版本',
    '批次',
    '波次',
    '步骤编号',
    '步骤名称',
    '依赖步骤',
    '输入数据源',
    '输出目标',
    '输入状态',
    '写入方式',
  ]
  const lines = [header.join(',')]
  const rows = manifest.steps.length > 0 ? manifest.steps : []
  for (const step of rows) {
    lines.push(
      [
        manifest.version,
        step.batchId,
        parseInt(step.batchId.replace('W', ''), 10) || 0,
        step.stepNo,
        step.name,
        step.dependencies,
        step.input,
        step.output,
        step.inputStatus,
        POLICY_LABEL[step.writeMode],
      ].join(','),
    )
  }
  return {
    filename: `流水线就绪批次清单-v${manifest.version}.csv`,
    content: `﻿${lines.join('\n')}`,
  }
}

export function downloadManifest(manifest: Manifest): void {
  const { filename, content } = manifestCsv(manifest)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/**
 * 维护步骤的输入数据源、处理逻辑、输出目标与依赖步骤。
 * 这里只改字段，不做「状态流转」；改完由 planDraft 重新校验，问题会出现在校验清单里。
 */
export function updatePipelineStep(
  id: number,
  patch: { input?: string; logic?: string; output?: string; dependsOn?: string },
): { ok: boolean; message: string } {
  const rows = [...listRows('pipeline')]
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到记录 ${id}` }
  }
  const next = { ...rows[index] }
  if (patch.input !== undefined) {
    next['输入数据源'] = patch.input
  }
  if (patch.logic !== undefined) {
    next['处理逻辑'] = patch.logic
  }
  if (patch.output !== undefined) {
    next['输出目标'] = patch.output
  }
  if (patch.dependsOn !== undefined) {
    next['依赖步骤'] = patch.dependsOn
  }
  rows[index] = next
  saveRows('pipeline', rows)
  return { ok: true, message: `步骤 ${String(next['步骤编号'] ?? id)} 的编排字段已更新` }
}

export type ExcludedStep = {
  stepNo: string
  name: string
  status: string
  dependencies: string
  input: string
  output: string
  reason: string
}

/**
 * 未进入就绪批次的步骤及原因：停用、字段缺失、上游未启用、环路成员。
 * 这些步骤不会执行，也不会在数据落盘预留目标路径。
 */
export function excludedSteps(policy: BatchPolicy = 'conflict-serial'): ExcludedStep[] {
  const rows = pipelineRows()
  const validation = validatePipeline(rows)
  const { plan } = planPipeline(rows, policy)
  const assigned = new Set(Object.keys(plan?.assignments ?? {}))
  const issues = new Map<string, PipelineIssue[]>()
  for (const issue of validation.issues) {
    if (!issue.stepNo || issue.stepNo.includes(' → ')) {
      continue
    }
    const bucket = issues.get(issue.stepNo) ?? []
    bucket.push(issue)
    issues.set(issue.stepNo, bucket)
  }
  return validation.steps
    .filter((step) => step.stepNo && !assigned.has(step.stepNo))
    .map((step) => {
      const own = issues.get(step.stepNo) ?? []
      const reasons = own.map((issue) => issue.message)
      if (step.status !== PIPELINE_STATUS.enabled) {
        reasons.push(`当前状态「${step.status}」，未启用步骤不进入就绪批次`)
      }
      if (!plan && validation.issues.some((issue) => issue.code === 'dependency-cycle')) {
        reasons.push('整张计划因环路被拒绝，本步骤不执行')
      }
      return {
        stepNo: step.stepNo,
        name: step.name,
        status: step.status,
        dependencies: step.dependsOn.join('、') || '—',
        input: step.input || '—',
        output: step.output || '—',
        reason: reasons.join('；') || '未进入当前策略的就绪批次',
      }
    })
}
