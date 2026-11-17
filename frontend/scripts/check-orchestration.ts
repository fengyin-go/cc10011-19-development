// 依赖编排内核的最小回归脚本：不依赖浏览器，直接用 Node 跑。
//   node --experimental-strip-types --experimental-loader ./scripts/ts-loader.mjs scripts/check-orchestration.ts
// 通过时逐项打印校验结论，失败时以非零码退出。
import assert from 'node:assert/strict'

import {
  buildBatchView,
  comparePolicies,
  describeConflictBoundaries,
  normalizeSteps,
  planPipeline,
  runVerificationChecks,
  validatePipeline,
} from '../src/domain/pipeline.ts'

const rows: Record<string, string | number | boolean>[] = [
  { id: 1, status: '已启用', '步骤编号': 'PIPE-0001', '输入数据源': '站点清单', '处理逻辑': '采集列表', '输出目标': 'raw/list.json', '依赖步骤': '' },
  { id: 2, status: '已启用', '步骤编号': 'PIPE-0002', '输入数据源': 'raw/list.json', '处理逻辑': '采集详情', '输出目标': 'raw/detail.json', '依赖步骤': 'PIPE-0001' },
  { id: 3, status: '已启用', '步骤编号': 'PIPE-0003', '输入数据源': 'raw/list.json', '处理逻辑': '补采详情', '输出目标': 'raw/detail.json', '依赖步骤': 'PIPE-0001' },
  { id: 4, status: '已启用', '步骤编号': 'PIPE-0004', '输入数据源': 'raw/detail.json', '处理逻辑': '详情清洗', '输出目标': 'clean/detail.parquet', '依赖步骤': 'PIPE-0002、PIPE-0003' },
  { id: 5, status: '已启用', '步骤编号': 'PIPE-0005', '输入数据源': 'raw/detail.json', '处理逻辑': '详情合并', '输出目标': 'clean/detail.parquet', '依赖步骤': 'PIPE-0002、PIPE-0003' },
  { id: 6, status: '已启用', '步骤编号': 'PIPE-0006', '输入数据源': 'clean/detail.parquet', '处理逻辑': '校验汇总', '输出目标': 'report/summary.json', '依赖步骤': 'PIPE-0004、PIPE-0005' },
]

const serial = planPipeline(rows, 'conflict-serial')
const parallel = planPipeline(rows, 'parallel-merge')
assert.ok(serial.plan && parallel.plan, '合法登记应能出计划')
assert.notEqual(serial.plan.waveCount, parallel.plan.waveCount, '两种策略的波次应当不同')

// 每一步都必须等全部依赖落在更早的波次
for (const step of serial.validation.runnable) {
  for (const parent of step.dependsOn) {
    assert.ok(
      serial.plan.assignments[parent] < serial.plan.assignments[step.stepNo],
      `${step.stepNo} 早于依赖 ${parent} 执行`,
    )
  }
}

// 重复扫描不会把同一步骤放进两个就绪批次
const appearances = new Map<string, number>()
for (const batch of serial.plan.batches) {
  for (const step of batch.steps) {
    appearances.set(step.stepNo, (appearances.get(step.stepNo) ?? 0) + 1)
  }
}
assert.equal(appearances.size, serial.validation.runnable.length)
for (const [stepNo, count] of appearances) {
  assert.equal(count, 1, `${stepNo} 出现在多个批次`)
}

// 环路必须被明确拒绝，且不返回半张计划
const cyclic = rows.map((row) =>
  row['步骤编号'] === 'PIPE-0001' ? { ...row, '依赖步骤': 'PIPE-0006' } : row,
)
assert.equal(validatePipeline(cyclic).ok, false)
assert.ok(validatePipeline(cyclic).issues.some((issue) => issue.code === 'dependency-cycle'))
assert.equal(planPipeline(cyclic, 'conflict-serial').plan, null)

// 缺失输入不生成计划
const missing = rows.map((row) =>
  row['步骤编号'] === 'PIPE-0002' ? { ...row, '输入数据源': '' } : row,
)
assert.equal(planPipeline(missing, 'conflict-serial').plan, null)
assert.ok(validatePipeline(missing).issues.some((issue) => issue.code === 'missing-field'))

// 上游未启用时下游不进入就绪批次
const disabled = rows.map((row) =>
  row['步骤编号'] === 'PIPE-0002' ? { ...row, status: '已停用' } : row,
)
const disabledPlan = planPipeline(disabled, 'conflict-serial')
assert.equal(disabledPlan.plan, null)
assert.ok(disabledPlan.validation.issues.some((issue) => issue.code === 'dependency-not-ready'))
// PIPE-0004 依赖 PIPE-0002，上游停用后它不进入任何就绪批次
assert.ok(
  disabledPlan.validation.issues.some(
    (issue) => issue.code === 'dependency-not-ready' && issue.stepNo === 'PIPE-0004',
  ),
)

// 冲突边界：串行两个版本，并行一个版本
const boundaries = describeConflictBoundaries(rows)
assert.equal(boundaries.length, 2)
assert.equal(boundaries[0].stepNos.length, 2)

// 页面上的核对条件全部通过
for (const check of runVerificationChecks(rows)) {
  assert.ok(check.passed, `${check.name} 未通过：${check.detail}`)
}

// 批次视图按波次排列，并带依赖与输入状态
const view = buildBatchView(serial.plan, normalizeSteps(rows))
assert.equal(view.batches.length, serial.plan.waveCount)
assert.ok(view.steps.every((step) => step.inputStatus === '输入完整'))
assert.ok(view.batches.every((batch, index) => batch.wave === index + 1))

const comparison = comparePolicies(rows)
assert.ok(comparison['conflict-serial'].plan && comparison['parallel-merge'].plan)

console.log(`依赖编排校验通过：${serial.plan.waveCount} 个串行波次 / ${parallel.plan.waveCount} 个并行波次`)
for (const check of runVerificationChecks(rows)) {
  console.log(`  [通过] ${check.name}：${check.detail}`)
}
