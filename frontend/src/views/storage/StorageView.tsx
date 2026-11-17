import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  confirmedManifest,
  dayKey,
  landNextBatch,
  landingDays,
  landingFiles,
  landingReviews,
  landingTrails,
  lastFailure,
  latestManifest,
  nextLandingBatch,
  pendingManifestVersion,
  receiveManifest,
  recordConflictReview,
  recordPipelineFailure,
  refreshManifestSerial,
  receivedManifest,
  REVIEW_BASIS_LABEL,
} from '@/api/orchestration-service'
import { listEntries, moduleMeta, runAction as applyModuleAction } from '@/api/local-service'
import { POLICY_LABEL } from '@/domain/pipeline'
import type { EntryRow, LandingFile, LandingReview, LandingTrail, Manifest, ReceivedManifest } from '@/data/types'

const storageMeta = moduleMeta('storage')
const storageColumns = ['配置编号', '存储类型', '输出路径', '文件格式', '分区策略', '覆写模式']

const PENDING_STEP_STATUS = '待处理'

export default function StorageView() {
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [received, setReceived] = useState<ReceivedManifest | null>(null)
  const [sync, setSync] = useState<ReturnType<typeof pendingManifestVersion> | null>(null)
  const [files, setFiles] = useState<LandingFile[]>([])
  const [trails, setTrails] = useState<LandingTrail[]>([])
  const [reviews, setReviews] = useState<LandingReview[]>([])
  const [days, setDays] = useState<string[]>([])
  const [day, setDay] = useState(dayKey())
  const [message, setMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [reviewOutput, setReviewOutput] = useState('')
  const [reviewDecision, setReviewDecision] = useState('以冲突串行口径为准，串行版本按波次递增')
  const [failure, setFailure] = useState<ReturnType<typeof lastFailure>>(null)
  const [configs, setConfigs] = useState<EntryRow[]>([])

  const reload = useCallback(() => {
    setManifest(confirmedManifest())
    setReceived(receivedManifest())
    setSync(pendingManifestVersion())
    setFiles(landingFiles())
    setTrails(landingTrails())
    setReviews(landingReviews())
    setDays(landingDays())
    setFailure(lastFailure())
    setConfigs(listEntries(storageMeta.key).items)
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const next = useMemo(() => nextLandingBatch(), [files, received, manifest])
  const boundaries = manifest?.boundaries ?? []
  const reviewCandidates = boundaries.map((item) => item.output)
  const pendingSteps = useMemo(() => {
    if (!received) {
      return []
    }
    const created = new Set(
      files
        .filter((file) => file.version === received.version)
        .map((file) => `${file.batchId}|${file.stepNo}`),
    )
    return received.batches.flatMap((batch) =>
      batch.stepDetails
        .filter((step) => !created.has(`${batch.batchId}|${step.stepNo}`))
        .map((step) => ({ batchId: batch.batchId, step, reserved: false })),
    )
  }, [received, files])
  const dayTrails = trails.filter((trail) => trail.day === day)

  function runStorageAction(row: EntryRow, action: string) {
    run(() => applyModuleAction(storageMeta.key, Number(row.id), action))
  }

  function exportStorageConfigs() {
    const header = ['编号', ...storageMeta.fields, '当前状态']
    const lines = [header.join(',')]
    for (const row of configs) {
      lines.push([row.id, ...storageMeta.fields.map((field) => row[field] ?? ''), row.status].join(','))
    }
    const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${storageMeta.name}-清单.csv`
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
  }

  function run(action: () => { ok: boolean; message: string }) {
    setMessage('')
    setErrorMessage('')
    const result = action()
    if (!result.ok) {
      setErrorMessage(result.message)
    } else {
      setMessage(result.message)
    }
    reload()
  }

  return (
    <section className="page" data-module="storage">
      <header className="page-head">
        <div>
          <h2>数据落盘编排</h2>
          <p className="page-desc">
            读取流水线就绪批次清单决定下一批创建哪些输出文件；未就绪步骤不预留目标路径，
            输出目标冲突按串行执行，允许并行时在末步合并文件。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => run(receiveManifest)}>
            接收流水线就绪批次清单
          </button>
          <button className="btn" type="button" onClick={() => run(refreshManifestSerial)}>
            按冲突串行口径刷新清单
          </button>
        </div>
      </header>

      {message && <div className="notice ok">{message}</div>}
      {errorMessage && <div className="notice bad">{errorMessage}</div>}

      <div className="stat-row">
        <article className="stat-card">
          <span className="stat-label">已确认清单版本</span>
          <strong className="stat-value">{manifest ? `v${manifest.version}` : '未发布'}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">待处理清单接收版本</span>
          <strong className="stat-value">{received ? `v${received.version}` : '未接收'}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">下一批次</span>
          <strong className="stat-value">{next.batch?.batchId ?? (next.waiting ? '等待' : '—')}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">已创建输出文件</span>
          <strong className="stat-value">{files.length}</strong>
        </article>
      </div>

      {sync?.stale && (
        <div className="notice warn">
          待处理清单
          {sync.received ? `停留在 v${sync.received}` : '尚未接收'},
          已确认清单已到 v{sync.confirmed}。接收新版本后才会按新波次创建文件。
        </div>
      )}
      {failure && (
        <div className="notice bad">
          采集流水线处理失败（{new Date(failure.at).toLocaleString()}）：{failure.message}。
          清单沿用上一份确认版本{failure.version ? ` v${failure.version}` : ''}，落盘可继续按该版本完成，
          当天处理轨迹已留存，复核依据为{REVIEW_BASIS_LABEL}。
        </div>
      )}
      {!manifest && (
        <div className="notice warn">
          当前没有已确认的流水线就绪批次清单。先到「采集流水线」校验依赖并发布清单，数据落盘才能接收。
        </div>
      )}

      <div className="section">
        <div className="section-head">
          <h3>待处理清单 · 下一批输出文件</h3>
          <div className="section-row">
            <button
              className="btn primary"
              type="button"
              onClick={() => run(landNextBatch)}
              disabled={!received || next.waiting || !next.batch}
            >
              落盘下一批
            </button>
            <button
              className="btn ghost"
              type="button"
              onClick={() => run(() => recordPipelineFailure('值班复核前再次确认失败'))}
            >
              记录处理失败并沿用上一版
            </button>
          </div>
        </div>
        {!received ? (
          <p className="muted" style={{ fontSize: 13 }}>尚未接收清单，待处理清单为空。</p>
        ) : next.batch ? (
          <>
            <p style={{ fontSize: 13, marginTop: 0 }}>
              下一批：<strong>{next.batch.batchId}</strong>（第 {next.batch.wave} 波） ·
              写入方式：{POLICY_LABEL[next.batch.writeMode]} · 清单版本 v{received.version}
            </p>
            <table className="data-table">
              <thead>
                <tr>
                  <th>步骤编号</th>
                  <th>步骤名称</th>
                  <th>输出目标</th>
                  <th>依赖步骤</th>
                  <th>输入状态</th>
                  <th>目标路径</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {next.batch.stepDetails.map((step) => {
                  const file = files.find(
                    (item) => item.version === received.version && item.stepNo === step.stepNo,
                  )
                  return (
                    <tr key={`${next.batch?.batchId}-${step.stepNo}`}>
                      <td className="mono">{step.stepNo}</td>
                      <td>{step.name}</td>
                      <td className="mono">{step.output}</td>
                      <td className="mono">{step.dependencies}</td>
                      <td>
                        <span className="badge ok">{step.inputStatus}</span>
                      </td>
                      <td className="mono">{file ? file.path : '待释放，暂不预留路径'}</td>
                      <td>{file ? file.status : PENDING_STEP_STATUS}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </>
        ) : (
          <p className="muted" style={{ fontSize: 13 }}>{next.reason}</p>
        )}
      </div>


      <div className="section">
        <div className="section-head">
          <h3>存储配置登记</h3>
          <div className="section-row">
            <button
              className="btn"
              type="button"
              onClick={() => exportStorageConfigs()}
            >
              导出存储配置清单
            </button>
          </div>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                {storageColumns.map((column) => <th key={column}>{column}</th>)}
                <th>当前状态</th>
                <th>可执行动作</th>
              </tr>
            </thead>
            <tbody>
              {configs.map((row) => (
                <tr key={row.id}>
                  {storageColumns.map((column) => (
                    <td key={column} className={column === '输出路径' ? 'mono' : undefined}>
                      {row[column] ?? '—'}
                    </td>
                  ))}
                  <td>{row.status}</td>
                  <td className="row-actions">
                    {storageMeta.actions.map((action) => (
                      <button
                        key={action}
                        className="link"
                        type="button"
                        onClick={() => runStorageAction(row, action)}
                      >
                        {action}
                      </button>
                    ))}
                  </td>
                </tr>
              ))}
              {configs.length === 0 && (
                <tr>
                  <td className="empty-state" colSpan={storageColumns.length + 2}>暂无存储配置</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <h3>未就绪步骤 · 不预留目标路径</h3>
          <span className="hint">依赖未完成或尚未轮到波次的步骤只登记意图，不创建文件、不占用路径</span>
        </div>
        {pendingSteps.length > 0 ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>批次</th>
                <th>步骤编号</th>
                <th>步骤名称</th>
                <th>依赖步骤</th>
                <th>输出目标</th>
                <th>目标路径</th>
              </tr>
            </thead>
            <tbody>
              {pendingSteps.map((item) => (
                <tr key={`${item.batchId}-${item.step.stepNo}`}>
                  <td className="mono">{item.batchId}</td>
                  <td className="mono">{item.step.stepNo}</td>
                  <td>{item.step.name}</td>
                  <td className="mono">{item.step.dependencies}</td>
                  <td className="mono">{item.step.output}</td>
                  <td className="muted">未预留（等上一批次完成）</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted" style={{ fontSize: 13 }}>
            {received ? '当前清单没有未处理步骤。' : '接收清单后展示未就绪步骤。'}
          </p>
        )}
      </div>

      <div className="section">
        <div className="section-head">
          <h3>落盘记录</h3>
          <span className="hint">按输出目标冲突串行执行时，同一目标只会有一个写入者在当前波次</span>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>清单版本</th>
                <th>批次</th>
                <th>步骤编号</th>
                <th>输出目标</th>
                <th>写入路径</th>
                <th>文件版本</th>
                <th>状态</th>
                <th>合并来源</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {files.map((file) => (
                <tr key={file.id}>
                  <td className="mono">v{file.version}</td>
                  <td className="mono">{file.batchId}</td>
                  <td className="mono">{file.stepNo}</td>
                  <td className="mono">{file.output}</td>
                  <td className="mono">{file.path}</td>
                  <td className="mono">{file.fileVersion}</td>
                  <td>
                    <span className={`badge ${file.status === '已创建' || file.status === '已合并' ? 'ok' : 'warn'}`}>
                      {file.status}
                    </span>
                  </td>
                  <td className="mono">{file.mergedFrom || '—'}</td>
                  <td>{file.note}</td>
                </tr>
              ))}
              {files.length === 0 && (
                <tr>
                  <td className="empty-state" colSpan={9}>还没有创建任何输出文件</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <h3>冲突复核</h3>
          <span className="hint">
            复核依据为{REVIEW_BASIS_LABEL}：比较清单在串行口径下的另一套边界，判定落盘记录
          </span>
        </div>
        <div className="section-row" style={{ marginBottom: 8 }}>
          <select
            className="inline-select"
            value={reviewOutput}
            onChange={(event) => setReviewOutput(event.target.value)}
          >
            <option value="">选择输出目标</option>
            {reviewCandidates.map((output) => (
              <option key={output} value={output}>{output}</option>
            ))}
          </select>
          <input
            className="inline-input"
            style={{ minWidth: 320 }}
            value={reviewDecision}
            onChange={(event) => setReviewDecision(event.target.value)}
            placeholder="复核结论"
          />
          <button
            className="btn"
            type="button"
            disabled={!reviewOutput}
            onClick={() => run(() => recordConflictReview(reviewOutput, reviewDecision))}
          >
            记录复核
          </button>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>输出目标</th>
                <th>串行口径边界</th>
                <th>并行口径边界</th>
                <th>落盘记录</th>
                <th>结论</th>
                <th>复核依据</th>
              </tr>
            </thead>
            <tbody>
              {reviews.map((review) => (
                <tr key={review.id}>
                  <td className="nowrap">{new Date(review.at).toLocaleString()}</td>
                  <td className="mono">{review.output}</td>
                  <td>
                    {review.serialBoundary}
                    <br />
                    <span className="muted">清单 v{review.version ?? '—'}</span>
                  </td>
                  <td>{review.parallelBoundary}</td>
                  <td>{review.landingRecord}</td>
                  <td>{review.decision}</td>
                  <td>{review.basis}</td>
                </tr>
              ))}
              {reviews.length === 0 && (
                <tr>
                  <td className="empty-state" colSpan={7}>还没有冲突复核记录</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <h3>当天处理轨迹</h3>
          <div className="section-row">
            <select className="inline-select" value={day} onChange={(event) => setDay(event.target.value)}>
              {[...new Set([dayKey(), ...days])].map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>动作</th>
                <th>清单版本</th>
                <th>写入方式</th>
                <th>结果</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              {dayTrails.map((trail) => (
                <tr key={trail.id}>
                  <td className="nowrap">{new Date(trail.at).toLocaleTimeString()}</td>
                  <td>{trail.action}</td>
                  <td className="mono">{trail.version ? `v${trail.version}` : '—'}</td>
                  <td>{POLICY_LABEL[trail.writeMode]}</td>
                  <td>
                    <span
                      className={`badge ${
                        trail.outcome === '成功' ? 'ok' : trail.outcome === '失败' ? 'bad' : 'warn'
                      }`}
                    >
                      {trail.outcome}
                    </span>
                  </td>
                  <td>{trail.detail}</td>
                </tr>
              ))}
              {dayTrails.length === 0 && (
                <tr>
                  <td className="empty-state" colSpan={6}>当天没有处理轨迹</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {latestManifest() && received && latestManifest()?.version !== received.version && (
        <div className="notice warn">
          最新清单为 v{latestManifest()?.version}，待处理清单尚未接收；落盘仍按 v{received.version} 执行。
        </div>
      )}
    </section>
  )
}
