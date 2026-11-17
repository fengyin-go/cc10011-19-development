import { useCallback, useEffect, useMemo, useState } from 'react'

import { moduleMeta, runAction as applyModuleAction } from '@/api/local-service'
import {
  dependencyGraph,
  downloadManifest,
  excludedSteps,
  manifestHistory,
  pendingManifestVersion,
  planDraft,
  publishManifest,
  recordPipelineFailure,
  stepTraces,
  landingReviews,
  updatePipelineStep,
  type PlanDraft,
} from '@/api/orchestration-service'
import { POLICY_LABEL, type BatchPolicy } from '@/domain/pipeline'
import type { Manifest } from '@/data/types'

const ISSUE_LABEL: Record<string, string> = {
  'empty-pipeline': '无步骤',
  'missing-step-no': '缺步骤编号',
  'duplicate-step-no': '编号重复',
  'missing-field': '字段缺失',
  'unknown-dependency': '依赖不存在',
  'self-dependency': '自依赖',
  'dependency-cycle': '依赖环路',
  'dependency-not-ready': '上游未启用',
  'no-runnable-steps': '无可用步骤',
}

const pipelineMeta = moduleMeta('pipeline')

export default function PipelineView() {
  const [policy, setPolicy] = useState<BatchPolicy>('conflict-serial')
  const [draft, setDraft] = useState<PlanDraft | null>(null)
  const [history, setHistory] = useState<Manifest[]>([])
  const [message, setMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [stale, setStale] = useState<ReturnType<typeof pendingManifestVersion> | null>(null)
  const [traceNo, setTraceNo] = useState('')
  const [editing, setEditing] = useState<Record<number, { input: string; logic: string; output: string; dependsOn: string }>>({})

  const reload = useCallback(() => {
    setDraft(planDraft(policy))
    setHistory(manifestHistory())
    setStale(pendingManifestVersion())
  }, [policy])

  useEffect(() => {
    reload()
  }, [reload])

  const graph = useMemo(() => dependencyGraph(), [draft])
  const traces = useMemo(() => stepTraces(), [draft, history])
  const excluded = useMemo(() => excludedSteps(policy), [draft, policy])
  const reviews = useMemo(
    () => landingReviews().filter((review) => review.version === current?.version),
    [draft, history],
  )
  const current = history.find((item) => item.status === '已确认') ?? null
  const filteredTraces = traceNo.trim()
    ? traces.filter(
        (trace) =>
          trace.stepNo.includes(traceNo.trim()) ||
          (trace.name ?? '').includes(traceNo.trim()),
      )
    : traces

  function handlePublish() {
    setMessage('')
    setErrorMessage('')
    const result = publishManifest(policy)
    if (!result.ok) {
      setErrorMessage(result.message)
      reload()
      return
    }
    setMessage(result.message)
    reload()
  }

  function editValues(row: ReturnType<typeof dependencyGraph>['steps'][number]) {
    return (
      editing[row.id] ?? {
        input: row.input,
        logic: row.logic,
        output: row.output,
        dependsOn: row.dependsOn.join('、'),
      }
    )
  }

  function patchEditing(id: number, key: 'input' | 'logic' | 'output' | 'dependsOn', value: string) {
    const row = graph.steps.find((item) => item.id === id)
    if (!row) {
      return
    }
    setEditing((prev) => ({ ...prev, [id]: { ...editValues(row), [key]: value } }))
  }

  function saveStep(id: number) {
    setMessage('')
    setErrorMessage('')
    const values = editing[id]
    if (!values) {
      return
    }
    const result = updatePipelineStep(id, values)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    setEditing((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    setMessage(result.message)
    reload()
  }

  function runStatusAction(row: ReturnType<typeof dependencyGraph>['steps'][number], action: string) {
    setMessage('')
    setErrorMessage('')
    const result = applyModuleAction(pipelineMeta.key, row.id, action)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    setMessage(result.message)
    reload()
  }

  function handleFailure() {
    setMessage('')
    setErrorMessage('')
    const result = recordPipelineFailure('采集流水线本轮处理未产出可用结果')
    setMessage(result.message)
    reload()
  }

  const hasCycle = draft?.issues.some((issue) => issue.code === 'dependency-cycle') ?? false

  return (
    <section className="page" data-module="pipeline">
      <header className="page-head">
        <div>
          <h2>采集流水线编排</h2>
          <p className="page-desc">
            读取流水线步骤的输入数据源、处理逻辑、输出目标与依赖步骤，校验依赖后编排执行波次，
            发布流水线就绪批次清单；每步只在输入完整时进入批次。
          </p>
          <p className="page-desc">
            流水线负责人：值班管理员 · 可查看依赖、就绪步骤与数据落盘回传的冲突核查结局。
          </p>
        </div>
        <div className="page-actions">
          <button
            className="btn primary"
            type="button"
            onClick={handlePublish}
            disabled={!draft?.ok}
            title={draft?.ok ? '' : '依赖校验未通过，不能发布'}
          >
            发布就绪批次清单
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => current && downloadManifest(current)}
            disabled={!current}
          >
            导出批次清单
          </button>
        </div>
      </header>

      {message && <div className="notice ok">{message}</div>}
      {errorMessage && <div className="notice bad">{errorMessage}</div>}
      {stale?.stale && (
        <div className="notice warn">
          已确认清单为 v{stale.confirmed}，数据落盘侧
          {stale.received ? `仍停留在 v${stale.received}` : '尚未接收任何版本'}；
          落盘需要先接收新版本才会按新波次创建文件。
        </div>
      )}
      {draft && !draft.ok && (
        <div className="notice bad">
          依赖校验未通过（{draft.issues.length} 项），本次不会生成任何就绪批次，也不会有半张执行计划。
        </div>
      )}

      <div className="stat-row">
        <article className="stat-card">
          <span className="stat-label">流水线步骤总数</span>
          <strong className="stat-value">{graph.steps.length}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">可编排步骤（已启用）</span>
          <strong className="stat-value">
            {draft?.plan ? Object.keys(draft.plan.assignments).length : 0}
          </strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">就绪批次（波次）</span>
          <strong className="stat-value">{draft?.plan?.waveCount ?? 0}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">当前清单版本</span>
          <strong className="stat-value">{current ? `v${current.version}` : '未发布'}</strong>
        </article>
      </div>

      <div className="section">
        <div className="section-head">
          <h3>编排策略</h3>
          <span className="hint">
            两类步骤输出目标重合、依赖又允许并行时，两种策略会得到不同的执行波次和文件版本。
          </span>
        </div>
        <div className="section-row">
          {(['conflict-serial', 'parallel-merge'] as BatchPolicy[]).map((item) => (
            <label key={item} className="filter-item" style={{ margin: 0 }}>
              <span>
                <input
                  type="radio"
                  name="policy"
                  checked={policy === item}
                  onChange={() => setPolicy(item)}
                />{' '}
                {POLICY_LABEL[item]}
              </span>
            </label>
          ))}
          {current && (
            <span className="badge info">
              当前生效：v{current.version} · {POLICY_LABEL[current.policy]}
            </span>
          )}
          {hasCycle && <span className="badge bad">检测到依赖环路，已拒绝出计划</span>}
        </div>
        {draft?.warnings.map((warning) => (
          <div key={warning} className="notice warn" style={{ marginTop: 10, marginBottom: 0 }}>
            {warning}
          </div>
        ))}
      </div>

      <div className="section">
        <div className="section-head">
          <h3>批次视图（概览按波次排列）</h3>
          <span className="hint">
            {draft?.plan
              ? `${draft.plan.waveCount} 个就绪批次 · ${draft.steps.length} 个步骤 · ${POLICY_LABEL[policy]}`
              : '校验通过后展示就绪批次'}
          </span>
        </div>
        {draft && draft.batches.length > 0 ? (
          <div className="wave-grid">
            {draft.batches.map((batch) => (
              <article key={batch.batchId} className="wave-card">
                <div className="wave-title">
                  <span>
                    {batch.batchId} · 第 {batch.wave} 波
                  </span>
                  <span className="badge info">{batch.stepCount} 步</span>
                </div>
                <div className="meta" style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>
                  依赖：{batch.dependencies}
                  <br />
                  写入：{POLICY_LABEL[batch.writeMode]}
                </div>
                {batch.stepDetails.map((step) => (
                  <div key={step.stepNo} className="wave-step">
                    <div>
                      <span className="step-no">{step.stepNo}</span> {step.name}
                    </div>
                    <div className="meta">输入：{step.input}</div>
                    <div className="meta">输出：{step.output}</div>
                    <div className="meta">依赖：{step.dependencies}</div>
                    <div style={{ marginTop: 4 }}>
                      <span className={`badge ${step.inputStatus === '输入完整' ? 'ok' : 'warn'}`}>
                        {step.inputStatus}
                      </span>{' '}
                      <span className="badge">{step.status}</span>
                    </div>
                  </div>
                ))}
                {batch.serialized !== '—' && (
                  <div className="meta" style={{ marginTop: 6 }}>
                    冲突后移：{batch.serialized}
                  </div>
                )}
                {batch.conflicts !== '—' && (
                  <div className="meta" style={{ marginTop: 4 }}>
                    冲突：{batch.conflicts}
                  </div>
                )}
              </article>
            ))}
          </div>
        ) : (
          <p className="muted" style={{ fontSize: 13 }}>
            暂无就绪批次。{draft && !draft.ok ? '先按下方问题清单修复依赖与字段。' : ''}
          </p>
        )}
      </div>

      {excluded.length > 0 && (
        <div className="section">
          <div className="section-head">
            <h3>未进入就绪批次的步骤</h3>
            <span className="hint">依赖未就绪或未启用的步骤不会执行，也不在数据落盘预留目标路径</span>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>步骤编号</th>
                <th>步骤名称</th>
                <th>状态</th>
                <th>依赖步骤</th>
                <th>输入数据源</th>
                <th>输出目标</th>
                <th>未入批原因</th>
              </tr>
            </thead>
            <tbody>
              {excluded.map((step) => (
                <tr key={step.stepNo}>
                  <td className="mono">{step.stepNo}</td>
                  <td>{step.name || '—'}</td>
                  <td>{step.status}</td>
                  <td className="mono">{step.dependencies}</td>
                  <td>{step.input}</td>
                  <td className="mono">{step.output}</td>
                  <td>{step.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {draft && draft.issues.length > 0 && (
        <div className="section">
          <div className="section-head">
            <h3>依赖校验问题清单</h3>
            <span className="hint">问题未清零前不生成执行计划</span>
          </div>
          <ul className="issue-list">
            {draft.issues.map((issue, index) => (
              <li key={`${issue.code}-${issue.stepNo}-${index}`}>
                <span className="badge bad">{ISSUE_LABEL[issue.code] ?? issue.code}</span>{' '}
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="section">
        <div className="section-head">
          <h3>依赖图与释放状态</h3>
          <span className="hint">拓扑顺序：{graph.order.join(' → ') || '—'}</span>
        </div>
        {graph.edges.length > 0 ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>前置步骤</th>
                <th>后继步骤</th>
                <th>依赖状态</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {graph.edges.map((edge) => (
                <tr key={`${edge.from}-${edge.to}`}>
                  <td className="mono">{edge.from}</td>
                  <td className="mono">{edge.to}</td>
                  <td>
                    <span className={`badge ${edge.released ? 'ok' : 'warn'}`}>
                      {edge.released ? '已编排' : '未编排'}
                    </span>
                  </td>
                  <td>{edge.released ? '上游完成本波后释放下游' : '上游未进入就绪批次，下游不释放'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted" style={{ fontSize: 13 }}>当前没有依赖边。</p>
        )}
        {graph.cycle.length > 0 && (
          <div className="notice bad" style={{ marginTop: 10, marginBottom: 0 }}>
            环路步骤：{graph.cycle.join(' → ')}，整张计划拒绝生成，不做部分执行。
          </div>
        )}
      </div>

      <div className="section">
        <div className="section-head">
          <h3>核对条件（可回查）</h3>
          <span className="hint">依赖未就绪步骤不会执行 · 环路会被明确拒绝 · 重复扫描不重复入批</span>
        </div>
        <div className="check-list">
          {(draft?.checks ?? []).map((check) => (
            <article key={check.key} className="check-card">
              <div className="check-title">
                <span>{check.name}</span>
                <span className={`badge ${check.passed ? 'ok' : 'bad'}`}>
                  {check.passed ? '通过' : '未通过'}
                </span>
              </div>
              <div className="check-detail">条件：{check.condition}</div>
              <div className="check-detail">结果：{check.detail}</div>
            </article>
          ))}
          {(draft?.checks ?? []).length === 0 && (
            <p className="muted" style={{ fontSize: 13 }}>暂无可核对的依赖图。</p>
          )}
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <h3>冲突边界比对</h3>
          <span className="hint">同一份登记，两种写入方式得到的波次与文件版本不同</span>
        </div>
        {(draft?.boundaries ?? []).length > 0 ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>输出目标</th>
                  <th>冲突步骤</th>
                  <th>按输出目标冲突串行执行</th>
                  <th>允许并行并在末步合并文件</th>
                </tr>
              </thead>
              <tbody>
                {(draft?.boundaries ?? []).map((item) => (
                  <tr key={item.output}>
                    <td className="mono">{item.output}</td>
                    <td className="mono">{item.stepNos.join('、')}</td>
                    <td>
                      {item.serialWrite}
                      <br />
                      <span className="muted">{item.serialFileVersion}</span>
                    </td>
                    <td>
                      {item.parallelWrite}
                      <br />
                      <span className="muted">{item.parallelFileVersion}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted" style={{ fontSize: 13 }}>当前登记没有输出目标冲突。</p>
        )}
      </div>

      <div className="section">
        <div className="section-head">
          <h3>流水线步骤与步骤编号查询入口</h3>
          <span className="hint">按步骤编号回查进入过的批次与落盘文件</span>
        </div>
        <div className="section-row" style={{ marginBottom: 8 }}>
          <input
            className="inline-input"
            value={traceNo}
            placeholder="输入步骤编号或步骤名称"
            onChange={(event) => setTraceNo(event.target.value)}
          />
          <button className="btn ghost" type="button" onClick={() => setTraceNo('')}>
            重置
          </button>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>步骤编号</th>
                <th>步骤名称</th>
                <th>状态</th>
                <th>依赖步骤</th>
                <th>输出目标</th>
                <th>进入批次</th>
                <th>落盘文件</th>
              </tr>
            </thead>
            <tbody>
              {filteredTraces.map((trace) => (
                <tr key={trace.stepNo}>
                  <td className="mono">{trace.stepNo}</td>
                  <td>{trace.name || '—'}</td>
                  <td>{trace.status}</td>
                  <td className="mono">{trace.dependencies}</td>
                  <td className="mono">{trace.outputs}</td>
                  <td>
                    {trace.manifests.length === 0
                      ? '—'
                      : trace.manifests
                          .map(
                            (item) =>
                              `v${item.version} ${item.batchId}${item.status === '已确认' ? '' : `（${item.status}）`}`,
                          )
                          .join('；')}
                  </td>
                  <td>
                    {trace.landing.length === 0
                      ? '—'
                      : trace.landing
                          .map((file) => `${file.status} ${file.fileVersion}`)
                          .join('；')}
                  </td>
                </tr>
              ))}
              {filteredTraces.length === 0 && (
                <tr>
                  <td className="empty-state" colSpan={7}>没有匹配的步骤编号</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <h3>冲突核查结局回查</h3>
          <span className="hint">
            数据落盘按串行口径复核后回传的结论；没有回传时以当前清单的冲突边界为准
          </span>
        </div>
        {reviews.length > 0 ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>复核时间</th>
                <th>输出目标</th>
                <th>串行边界</th>
                <th>并行边界</th>
                <th>落盘记录</th>
                <th>结论</th>
                <th>依据</th>
              </tr>
            </thead>
            <tbody>
              {reviews.map((review) => (
                <tr key={review.id}>
                  <td className="nowrap">{new Date(review.at).toLocaleString()}</td>
                  <td className="mono">{review.output}</td>
                  <td>{review.serialBoundary}</td>
                  <td>{review.parallelBoundary}</td>
                  <td>{review.landingRecord}</td>
                  <td>{review.decision}</td>
                  <td>{review.basis}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted" style={{ fontSize: 13 }}>
            清单 v{current?.version ?? '—'} 还没有数据落盘回传的冲突复核记录。
          </p>
        )}
      </div>

      <div className="section">
        <div className="section-head">
          <h3>步骤依赖维护</h3>
          <span className="hint">
            当前登记：{graph.steps.length} 条；任一步骤的输入、处理逻辑、输出目标或依赖步骤改动后，
            上方校验与批次会立即重算。
          </span>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>步骤编号</th>
                <th>输入数据源</th>
                <th>处理逻辑</th>
                <th>输出目标</th>
                <th>依赖步骤</th>
                <th>状态</th>
                <th>状态动作</th>
                <th>保存编排</th>
              </tr>
            </thead>
            <tbody>
              {graph.steps.map((row) => {
                const values = editValues(row)
                return (
                  <tr key={row.id}>
                    <td className="mono nowrap">{row.stepNo || `记录 ${row.id}`}</td>
                    <td>
                      <input
                        className="inline-input"
                        value={values.input}
                        onChange={(event) => patchEditing(row.id, 'input', event.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        className="inline-input"
                        value={values.logic}
                        onChange={(event) => patchEditing(row.id, 'logic', event.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        className="inline-input"
                        value={values.output}
                        onChange={(event) => patchEditing(row.id, 'output', event.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        className="inline-input"
                        value={values.dependsOn}
                        placeholder="如 PIPE-0001、PIPE-0002"
                        onChange={(event) => patchEditing(row.id, 'dependsOn', event.target.value)}
                      />
                    </td>
                    <td>{row.status}</td>
                    <td className="row-actions nowrap">
                      {pipelineMeta.actions.map((action) => (
                        <button
                          key={action}
                          className="link"
                          type="button"
                          onClick={() => runStatusAction(row, action)}
                        >
                          {action}
                        </button>
                      ))}
                    </td>
                    <td>
                      <button
                        className="link"
                        type="button"
                        disabled={!editing[row.id]}
                        onClick={() => saveStep(row.id)}
                      >
                        保存
                      </button>
                    </td>
                  </tr>
                )
              })}
              {graph.steps.length === 0 && (
                <tr>
                  <td className="empty-state" colSpan={8}>暂无采集流水线步骤</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <h3>清单版本</h3>
          <div className="section-row">
            <button className="btn" type="button" onClick={handleFailure}>
              记录采集流水线处理失败
            </button>
          </div>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>版本</th>
                <th>策略</th>
                <th>状态</th>
                <th>波次</th>
                <th>步骤数</th>
                <th>发布时间</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {history.map((item) => (
                <tr key={item.version}>
                  <td className="mono">v{item.version}</td>
                  <td>{POLICY_LABEL[item.policy]}</td>
                  <td>
                    <span className={`badge ${item.status === '已确认' ? 'ok' : 'warn'}`}>
                      {item.status}
                    </span>
                  </td>
                  <td>{item.batches.length}</td>
                  <td>{item.steps.length}</td>
                  <td className="nowrap">{new Date(item.publishedAt).toLocaleString()}</td>
                  <td>{item.note}</td>
                </tr>
              ))}
              {history.length === 0 && (
                <tr>
                  <td className="empty-state" colSpan={7}>尚未发布流水线就绪批次清单</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}
