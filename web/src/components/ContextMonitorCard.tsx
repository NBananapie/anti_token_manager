import React, { useState, useEffect } from 'react';
import { Gauge, ArrowUpRight, Layers, ShieldCheck, AlertTriangle } from 'lucide-react';
import {
  ActiveSessionSnapshot,
  ContextLimitConfig,
  formatCompactTokens,
  formatRelativeTime,
  formatUsd,
  getContextHealthClass,
  getModelColor,
  maskSessionTitle,
  splitModelTier
} from '../types';

interface Props {
  activeSessions: ActiveSessionSnapshot[];
  contextConfig?: ContextLimitConfig;
  privacyMode?: boolean;
  onOpenSession: (id: string) => void;
}

export default function ContextMonitorCard({
  activeSessions,
  contextConfig,
  privacyMode = false,
  onOpenSession
}: Props) {
  const [selectedId, setSelectedId] = useState<string>('');

  useEffect(() => {
    if (activeSessions.length === 0) return;
    if (!selectedId || !activeSessions.some((s) => s.conversation_id === selectedId)) {
      setSelectedId(activeSessions[0].conversation_id);
    }
  }, [activeSessions, selectedId]);

  const current =
    activeSessions.find((s) => s.conversation_id === selectedId) || activeSessions[0] || null;
  const limit = contextConfig?.effectiveLimit || 256000;
  const used = current?.currentContextTokens || 0;
  const remaining = Math.max(0, limit - used);
  const usedPct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const health = getContextHealthClass(usedPct);

  const inputPart = current ? Math.min(used, current.lastInputTokens || 0) : 0;
  const cachePart = current ? Math.max(0, used - inputPart) : 0;
  const cachePctOfLimit = limit > 0 ? Math.min(100, (cachePart / limit) * 100) : 0;
  const inputPctOfLimit = limit > 0 ? Math.min(100 - cachePctOfLimit, (inputPart / limit) * 100) : 0;
  const currentModelParts = current ? splitModelTier(current.latestModel) : null;

  return (
    <section className="panel-card context-monitor-card" aria-label="实时上下文监控">
      <div className="panel-header" style={{ marginBottom: 12 }}>
        <div className="panel-title-wrap">
          <h2 className="panel-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Gauge size={15} />
            实时上下文监控
          </h2>
        </div>

        <div
          className={`limit-pill ${contextConfig?.cloudOverrideBypassed ? 'bypassed' : ''}`}
          title={
            contextConfig?.detected
              ? `实测 language_server 上限: ${contextConfig.effectiveLimit.toLocaleString()} tokens (${contextConfig.cloudOverrideBypassed ? '云端 Mendel 覆盖已绕过' : '云端默认模式'})`
              : '未检测到本地 language_server 二进制，采用默认 256K 基线'
          }
        >
          {contextConfig?.cloudOverrideBypassed ? (
            <ShieldCheck size={12} />
          ) : (
            <AlertTriangle size={12} />
          )}
          <span>上限 {contextConfig?.label || '256K'}</span>
        </div>
      </div>

      {!current ? (
        <div className="empty-cell" style={{ padding: '28px 0' }}>
          暂无活跃主会话数据
        </div>
      ) : (
        <div className="ctx-body">
          {/* Active Session Selector */}
          <div className="ctx-selector-row">
            <label htmlFor="live-context-session" className="sr-only">
              选择监控会话
            </label>
            <select
              id="live-context-session"
              name="liveSession"
              className="ctx-select"
              value={current.conversation_id}
              onChange={(e) => setSelectedId(e.target.value)}
            >
              {activeSessions.map((s, idx) => {
                const pct = limit > 0 ? Math.round((s.currentContextTokens / limit) * 100) : 0;
                const displayTitle = privacyMode
                  ? maskSessionTitle(s.conversation_id, 'main')
                  : s.title.length > 30
                    ? `${s.title.slice(0, 30)}...`
                    : s.title;
                return (
                  <option key={s.conversation_id} value={s.conversation_id}>
                    {idx === 0 ? '最新 · ' : ''}
                    {displayTitle}（{pct}% · {formatRelativeTime(s.last_modified_time)}）
                  </option>
                );
              })}
            </select>

            <button
              type="button"
              className="btn-ghost ctx-open-btn"
              onClick={() => onOpenSession(current.conversation_id)}
              title="打开该会话的上下文波形与压缩详情页"
            >
              <span>波形详情</span>
              <ArrowUpRight size={13} />
            </button>
          </div>

          {/* Primary Context Numbers */}
          <div className="ctx-numbers-row">
            <div>
              <div className="ctx-micro-label">当前已用上下文</div>
              <div className="ctx-big-num">
                <span className={`ctx-val ${health}`} title={`${used.toLocaleString()} tokens`}>
                  {formatCompactTokens(used)}
                </span>
                <span className="ctx-denom">/ {formatCompactTokens(limit)}</span>
              </div>
            </div>

            <div style={{ textAlign: 'right' }}>
              <div className="ctx-micro-label">距离下次压缩剩余</div>
              <div className="ctx-remain-row">
                <strong className="mono" title={`${remaining.toLocaleString()} tokens`}>
                  {formatCompactTokens(remaining)}
                </strong>
                <span className={`ctx-pct-badge ${health}`}>{usedPct.toFixed(1)}%</span>
              </div>
            </div>
          </div>

          {/* Segmented Context Gauge */}
          <div className="ctx-gauge-wrap">
            <div
              className="ctx-gauge-track"
              role="progressbar"
              aria-label="当前上下文占用比例"
              aria-valuenow={Math.round(usedPct)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className={`ctx-gauge-cache ${health}`}
                style={{ width: `${cachePctOfLimit}%` }}
                title={`缓存读取: ${cachePart.toLocaleString()} tokens`}
              />
              <div
                className={`ctx-gauge-input ${health}`}
                style={{ width: `${inputPctOfLimit}%` }}
                title={`新增输入: ${inputPart.toLocaleString()} tokens`}
              />
            </div>
            <div className="ctx-gauge-legend">
              <span>
                <span className={`legend-dot cache ${health}`} />
                缓存读取 {formatCompactTokens(cachePart)}
              </span>
              <span>
                <span className={`legend-dot input ${health}`} />
                本步新增 {formatCompactTokens(inputPart)}
              </span>
              <span style={{ marginLeft: 'auto' }}>
                峰值 {formatCompactTokens(current.peakContextTokens)}
              </span>
            </div>
          </div>

          {/* Footer Compact Metrics */}
          <div className="ctx-footer-grid">
            <div className="ctx-mini-stat">
              <span className="ctx-micro-label">触发压缩</span>
              <strong className={current.compactionCount > 0 ? 'ctx-compact-active' : ''}>
                {current.compactionCount} 次
              </strong>
            </div>

            <div className="ctx-mini-stat">
              <span className="ctx-micro-label">当前端点与档位</span>
              <span className="ctx-model-inline" title={current.latestModel}>
                <span
                  className="model-dot"
                  style={{ backgroundColor: getModelColor(current.latestModel) }}
                />
                <span className="mono ctx-model-base">{currentModelParts?.base}</span>
                {currentModelParts?.tier && (
                  <span className={`tier-pill ${currentModelParts.tone}`}>
                    {currentModelParts.tier}
                  </span>
                )}
              </span>
            </div>

            <div className="ctx-mini-stat" style={{ textAlign: 'right' }}>
              <span className="ctx-micro-label">本会话费用 / 步数</span>
              <strong className="mono" style={{ color: 'var(--cost)' }}>
                {formatUsd(current.estimatedCostUsd)}
                <span className="ctx-sub-calls"> · {current.totalCalls}步</span>
              </strong>
            </div>
          </div>

          {current.childCount > 0 && (
            <div className="ctx-child-note">
              <Layers size={12} />
              <span>该主会话已派生 {current.childCount} 个子智能体，点击「波形详情」查看合并账单</span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
