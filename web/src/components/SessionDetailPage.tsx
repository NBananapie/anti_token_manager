import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bot,
  ChevronRight,
  Compass,
  Layers,
  MessageSquare,
  Scissors,
  ShieldCheck,
  Terminal,
  Activity,
  TrendingUp,
  ExternalLink,
  Flame,
  Wrench,
  AlertTriangle
} from 'lucide-react';
import {
  CheckpointEvent,
  GenerationTurn,
  SessionDetail,
  formatCompactTokens,
  formatShortDateTime,
  formatTimeHms,
  formatUsd,
  getCacheAnomalyLabel,
  getContextHealthClass,
  maskSessionId,
  maskSessionTitle
} from '../types';
import ModelBadge from './ModelBadge';
import { canJumpHostConversation, jumpToHostConversation } from '../sidecarBridge';

interface Props {
  sessionId: string;
  detail: SessionDetail | null;
  loading: boolean;
  privacyMode?: boolean;
  onBack: () => void;
  onOpenSession: (id: string) => void;
}

type ChartView = 'context' | 'latency';
type TurnFilter = 'all' | 'checkpoint' | 'anomaly' | 'bloat' | 'slow';

function formatBytesShort(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

function pickReferenceLimit(detail: SessionDetail): { limit: number; label: string; isHistorical: boolean } {
  const cfgLimit = detail.contextConfig?.effectiveLimit || 256000;
  const cfgLabel = detail.contextConfig?.label || `${Math.round(cfgLimit / 1000)}K`;
  if (detail.checkpoints.length > 0) {
    const maxCpPeak = detail.checkpoints.reduce((m, c) => Math.max(m, c.peakContext || 0), 0);
    // If session compacted historically at a substantially lower threshold than current patched limit,
    // display the historical ceiling so the sawtooth wave fills the chart cleanly.
    if (maxCpPeak > 0 && detail.peakContextTokens < cfgLimit * 0.68 && maxCpPeak < cfgLimit * 0.68) {
      const tiers = [128000, 256000, 320000, 384000, 448000, 512000, 768000, 840000];
      const closest = tiers.reduce((best, t) =>
        Math.abs(t - maxCpPeak) < Math.abs(best - maxCpPeak) ? t : best
      , tiers[0]);
      const displayVal = Math.abs(closest - maxCpPeak) / maxCpPeak < 0.18 ? closest : Math.ceil(maxCpPeak / 16000) * 16000;
      return {
        limit: displayVal,
        label: `历史压缩线 ~${Math.round(displayVal / 1000)}K`,
        isHistorical: true
      };
    }
  }
  return { limit: cfgLimit, label: `当前上限 ${cfgLabel}`, isHistorical: false };
}

export default function SessionDetailPage({
  sessionId,
  detail,
  loading,
  privacyMode = false,
  onBack,
  onOpenSession
}: Props) {
  const [chartView, setChartView] = useState<ChartView>('context');
  const [turnFilter, setTurnFilter] = useState<TurnFilter>('all');
  const [showTechMeta, setShowTechMeta] = useState(false);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [focusedCp, setFocusedCp] = useState<number | null>(null);
  const turnRefs = useRef<Record<number, HTMLElement | null>>({});

  // Support Escape key to go back to overview cleanly
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && document.activeElement?.tagName !== 'INPUT') {
        onBack();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  // Reset hover/filter when switching sessions
  useEffect(() => {
    setHoverIdx(null);
    setFocusedCp(null);
    setTurnFilter('all');
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }, [sessionId]);

  // Turns sorted by stepIndex for sawtooth progression
  const orderedTurns = useMemo(() => {
    if (!detail?.generations) return [];
    return [...detail.generations].sort((a, b) => a.stepIndex - b.stepIndex || a.idx - b.idx);
  }, [detail]);

  // Map stepIndex -> position index in orderedTurns
  const stepToPos = useMemo(() => {
    const m = new Map<number, number>();
    orderedTurns.forEach((t, i) => m.set(t.stepIndex, i));
    return m;
  }, [orderedTurns]);

  // Map checkpoint beforeStepIndex -> CheckpointEvent for inline banners & filter
  const cpByBeforeStep = useMemo(() => {
    const m = new Map<number, CheckpointEvent>();
    for (const cp of detail?.checkpoints || []) {
      if (cp.beforeStepIndex != null) m.set(cp.beforeStepIndex, cp);
    }
    return m;
  }, [detail]);

  const cpStepSet = useMemo(() => {
    const s = new Set<number>();
    for (const cp of detail?.checkpoints || []) {
      if (cp.beforeStepIndex != null) s.add(cp.beforeStepIndex);
      if (cp.afterStepIndex != null) s.add(cp.afterStepIndex);
    }
    return s;
  }, [detail]);

  const filteredTurns = useMemo(() => {
    if (turnFilter === 'checkpoint') {
      return orderedTurns.filter((t) => cpStepSet.has(t.stepIndex));
    }
    if (turnFilter === 'anomaly') {
      return orderedTurns.filter((t) => Boolean(t.cacheAnomaly));
    }
    if (turnFilter === 'bloat') {
      return orderedTurns.filter((t) => (t.deltaContextTokens ?? 0) >= 12000);
    }
    if (turnFilter === 'slow') {
      return orderedTurns.filter((t) => (t.totalSec ?? 0) >= 15);
    }
    return orderedTurns;
  }, [orderedTurns, turnFilter, cpStepSet]);

  const canJump = canJumpHostConversation();

  // Summary metrics
  const metrics = useMemo(() => {
    if (!detail) return null;
    const totalTokens = detail.totalInputTokens + detail.totalCacheReadTokens + detail.totalOutputTokens;
    const totalPrompt = detail.totalInputTokens + detail.totalCacheReadTokens;
    const cacheHitPct = totalPrompt > 0 ? (detail.totalCacheReadTokens / totalPrompt) * 100 : 0;
    const liveLimit = detail.contextConfig?.effectiveLimit || 256000;
    const used = detail.currentContextTokens || 0;
    const remaining = Math.max(0, liveLimit - used);
    const usedPct = liveLimit > 0 ? Math.min(100, (used / liveLimit) * 100) : 0;
    const refLimit = pickReferenceLimit(detail);

    const validReductions = detail.checkpoints
      .map((c) => c.reductionPct)
      .filter((v): v is number => v !== null);
    const avgReduction =
      validReductions.length > 0
        ? validReductions.reduce((a, b) => a + b, 0) / validReductions.length
        : null;

    // Combined parent + child totals
    const childTokens = (detail.childSessions || []).reduce((s, c) => s + c.totalTokens, 0);
    const childCost = (detail.childSessions || []).reduce((s, c) => s + c.estimatedCostUsd, 0);
    const childCalls = (detail.childSessions || []).reduce((s, c) => s + c.calls, 0);

    return {
      totalTokens,
      cacheHitPct,
      liveLimit,
      used,
      remaining,
      usedPct,
      health: getContextHealthClass(usedPct),
      refLimit,
      avgReduction,
      combinedTokens: totalTokens + childTokens,
      combinedCost: detail.estimatedCostUsd + childCost,
      combinedCalls: detail.totalCalls + childCalls
    };
  }, [detail]);

  // Map child sessions onto x-axis index span by timestamp
  const childBands = useMemo(() => {
    if (!detail?.childSessions?.length || orderedTurns.length < 2) return [];
    const n = orderedTurns.length;
    const findNearestIndex = (ts: number) => {
      let best = 0;
      let bestDiff = Infinity;
      for (let i = 0; i < n; i++) {
        const diff = Math.abs((orderedTurns[i].timestampMs || 0) - ts);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = i;
        }
      }
      return best;
    };
    return detail.childSessions.map((c) => {
      const startI = findNearestIndex(c.firstTimestampMs || 0);
      const endI = Math.max(startI, findNearestIndex(c.lastTimestampMs || c.firstTimestampMs || 0));
      return { ...c, startI, endI };
    });
  }, [detail, orderedTurns]);

  const jumpToStep = (stepIndex: number | null, cpIndex?: number) => {
    if (cpIndex != null) setFocusedCp(cpIndex);
    if (stepIndex == null) return;
    setTurnFilter('all');
    setTimeout(() => {
      const el = turnRefs.current[stepIndex];
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 30);
  };

  // Chart geometry constants
  const W = 1120;
  const H = 330;
  const PAD_L = 56;
  const PAD_R = 28;
  const PAD_T = childBands.length > 0 ? 36 : 24;
  const PAD_B = 42;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const yMaxContext = useMemo(() => {
    if (!detail || !metrics) return 260000;
    const rawMax = Math.max(detail.peakContextTokens || 0, metrics.refLimit.limit, 64000);
    // Nice step rounding
    const step = rawMax > 500000 ? 200000 : rawMax > 200000 ? 100000 : 50000;
    return Math.ceil((rawMax * 1.1) / step) * step;
  }, [detail, metrics]);

  const yTicksContext = useMemo(() => {
    const count = 4;
    const ticks: number[] = [];
    for (let i = 0; i <= count; i++) {
      ticks.push(Math.round((yMaxContext / count) * i));
    }
    return ticks;
  }, [yMaxContext]);

  const maxTurnSec = useMemo(() => {
    return orderedTurns.reduce((mx, t) => Math.max(mx, t.totalSec ?? 0), 5);
  }, [orderedTurns]);

  const xForIndex = (i: number) => {
    const n = orderedTurns.length;
    if (n <= 1) return PAD_L + plotW / 2;
    return PAD_L + (i / (n - 1)) * plotW;
  };

  const yForContext = (val: number) => {
    const ratio = Math.min(1, Math.max(0, val / yMaxContext));
    return PAD_T + plotH * (1 - ratio);
  };

  const yForSec = (val: number) => {
    const ratio = Math.min(1, Math.max(0, val / (maxTurnSec * 1.12)));
    return PAD_T + plotH * (1 - ratio);
  };

  // Sparse non-overlapping x-axis labels (at most 7 evenly spaced labels)
  const xTickIndices = useMemo(() => {
    const n = orderedTurns.length;
    if (n === 0) return [];
    if (n <= 7) return orderedTurns.map((_, i) => i);
    const desired = 6;
    const res: number[] = [];
    for (let k = 0; k <= desired; k++) {
      const idx = Math.round((k / desired) * (n - 1));
      if (!res.includes(idx)) res.push(idx);
    }
    return res;
  }, [orderedTurns]);

  const hoveredTurn: GenerationTurn | null =
    hoverIdx !== null && orderedTurns[hoverIdx] ? orderedTurns[hoverIdx] : null;
  const hoveredCp = hoveredTurn ? cpByBeforeStep.get(hoveredTurn.stepIndex) || null : null;

  const renderTypeTag = (session: SessionDetail) => {
    if (session.sessionType === 'subagent') {
      return (
        <span className="type-tag subagent">
          <Bot size={11} />
          {session.agentName ? `子任务 · ${session.agentName}` : '子智能体'}
        </span>
      );
    }
    if (session.sessionType === 'side_query') {
      return (
        <span className="type-tag side_query">
          <Compass size={11} />
          侧栏提问
        </span>
      );
    }
    return (
      <span className="type-tag main">
        <MessageSquare size={11} />
        主会话
      </span>
    );
  };

  const handleSvgMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (orderedTurns.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * W;
    if (relX < PAD_L - 8 || relX > W - PAD_R + 8) {
      setHoverIdx(null);
      return;
    }
    const frac = Math.min(1, Math.max(0, (relX - PAD_L) / plotW));
    const idx = orderedTurns.length <= 1 ? 0 : Math.round(frac * (orderedTurns.length - 1));
    setHoverIdx(idx);
  };

  return (
    <main className="app-main detail-page">
      {/* Top Breadcrumb & Title Header */}
      <div className="detail-top-bar">
        <div className="detail-nav-row">
          <button type="button" className="btn-ghost" onClick={onBack}>
            <ArrowLeft size={14} />
            <span>返回总览</span>
          </button>

          {detail?.parentSession && (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => onOpenSession(detail.parentSession!.conversation_id)}
            >
              <Layers size={13} />
              <span>
                主会话:{' '}
                {privacyMode
                  ? maskSessionTitle(detail.parentSession.conversation_id, 'main')
                  : detail.parentSession.title.slice(0, 26)}
              </span>
            </button>
          )}

          {canJump && (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => jumpToHostConversation(sessionId)}
              title="在 Antigravity 左侧主窗口直接打开此对话"
            >
              <ExternalLink size={13} />
              <span>主窗口打开对话</span>
            </button>
          )}
        </div>

        <div className="detail-title-block">
          <div className="detail-title-left">
            <h2 className="detail-page-title">
              {detail
                ? privacyMode
                  ? maskSessionTitle(detail.conversation_id, detail.sessionType, detail.agentName)
                  : detail.title
                : '正在加载会话详情...'}
            </h2>
            {detail && (
              <div className="detail-meta-strip">
                {renderTypeTag(detail)}
                <span className="mono">
                  {privacyMode ? maskSessionId(detail.conversation_id) : detail.conversation_id}
                </span>
                <span>·</span>
                <ModelBadge model={detail.latestModel} />
                <span>·</span>
                <span>
                  {formatShortDateTime(detail.firstTimestampMs)} — {formatShortDateTime(detail.lastTimestampMs)}
                </span>
              </div>
            )}
          </div>

          {detail && metrics && (
            <div className={`limit-pill ${detail.contextConfig?.cloudOverrideBypassed ? 'bypassed' : ''}`}>
              <ShieldCheck size={13} />
              <span>当前阈值上限 {detail.contextConfig?.label || '256K'}</span>
            </div>
          )}
        </div>
      </div>

      {loading && !detail ? (
        <div className="panel-card empty-cell">正在解算会话上下文演变与逐轮时序数据...</div>
      ) : !detail || !metrics ? (
        <div className="panel-card empty-cell">未找到该会话的本地数据库记录</div>
      ) : (
        <>
          {/* 5-Card Session Summary Strip */}
          <section className="detail-kpi-grid" aria-label="会话核心指标">
            <article className="kpi-card detail-kpi">
              <div className="kpi-top">
                <span className="kpi-label">当前上下文 / 剩余空间</span>
                <span className={`ctx-pct-badge ${metrics.health}`}>
                  {metrics.usedPct.toFixed(1)}%
                </span>
              </div>
              <div className="kpi-value-row">
                <span className={`kpi-value ${metrics.health === 'ok' ? '' : metrics.health}`}>
                  {formatCompactTokens(metrics.used)}
                </span>
                <span className="kpi-unit">/ {formatCompactTokens(metrics.liveLimit)}</span>
              </div>
              <div className="kpi-sub">
                <span>剩余 {formatCompactTokens(metrics.remaining)}</span>
                <span>·</span>
                <span>峰值 {formatCompactTokens(detail.peakContextTokens)}</span>
              </div>
            </article>

            <article className="kpi-card detail-kpi">
              <div className="kpi-top">
                <span className="kpi-label">累计流转 Token</span>
              </div>
              <div className="kpi-value-row">
                <span className="kpi-value">{formatCompactTokens(metrics.totalTokens)}</span>
                <span className="kpi-unit">tokens</span>
              </div>
              <div className="kpi-sub">
                <span>输出 {formatCompactTokens(detail.totalOutputTokens)}</span>
                <span>·</span>
                <span>思考 {detail.thinkingSharePct}%</span>
              </div>
            </article>

            <article className="kpi-card detail-kpi">
              <div className="kpi-top">
                <span className="kpi-label">估算费用（含缓存节省）</span>
                {detail.cacheSavingsPct > 0 && (
                  <span className="savings-pill">-{detail.cacheSavingsPct}%</span>
                )}
              </div>
              <div className="kpi-value-row">
                <span className="kpi-value accent-cost">{formatUsd(detail.estimatedCostUsd)}</span>
                <span className="kpi-unit">USD</span>
              </div>
              <div className="kpi-sub">
                <span>缓存已省 {formatUsd(detail.cacheSavingsUsd)}</span>
              </div>
            </article>

            <article className="kpi-card detail-kpi">
              <div className="kpi-top">
                <span className="kpi-label">缓存命中与输出速率</span>
                {(detail.cacheAnomalyCount ?? 0) > 0 && (
                  <span
                    className="anomaly-pill"
                    title={`短间隔异常掉缓存 ${detail.cacheAnomalyCount} 次，估算多花 ${formatUsd(detail.cacheAnomalyWastedUsd)}`}
                  >
                    {detail.cacheAnomalyCount} 次掉缓存
                  </span>
                )}
              </div>
              <div className="kpi-value-row">
                <span className="kpi-value accent-speed">{metrics.cacheHitPct.toFixed(1)}%</span>
              </div>
              <div className="kpi-sub">
                <span>{detail.streamTps != null ? `${detail.streamTps} tok/s` : '-'}</span>
                <span>·</span>
                <span>TTFT {detail.avgTtftSec != null ? `${detail.avgTtftSec}s` : '-'}</span>
              </div>
            </article>

            <article className="kpi-card detail-kpi">
              <div className="kpi-top">
                <span className="kpi-label">触发压缩次数</span>
                <Scissors size={14} className="kpi-icon" />
              </div>
              <div className="kpi-value-row">
                <span className={`kpi-value ${detail.compactionCount > 0 ? 'ctx-compact-active' : ''}`}>
                  {detail.compactionCount}
                </span>
                <span className="kpi-unit">次 / {detail.totalCalls} 步</span>
              </div>
              <div className="kpi-sub">
                {metrics.avgReduction !== null ? (
                  <span>平均缩减 {metrics.avgReduction.toFixed(1)}%</span>
                ) : (
                  <span>当前会话尚未触发压缩</span>
                )}
              </div>
            </article>
          </section>

          {/* Main Interactive Visualization Panel (Sawtooth Context Curve / Latency Toggle) */}
          <section className="panel-card chart-panel" aria-label="上下文长度演变与性能波形">
            <div className="panel-header" style={{ marginBottom: 10 }}>
              <div className="panel-title-wrap">
                <h3 className="panel-title">
                  {chartView === 'context'
                    ? '上下文长度演变与压缩时机分析'
                    : '逐轮首字等待 (TTFT) 与流式输出耗时'}
                </h3>
                <span className="panel-meta">
                  {chartView === 'context'
                    ? `共 ${orderedTurns.length} 个推理步 · 悬停十字准星查看每步精确输入与缓存分解`
                    : `峰值单步耗时 ${maxTurnSec.toFixed(1)}s · 悬停查看每轮速率`}
                </span>
              </div>

              <div className="segmented" role="group" aria-label="波形视图切换">
                <button
                  type="button"
                  className={`seg-btn ${chartView === 'context' ? 'active' : ''}`}
                  onClick={() => setChartView('context')}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <TrendingUp size={13} />
                    上下文与压缩波形
                  </span>
                </button>
                <button
                  type="button"
                  className={`seg-btn ${chartView === 'latency' ? 'active' : ''}`}
                  onClick={() => setChartView('latency')}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <Activity size={13} />
                    耗时与速率
                  </span>
                </button>
              </div>
            </div>

            {/* Live Crosshair Readout Strip (Zero Occlusion over Wave) */}
            <div className="chart-readout-bar">
              {hoveredTurn ? (
                <>
                  <strong className="mono">Step {hoveredTurn.stepIndex}</strong>
                  <span className="mono">{formatShortDateTime(hoveredTurn.timestampMs)}</span>
                  <ModelBadge model={hoveredTurn.model} />
                  <span>
                    上下文 <strong>{hoveredTurn.contextTokens.toLocaleString()}</strong>
                    {' '}（输入 {hoveredTurn.inputTokens.toLocaleString()} + 缓存{' '}
                    {hoveredTurn.cacheReadTokens.toLocaleString()}）
                  </span>
                  <span>
                    输出 <strong>{hoveredTurn.outputTokens.toLocaleString()}</strong>
                  </span>
                  {hoveredTurn.streamTps != null && (
                    <span style={{ color: 'var(--speed)', fontWeight: 600 }}>
                      {hoveredTurn.streamTps} tok/s
                    </span>
                  )}
                  {hoveredTurn.totalSec != null && (
                    <span>
                      TTFT {hoveredTurn.ttftSec?.toFixed(2)}s / 流式 {hoveredTurn.streamSec?.toFixed(2)}s
                    </span>
                  )}
                  {hoveredCp && (
                    <span className="cp-inline-tag">
                      压缩 #{hoveredCp.index} ({hoveredCp.reductionPct ?? '-'}%)
                    </span>
                  )}
                  {hoveredTurn.cacheAnomaly && (
                    <span className="anomaly-inline-tag">
                      {getCacheAnomalyLabel(hoveredTurn.cacheAnomaly.kind)} · 间隔 {hoveredTurn.cacheAnomaly.gapSec}s · 命中 {hoveredTurn.cacheAnomaly.prevHitPct}%→{hoveredTurn.cacheAnomaly.curHitPct}%
                    </span>
                  )}
                </>
              ) : (
                <div className="chart-legend-inline">
                  {chartView === 'context' ? (
                    <>
                      <span className="legend-item">
                        <span className="legend-swatch" style={{ background: '#1d4ed8' }} />
                        普通输入 (input_tokens)
                      </span>
                      <span className="legend-item">
                        <span className="legend-swatch" style={{ background: '#60a5fa' }} />
                        缓存输入 (cache_read_tokens)
                      </span>
                      <span className="legend-item">
                        <span className="legend-swatch" style={{ background: '#ef4444', borderRadius: '50%' }} />
                        CHECKPOINT 触发 ({detail.compactionCount} 次)
                      </span>
                      {(detail.cacheAnomalyCount ?? 0) > 0 && (
                        <span className="legend-item">
                          <span className="legend-diamond" />
                          异常掉缓存 ({detail.cacheAnomalyCount} 次)
                        </span>
                      )}
                      <span className="legend-item">
                        <span className="legend-swatch" style={{ background: '#10b981', borderRadius: '50%' }} />
                        压缩后重置基线
                      </span>
                      <span className="legend-item">
                        <span className="legend-dash" />
                        {metrics.refLimit.label}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="legend-item">
                        <span className="legend-swatch" style={{ background: '#f59e0b' }} />
                        首字等待 TTFT
                      </span>
                      <span className="legend-item">
                        <span className="legend-swatch" style={{ background: '#06b6d4' }} />
                        流式吐字 Stream
                      </span>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Interactive SVG Chart */}
            {orderedTurns.length > 0 ? (
              <div className="sawtooth-wrap">
                <svg
                  viewBox={`0 0 ${W} ${H}`}
                  className="sawtooth-svg"
                  onMouseMove={handleSvgMouseMove}
                  onMouseLeave={() => setHoverIdx(null)}
                  onClick={() => {
                    if (hoveredTurn) jumpToStep(hoveredTurn.stepIndex);
                  }}
                  role="img"
                  aria-label="会话上下文演变与压缩波形交互图"
                >
                  {/* Horizontal Y-Axis Gridlines */}
                  {chartView === 'context'
                    ? yTicksContext.map((tick) => {
                        const y = yForContext(tick);
                        return (
                          <g key={`yt-${tick}`}>
                            <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} className="chart-grid" />
                            <text x={PAD_L - 8} y={y + 4} textAnchor="end" className="chart-axis-text">
                              {tick === 0 ? '0' : `${Math.round(tick / 1000)}K`}
                            </text>
                          </g>
                        );
                      })
                    : [0, 0.25, 0.5, 0.75, 1].map((frac) => {
                        const val = maxTurnSec * 1.12 * frac;
                        const y = PAD_T + plotH * (1 - frac);
                        return (
                          <g key={`yl-${frac}`}>
                            <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} className="chart-grid" />
                            <text x={PAD_L - 8} y={y + 4} textAnchor="end" className="chart-axis-text">
                              {val.toFixed(0)}s
                            </text>
                          </g>
                        );
                      })}

                  {/* Parallel Subagent Swimlane (Top narrow ribbon, never overlaps wave) */}
                  {chartView === 'context' &&
                    childBands.map((cb) => {
                      const x1 = xForIndex(cb.startI);
                      const x2 = Math.max(x1 + 10, xForIndex(cb.endI));
                      return (
                        <g key={`cb-${cb.conversation_id}`}>
                          <rect
                            x={x1}
                            y={8}
                            width={Math.min(x2 - x1, W - PAD_R - x1)}
                            height={10}
                            rx={5}
                            className="subagent-ribbon"
                          >
                            <title>
                              {`子智能体 · ${cb.agentName}: ${privacyMode ? maskSessionTitle(cb.conversation_id, 'subagent', cb.agentName) : cb.title} (${formatCompactTokens(cb.totalTokens)} tokens · ${formatUsd(cb.estimatedCostUsd)})`}
                            </title>
                          </rect>
                        </g>
                      );
                    })}

                  {/* Main Bars */}
                  {orderedTurns.map((t, i) => {
                    const n = orderedTurns.length;
                    const slotW = plotW / Math.max(n, 1);
                    const barW = Math.max(1.5, Math.min(14, slotW * 0.84));
                    const cx = xForIndex(i);
                    const x = cx - barW / 2;
                    const isHovered = hoverIdx === i;

                    if (chartView === 'context') {
                      const totalH = (t.contextTokens / yMaxContext) * plotH;
                      const cacheH = (t.cacheReadTokens / yMaxContext) * plotH;
                      const inputH = Math.max(0, totalH - cacheH);
                      const yBase = PAD_T + plotH;
                      const hasAnomaly = Boolean(t.cacheAnomaly);
                      const topY = yBase - totalH;

                      return (
                        <g key={`b-${t.stepIndex}-${t.idx}`} opacity={hoverIdx !== null && !isHovered ? 0.72 : 1}>
                          <rect
                            x={x}
                            y={yBase - cacheH}
                            width={barW}
                            height={Math.max(0, cacheH)}
                            fill="#60a5fa"
                            opacity={0.78}
                          />
                          <rect
                            x={x}
                            y={topY}
                            width={barW}
                            height={Math.max(0.8, inputH)}
                            fill={hasAnomaly ? '#dc2626' : '#1d4ed8'}
                            opacity={0.94}
                          />
                          {hasAnomaly && (
                            <polygon
                              points={`${cx},${Math.max(PAD_T, topY - 10)} ${cx + 4},${Math.max(PAD_T + 4, topY - 6)} ${cx},${Math.max(PAD_T + 8, topY - 2)} ${cx - 4},${Math.max(PAD_T + 4, topY - 6)}`}
                              fill="#dc2626"
                              stroke="#ffffff"
                              strokeWidth={1.1}
                            />
                          )}
                        </g>
                      );
                    }

                    // Latency stacked bar
                    const total = t.totalSec ?? 0;
                    const ttft = t.ttftSec ?? 0;
                    const stream = Math.max(0, t.streamSec ?? total - ttft);
                    const yBase = PAD_T + plotH;
                    const totalH = (total / (maxTurnSec * 1.12)) * plotH;
                    const ttftH = total > 0 ? (ttft / total) * totalH : 0;
                    const streamH = Math.max(0, totalH - ttftH);

                    return (
                      <g key={`l-${t.stepIndex}-${t.idx}`} opacity={hoverIdx !== null && !isHovered ? 0.65 : 1}>
                        <rect
                          x={x}
                          y={yBase - totalH}
                          width={barW}
                          height={Math.max(0, streamH)}
                          rx={1}
                          fill="#06b6d4"
                        />
                        <rect
                          x={x}
                          y={yBase - ttftH}
                          width={barW}
                          height={Math.max(0, ttftH)}
                          rx={1}
                          fill="#f59e0b"
                        />
                      </g>
                    );
                  })}

                  {/* Threshold Ceiling Dashed Line */}
                  {chartView === 'context' && metrics.refLimit.limit <= yMaxContext && (
                    <g>
                      <line
                        x1={PAD_L}
                        y1={yForContext(metrics.refLimit.limit)}
                        x2={W - PAD_R}
                        y2={yForContext(metrics.refLimit.limit)}
                        className="chart-threshold-line"
                      />
                      <rect
                        x={W - PAD_R - 118}
                        y={yForContext(metrics.refLimit.limit) - 18}
                        width={118}
                        height={16}
                        rx={4}
                        className="chart-threshold-pill"
                      />
                      <text
                        x={W - PAD_R - 59}
                        y={yForContext(metrics.refLimit.limit) - 7}
                        textAnchor="middle"
                        className="chart-threshold-text"
                      >
                        {metrics.refLimit.label}
                      </text>
                    </g>
                  )}

                  {/* Checkpoint Anchors (Clean markers + tiny #N tag, zero occlusion) */}
                  {chartView === 'context' &&
                    detail.checkpoints.map((cp) => {
                      const beforePos = cp.beforeStepIndex != null ? stepToPos.get(cp.beforeStepIndex) : undefined;
                      const afterPos = cp.afterStepIndex != null ? stepToPos.get(cp.afterStepIndex) : undefined;
                      if (beforePos === undefined) return null;

                      const bx = xForIndex(beforePos);
                      const by = yForContext(cp.peakContext);
                      const isFocused = focusedCp === cp.index;

                      return (
                        <g
                          key={`cp-${cp.index}`}
                          style={{ cursor: 'pointer' }}
                          onClick={(e) => {
                            e.stopPropagation();
                            jumpToStep(cp.beforeStepIndex, cp.index);
                          }}
                        >
                          <line
                            x1={bx}
                            y1={PAD_T}
                            x2={bx}
                            y2={PAD_T + plotH}
                            className={`cp-vline ${isFocused ? 'focused' : ''}`}
                          />
                          <circle
                            cx={bx}
                            cy={by}
                            r={isFocused ? 5.5 : 4}
                            fill="#ef4444"
                            stroke="#ffffff"
                            strokeWidth={1.5}
                          />
                          <rect
                            x={bx - 12}
                            y={Math.max(PAD_T - 2, by - 22)}
                            width={24}
                            height={15}
                            rx={4}
                            fill={isFocused ? '#dc2626' : '#ef4444'}
                          />
                          <text
                            x={bx}
                            y={Math.max(PAD_T - 2, by - 22) + 11}
                            textAnchor="middle"
                            fill="#ffffff"
                            fontSize={10}
                            fontWeight={700}
                            fontFamily="var(--font-mono)"
                          >
                            #{cp.index}
                          </text>
                          {afterPos !== undefined && cp.resetContext != null && (
                            <circle
                              cx={xForIndex(afterPos)}
                              cy={yForContext(cp.resetContext)}
                              r={3.5}
                              fill="#10b981"
                              stroke="#ffffff"
                              strokeWidth={1.2}
                            />
                          )}
                        </g>
                      );
                    })}

                  {/* Hover Crosshair */}
                  {hoveredTurn && hoverIdx !== null && (
                    <g pointerEvents="none">
                      <line
                        x1={xForIndex(hoverIdx)}
                        y1={PAD_T}
                        x2={xForIndex(hoverIdx)}
                        y2={PAD_T + plotH}
                        className="chart-crosshair"
                      />
                      <circle
                        cx={xForIndex(hoverIdx)}
                        cy={
                          chartView === 'context'
                            ? yForContext(hoveredTurn.contextTokens)
                            : yForSec(hoveredTurn.totalSec ?? 0)
                        }
                        r={4.5}
                        fill="var(--accent)"
                        stroke="var(--bg-surface)"
                        strokeWidth={2}
                      />
                    </g>
                  )}

                  {/* Sparse X-Axis Ticks (Step # + Timestamp) */}
                  {xTickIndices.map((idx, pos) => {
                    const t = orderedTurns[idx];
                    const x = xForIndex(idx);
                    const anchor =
                      pos === 0 ? 'start' : pos === xTickIndices.length - 1 ? 'end' : 'middle';
                    return (
                      <g key={`xt-${idx}`}>
                        <text x={x} y={H - 20} textAnchor={anchor} className="chart-axis-text strong">
                          Step {t.stepIndex}
                        </text>
                        <text x={x} y={H - 6} textAnchor={anchor} className="chart-axis-sub">
                          {formatShortDateTime(t.timestampMs)}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              </div>
            ) : (
              <div className="empty-cell">该会话暂无推理步数据</div>
            )}

            {/* Compact Checkpoint Snapshot Strip (Replaces Overlapping Callout Boxes) */}
            {detail.checkpoints.length > 0 && (
              <div className="cp-strip" role="list" aria-label="上下文压缩事件清单">
                {detail.checkpoints.map((cp) => (
                  <button
                    key={cp.index}
                    type="button"
                    role="listitem"
                    className={`cp-chip ${focusedCp === cp.index ? 'active' : ''}`}
                    onClick={() => jumpToStep(cp.beforeStepIndex, cp.index)}
                  >
                    <div className="cp-chip-top">
                      <span className="cp-chip-num">压缩 #{cp.index}</span>
                      <span className="cp-chip-time">{formatTimeHms(cp.timestampMs)}</span>
                      {cp.reductionPct !== null && (
                        <span className="cp-chip-pct">{cp.reductionPct.toFixed(1)}%</span>
                      )}
                    </div>
                    <div className="cp-chip-vals">
                      <span>峰值 {formatCompactTokens(cp.peakContext)}</span>
                      <span>→</span>
                      <span>
                        重置 {cp.resetContext != null ? formatCompactTokens(cp.resetContext) : '-'}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
            {/* Short-Interval Cache Anomaly Quick Jump Strip */}
            {detail.cacheAnomalies && detail.cacheAnomalies.length > 0 && (
              <div className="anomaly-strip" role="list" aria-label="短间隔异常掉缓存清单">
                <span className="anomaly-strip-label">
                  <AlertTriangle size={12} />
                  异常掉缓存 ({detail.cacheAnomalies.length} 次 · 估算多花 {formatUsd(detail.cacheAnomalyWastedUsd)})
                </span>
                {detail.cacheAnomalies.slice(0, 10).map((an) => (
                  <button
                    key={`an-${an.stepIndex}`}
                    type="button"
                    role="listitem"
                    className="anomaly-chip"
                    onClick={() => jumpToStep(an.stepIndex)}
                    title={`Step ${an.stepIndex} ${getCacheAnomalyLabel(an.kind)}：距上轮仅 ${an.gapSec}s，命中率 ${an.prevHitPct}% → ${an.curHitPct}%，估算多花 ${formatUsd(an.wastedCostUsd)}`}
                  >
                    <span className="anomaly-kind">{getCacheAnomalyLabel(an.kind)}</span>
                    <span className="mono">Step {an.stepIndex}</span>
                    <span className="anomaly-meta">
                      {an.gapSec}s · {an.prevHitPct}%→{an.curHitPct}%
                    </span>
                    {an.wastedCostUsd > 0 && (
                      <span className="anomaly-cost">+{formatUsd(an.wastedCostUsd)}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
            {/* Single-Step Token Bloat Attribution Strip */}
            {detail.heavySteps && detail.heavySteps.length > 0 && (
              <div className="bloat-strip" role="list" aria-label="单步上下文暴涨 Top 归因">
                <span className="bloat-strip-label">
                  <Flame size={12} />
                  单步暴涨 Top
                </span>
                {detail.heavySteps.map((hs) => {
                  const topTool = hs.tools && hs.tools.length > 0 ? hs.tools[0] : null;
                  const extraCount = Math.max(0, (hs.tools?.length || 0) - 1);
                  const tooltipLines = (hs.tools || [])
                    .slice(0, 5)
                    .map((t) => {
                      const sz = formatBytesShort(t.bytes);
                      const tgt = !privacyMode && t.target ? ` (${t.target})` : '';
                      return `• ${t.toolName}${tgt}${sz ? ` · ${sz}` : ''}`;
                    })
                    .join('\n');
                  return (
                    <button
                      key={`hs-${hs.stepIndex}`}
                      type="button"
                      role="listitem"
                      className="bloat-chip"
                      onClick={() => jumpToStep(hs.stepIndex)}
                      title={`Step ${hs.stepIndex} 单步增长 +${hs.deltaContextTokens.toLocaleString()} tokens${tooltipLines ? `\n主要输入来源：\n${tooltipLines}` : ''}`}
                    >
                      <span className="bloat-delta">+{formatCompactTokens(hs.deltaContextTokens)}</span>
                      <span className="mono">Step {hs.stepIndex}</span>
                      {topTool && (
                        <span className="bloat-tool-tag">
                          {topTool.toolName}
                          {!privacyMode && topTool.target ? ` (${topTool.target.slice(0, 20)})` : ''}
                          {topTool.bytes ? ` · ${formatBytesShort(topTool.bytes)}` : ''}
                          {extraCount > 0 ? ` +${extraCount}` : ''}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {/* Derived Subagents Unified Billing Panel (Shown when subagents exist) */}
          {detail.childSessions && detail.childSessions.length > 0 && (
            <section className="panel-card" aria-label="派生子智能体合并统计">
              <div className="panel-header" style={{ marginBottom: 12 }}>
                <div className="panel-title-wrap">
                  <h3 className="panel-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <Bot size={15} />
                    关联子智能体 ({detail.childSessions.length})
                  </h3>
                  <span className="panel-meta">
                    主子合并总流转 {formatCompactTokens(metrics.combinedTokens)} tokens · 合并估算费用{' '}
                    <strong style={{ color: 'var(--cost)' }}>{formatUsd(metrics.combinedCost)}</strong> ({metrics.combinedCalls} 次调用)
                  </span>
                </div>
              </div>

              <div className="subagent-list">
                {detail.childSessions.map((child) => (
                  <button
                    key={child.conversation_id}
                    type="button"
                    className="subagent-row-btn"
                    onClick={() => onOpenSession(child.conversation_id)}
                  >
                    <div className="subagent-row-main">
                      <span className="type-tag subagent">{child.agentName}</span>
                      <span className="subagent-title">
                        {privacyMode
                          ? maskSessionTitle(child.conversation_id, 'subagent', child.agentName)
                          : child.title}
                      </span>
                    </div>
                    <div className="subagent-row-stats">
                      <ModelBadge model={child.latestModel} />
                      <span className="mono">{child.calls} 步</span>
                      <span className="mono">{formatCompactTokens(child.totalTokens)}</span>
                      <span className="mono" style={{ color: 'var(--cost)', fontWeight: 600 }}>
                        {formatUsd(child.estimatedCostUsd)}
                      </span>
                      <ChevronRight size={14} style={{ color: 'var(--text-muted)' }} />
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Per-turn Detailed Timeline */}
          <section className="panel-card" aria-label="逐轮调用明细">
            <div className="panel-header" style={{ marginBottom: 14 }}>
              <div className="panel-title-wrap">
                <h3 className="panel-title">逐轮调用时序明细</h3>
                <span className="panel-meta">共展示 {filteredTurns.length} / {orderedTurns.length} 步</span>
              </div>

              <div className="panel-controls">
                <div className="segmented" role="group" aria-label="轮次筛选">
                  <button
                    type="button"
                    className={`seg-btn ${turnFilter === 'all' ? 'active' : ''}`}
                    onClick={() => setTurnFilter('all')}
                  >
                    全部 ({orderedTurns.length})
                  </button>
                  {detail.checkpoints.length > 0 && (
                    <button
                      type="button"
                      className={`seg-btn ${turnFilter === 'checkpoint' ? 'active' : ''}`}
                      onClick={() => setTurnFilter('checkpoint')}
                    >
                      仅压缩节点 ({cpStepSet.size})
                    </button>
                  )}
                  {(detail.cacheAnomalies?.length ?? 0) > 0 && (
                    <button
                      type="button"
                      className={`seg-btn ${turnFilter === 'anomaly' ? 'active' : ''}`}
                      onClick={() => setTurnFilter('anomaly')}
                    >
                      异常掉缓存 ({detail.cacheAnomalies?.length})
                    </button>
                  )}
                  {(detail.heavySteps?.length ?? 0) > 0 && (
                    <button
                      type="button"
                      className={`seg-btn ${turnFilter === 'bloat' ? 'active' : ''}`}
                      onClick={() => setTurnFilter('bloat')}
                    >
                      单步暴涨 ({detail.heavySteps?.length})
                    </button>
                  )}
                  <button
                    type="button"
                    className={`seg-btn ${turnFilter === 'slow' ? 'active' : ''}`}
                    onClick={() => setTurnFilter('slow')}
                  >
                    高耗时 (&ge;15s)
                  </button>
                </div>

                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setShowTechMeta((v) => !v)}
                  aria-pressed={showTechMeta}
                >
                  <Terminal size={13} />
                  <span>{showTechMeta ? '隐藏元数据' : '调试元数据'}</span>
                </button>
              </div>
            </div>

            <div className="turns-list">
              {filteredTurns.length === 0 ? (
                <div className="empty-cell">当前筛选条件下无匹配轮次</div>
              ) : (
                filteredTurns.map((turn) => {
                  const totalSec = turn.totalSec ?? 0;
                  const ttftPct =
                    totalSec > 0 && turn.ttftSec != null
                      ? Math.min(100, (turn.ttftSec / totalSec) * 100)
                      : 0;
                  const streamPct = Math.max(0, 100 - ttftPct);
                  const cpAfter = cpByBeforeStep.get(turn.stepIndex);
                  const isCpHighlighted = cpAfter && focusedCp === cpAfter.index;

                  return (
                    <React.Fragment key={`${turn.stepIndex}-${turn.idx}`}>
                      <article
                        ref={(el) => {
                          turnRefs.current[turn.stepIndex] = el;
                        }}
                        className={`turn-card ${isCpHighlighted ? 'highlighted' : ''} ${turn.cacheAnomaly ? 'cache-anomaly' : ''}`}
                      >
                        <div className="turn-head">
                          <div className="turn-head-left">
                            <span className="turn-idx">Step {turn.stepIndex}</span>
                            <span className="cell-secondary" style={{ marginTop: 0 }}>
                              {formatShortDateTime(turn.timestampMs)}
                            </span>
                            <ModelBadge model={turn.model} />
                            <span className="turn-metric-pill">
                              上下文 {formatCompactTokens(turn.contextTokens)}
                            </span>
                            {turn.cacheAnomaly && (
                              <span
                                className="turn-metric-pill anomaly"
                                title={`短间隔（${turn.cacheAnomaly.gapSec}s）${getCacheAnomalyLabel(turn.cacheAnomaly.kind)}：命中率 ${turn.cacheAnomaly.prevHitPct}% → ${turn.cacheAnomaly.curHitPct}%，估算多花 ${formatUsd(turn.cacheAnomaly.wastedCostUsd)}`}
                              >
                                <AlertTriangle size={11} />
                                {getCacheAnomalyLabel(turn.cacheAnomaly.kind)} · {turn.cacheAnomaly.gapSec}s · {turn.cacheAnomaly.prevHitPct}%→{turn.cacheAnomaly.curHitPct}%
                              </span>
                            )}
                            {(turn.deltaContextTokens ?? 0) >= 12000 && (
                              <span
                                className="turn-metric-pill bloat"
                                title={`较上一步新增上下文 +${(turn.deltaContextTokens ?? 0).toLocaleString()} tokens`}
                              >
                                +{formatCompactTokens(turn.deltaContextTokens ?? 0)}
                              </span>
                            )}
                            {turn.streamTps != null ? (
                              <span className="turn-metric-pill speed">
                                流式 {turn.streamTps} tok/s
                              </span>
                            ) : turn.streamSec != null && turn.streamSec < 0.5 && turn.responseTokens > 0 ? (
                              <span className="turn-metric-pill">
                                单包输出 ({turn.responseTokens} tok)
                              </span>
                            ) : null}
                            {turn.e2eTps != null && (
                              <span className="turn-metric-pill">端到端 {turn.e2eTps} tok/s</span>
                            )}
                          </div>

                          <div className="cell-secondary" style={{ marginTop: 0 }}>
                            {turn.totalSec != null ? (
                              <>
                                TTFT <strong>{turn.ttftSec?.toFixed(2)}s</strong> · 流式{' '}
                                <strong>{turn.streamSec?.toFixed(2)}s</strong> · 共{' '}
                                <strong>{turn.totalSec.toFixed(2)}s</strong>
                              </>
                            ) : (
                              '无耗时记录'
                            )}
                          </div>
                        </div>

                        {totalSec > 0 && (
                          <div className="turn-timing-bar">
                            <div className="timing-ttft" style={{ width: `${ttftPct}%` }} />
                            <div className="timing-stream" style={{ width: `${streamPct}%` }} />
                          </div>
                        )}

                        <div className="turn-tokens-row">
                          <div className="turn-tokens-group">
                            <span>
                              输入 <strong>{turn.inputTokens.toLocaleString()}</strong>
                            </span>
                            <span>
                              缓存 <strong>{(turn.cacheReadTokens || 0).toLocaleString()}</strong>
                            </span>
                            <span>
                              输出 <strong>{turn.outputTokens.toLocaleString()}</strong>
                              {' '}（思考 {(turn.thinkingTokens || 0).toLocaleString()} / 正文{' '}
                              {(turn.responseTokens || 0).toLocaleString()}）
                            </span>
                          </div>
                          <span className="mono" style={{ color: 'var(--cost)', fontWeight: 600 }}>
                            {formatUsd(turn.costUsd)}
                          </span>
                        </div>

                        {turn.bloatTools && turn.bloatTools.length > 0 && (
                          <div className="turn-tools-row">
                            <span className="turn-tools-label" title="导致本轮上下文增长的上一步工具返回与消息来源">
                              <Flame size={11} />
                              输入来源
                            </span>
                            {turn.bloatTools.slice(0, 5).map((tl, ti) => {
                              const sz = formatBytesShort(tl.bytes);
                              return (
                                <span
                                  key={`in-${tl.stepIndex}-${ti}`}
                                  className={`tool-attr-pill ${tl.bytes && tl.bytes >= 12000 ? 'heavy' : ''}`}
                                  title={`${tl.toolName}${!privacyMode && tl.target ? `: ${tl.target}` : ''}${sz ? ` (${sz})` : ''}`}
                                >
                                  {tl.toolName}
                                  {!privacyMode && tl.target ? `: ${tl.target.slice(0, 26)}` : ''}
                                  {sz ? ` · ${sz}` : ''}
                                </span>
                              );
                            })}
                          </div>
                        )}

                        {turn.calledTools && turn.calledTools.length > 0 && (
                          <div className="turn-tools-row">
                            <span className="turn-tools-label called" title="本轮模型决策并发起的工具调用">
                              <Wrench size={11} />
                              本轮调用
                            </span>
                            {turn.calledTools.slice(0, 6).map((tl, ti) => (
                              <span
                                key={`call-${tl.stepIndex}-${ti}`}
                                className="tool-attr-pill called"
                                title={`${tl.toolName}${!privacyMode && tl.target ? `: ${tl.target}` : ''}`}
                              >
                                {tl.toolName}
                                {!privacyMode && tl.target ? `: ${tl.target.slice(0, 26)}` : ''}
                              </span>
                            ))}
                          </div>
                        )}

                        {showTechMeta && (
                          <div className="turn-tech-footer">
                            <span>model_enum: {turn.metadata.model_enum || '-'}</span>
                            <span>gen_idx: {turn.idx}</span>
                            <span>claude: {turn.metadata.used_claude || 'false'}</span>
                            <span>
                            req:{' '}
                            {privacyMode && turn.metadata.request_id
                              ? `${turn.metadata.request_id.slice(0, 6)}••••`
                              : turn.metadata.request_id || '-'}
                          </span>
                          </div>
                        )}
                      </article>

                      {/* Inline Compaction Event Divider */}
                      {cpAfter && (
                        <div className="cp-divider">
                          <Scissors size={13} />
                          <span>
                            触发上下文压缩 #{cpAfter.index}（Step {cpAfter.stepIndex} ·{' '}
                            {formatTimeHms(cpAfter.timestampMs)}）
                          </span>
                          <span className="mono">
                            峰值 {cpAfter.peakContext.toLocaleString()} → 重置{' '}
                            {cpAfter.resetContext != null ? cpAfter.resetContext.toLocaleString() : '-'}
                          </span>
                          {cpAfter.reductionPct !== null && (
                            <span className="cp-chip-pct">{cpAfter.reductionPct.toFixed(1)}%</span>
                          )}
                          {(cpAfter.costUsd ?? 0) > 0 && (
                            <span className="mono" style={{ color: 'var(--cost)' }}>
                              摘要消耗{' '}
                              {formatCompactTokens(
                                (cpAfter.inputTokens || 0) +
                                  (cpAfter.cacheReadTokens || 0) +
                                  (cpAfter.outputTokens || 0)
                              )}{' '}
                              · {formatUsd(cpAfter.costUsd)}
                            </span>
                          )}
                        </div>
                      )}
                    </React.Fragment>
                  );
                })
              )}
            </div>
          </section>
        </>
      )}
    </main>
  );
}
