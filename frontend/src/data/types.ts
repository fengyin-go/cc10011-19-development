/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// ---------------------------------------------------------------------------
// 采集流水线就绪批次清单与数据落盘
// ---------------------------------------------------------------------------

import type {
  BatchPolicy,
  BatchStepView,
  BatchViewRow,
  ConflictBoundary,
  VerificationCheck,
  WriteMode,
} from '@/domain/pipeline'

/** 发布后冻结的清单快照：数据落盘只认这一份，不回头读正在编辑的步骤。 */
export type Manifest = {
  version: number
  policy: BatchPolicy
  status: '已确认' | '已替代' | '已作废'
  publishedAt: string
  confirmedAt: string
  note: string
  batches: BatchViewRow[]
  steps: BatchStepView[]
  /** 依赖图随清单一起发布，复核时不再回读正在编辑的步骤 */
  edges: { from: string; to: string }[]
  assignments: Record<string, number>
  writtenModes: Record<WriteMode, string>
  boundaries: ConflictBoundary[]
  checks: VerificationCheck[]
  warnings: string[]
}

export type LandingFile = {
  id: number
  version: number
  batchId: string
  wave: number
  stepNo: string
  output: string
  /** 只有批次被释放时才写入目标路径，未就绪步骤不预留 */
  path: string
  status: '待处理' | '已创建' | '已合并' | '失败' | '已跳过'
  fileVersion: string
  mergedFrom: string
  createdAt: string
  note: string
}

export type LandingTrail = {
  id: number
  at: string
  day: string
  action: string
  version: number | null
  policy: BatchPolicy | null
  writeMode: WriteMode
  outcome: '成功' | '失败' | '冲突' | '跳过'
  detail: string
}

export type LandingReview = {
  id: number
  at: string
  output: string
  version: number | null
  serialBoundary: string
  parallelBoundary: string
  decision: string
  basis: string
  landingRecord: string
}

export type ReceivedManifest = {
  version: number
  policy: BatchPolicy
  receivedAt: string
  batches: BatchViewRow[]
  steps: BatchStepView[]
  edges: { from: string; to: string }[]
  assignments: Record<string, number>
}
