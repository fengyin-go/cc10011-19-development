import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'scraper-strategy-studio:entries'
const ORCHESTRATION_KEY = 'scraper-strategy-studio:orchestration'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

// ---------------------------------------------------------------------------
// 编排产物（就绪批次清单、落盘文件、处理轨迹、复核记录）单独存一份，
// 与业务登记数据分开，重置某个模块时不会连带清掉已发布的清单。
// ---------------------------------------------------------------------------

export type OrchestrationDoc = {
  manifest: import('./types').Manifest | null
  manifests: import('./types').Manifest[]
  received: import('./types').ReceivedManifest | null
  files: import('./types').LandingFile[]
  trails: import('./types').LandingTrail[]
  reviews: import('./types').LandingReview[]
  /** 最近一次采集流水线处理失败的记录；失败时清单沿用上一份确认版本 */
  lastFailure: { at: string; day: string; message: string; version: number | null } | null
}

const EMPTY_DOC: OrchestrationDoc = {
  manifest: null,
  manifests: [],
  received: null,
  files: [],
  trails: [],
  reviews: [],
  lastFailure: null,
}

let docCache: OrchestrationDoc | null = null

export function orchestrationDoc(): OrchestrationDoc {
  if (docCache !== null) {
    return docCache
  }
  if (typeof window === 'undefined' || !window.localStorage) {
    docCache = clone(EMPTY_DOC)
    return docCache
  }
  const raw = window.localStorage.getItem(ORCHESTRATION_KEY)
  if (!raw) {
    docCache = clone(EMPTY_DOC)
    return docCache
  }
  try {
    docCache = { ...clone(EMPTY_DOC), ...(JSON.parse(raw) as Partial<OrchestrationDoc>) }
  } catch {
    docCache = clone(EMPTY_DOC)
  }
  return docCache
}

export function saveOrchestrationDoc(doc: OrchestrationDoc): void {
  docCache = doc
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(ORCHESTRATION_KEY, JSON.stringify(doc))
  }
}

export function resetOrchestration(): void {
  saveOrchestrationDoc(clone(EMPTY_DOC))
}

export function orchestrationStorageKey(): string {
  return ORCHESTRATION_KEY
}
