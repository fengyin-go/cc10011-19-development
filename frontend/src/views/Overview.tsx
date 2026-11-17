import { useCallback, useEffect, useState } from 'react'

import { loadOverview } from '@/api/local-service'
import { confirmedManifest, receivedManifest } from '@/api/orchestration-service'
import { POLICY_LABEL } from '@/domain/pipeline'
import type { Manifest, OverviewResult, ReceivedManifest } from '@/data/types'

export default function Overview() {
  const [cards, setCards] = useState<OverviewResult['cards']>([])
  const [moduleRows, setModuleRows] = useState<OverviewResult['modules']>([])
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [received, setReceived] = useState<ReceivedManifest | null>(null)

  const refresh = useCallback(() => {
    const payload = loadOverview()
    setCards(payload.cards)
    setModuleRows(payload.modules)
    setManifest(confirmedManifest())
    setReceived(receivedManifest())
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const waves = manifest?.batches ?? []
  const notReady = waves.flatMap((batch) =>
    batch.stepDetails
      .filter((step) => step.inputStatus !== '输入完整')
      .map((step) => ({ batchId: batch.batchId, step })),
  )

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h2>运营概览</h2>
          <p className="page-desc">汇总各业务模块的关键指标，先看总量再看异常；流水线就绪批次按波次排列。</p>
        </div>
        <div className="page-actions">
          <button className="btn" type="button" onClick={refresh}>重新统计</button>
        </div>
      </header>
      <div className="stat-row">
        {cards.map((card) => (
          <article key={card.label} className="stat-card">
            <span className="stat-label">{card.label}</span>
            <strong className="stat-value">{card.value}</strong>
          </article>
        ))}
      </div>

      <div className="section">
        <div className="section-head">
          <h3>流水线就绪批次概览</h3>
          <span className="hint">
            {manifest
              ? `清单 v${manifest.version} · ${POLICY_LABEL[manifest.policy]} · 落盘已接收 ${
                  received ? `v${received.version}` : '未接收'
                }`
              : '尚未发布流水线就绪批次清单'}
          </span>
        </div>
        {waves.length > 0 ? (
          <div className="wave-grid">
            {waves.map((batch) => {
              const isReceived = received
                ? received.batches.some((item) => item.batchId === batch.batchId)
                : false
              return (
                <article
                  key={batch.batchId}
                  className={`wave-card ${isReceived ? 'active' : ''}`}
                >
                  <div className="wave-title">
                    <span>
                      {batch.batchId} · 第 {batch.wave} 波
                    </span>
                    <span className={`badge ${isReceived ? 'ok' : 'info'}`}>
                      {isReceived ? '已下发落盘' : `${batch.stepCount} 步`}
                    </span>
                  </div>
                  <div className="meta" style={{ fontSize: 12, color: '#64748b' }}>
                    依赖：{batch.dependencies}
                  </div>
                  {batch.stepDetails.map((step) => (
                    <div key={step.stepNo} className="wave-step">
                      <div>
                        <span className="step-no">{step.stepNo}</span> {step.name}
                      </div>
                      <div className="meta">依赖：{step.dependencies}</div>
                      <div className="meta">
                        输出：{step.output} ·{' '}
                        <span className={`badge ${step.inputStatus === '输入完整' ? 'ok' : 'warn'}`}>
                          {step.inputStatus}
                        </span>
                      </div>
                    </div>
                  ))}
                </article>
              )
            })}
          </div>
        ) : (
          <p className="muted" style={{ fontSize: 13 }}>
            到「采集流水线」完成依赖校验并发布清单后，这里按波次展示就绪批次。
          </p>
        )}
        {notReady.length > 0 && (
          <div className="notice warn" style={{ marginTop: 10, marginBottom: 0 }}>
            有 {notReady.length} 个步骤输入未完整（
            {notReady.map((item) => `${item.batchId} ${item.step.stepNo}`).join('、')}
            ），不会执行，也不会在数据落盘预留目标路径。
          </div>
        )}
      </div>

      <table className="data-table">
        <thead>
          <tr><th>业务模块</th><th>今日新增</th><th>待处理</th><th>异常量</th></tr>
        </thead>
        <tbody>
          {moduleRows.map((row) => (
            <tr key={row.name}>
              <td>{row.name}</td>
              <td>{row.created}</td>
              <td>{row.pending}</td>
              <td>{row.abnormal}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <footer className="page-foot">
        <span>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据</span>
      </footer>
    </section>
  )
}
