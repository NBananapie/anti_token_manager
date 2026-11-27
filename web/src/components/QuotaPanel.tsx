import React, { useEffect, useState } from 'react';
import { BatteryCharging, RefreshCw, Clock, AlertCircle } from 'lucide-react';
import {
  QuotaSnapshot,
  QuotaWindow,
  formatCountdownSec,
  getQuotaHealthClass
} from '../types';

interface Props {
  quota: QuotaSnapshot | null;
  refreshing?: boolean;
  compact?: boolean;
  onRefresh: () => void;
}

function getPoolDotColor(poolKey: string): string {
  if (poolKey === 'gemini') return '#2563eb';
  if (poolKey === 'argon') return '#4f46e5';
  if (poolKey === 'claude') return '#e11d48';
  return '#64748b';
}

function renderResetCaption(win: QuotaWindow, nowMs: number): string {
  if (!win.available) return '未提供';
  if (win.disabled) return '已禁用';
  if (win.resetAt) {
    const remainSec = Math.max(0, Math.round((Date.parse(win.resetAt) - nowMs) / 1000));
    if (remainSec <= 0) return '即将刷新';
    return `${formatCountdownSec(remainSec)}后重置`;
  }
  if (win.remainingPct != null && win.remainingPct >= 99.9) {
    return '满额就绪';
  }
  return '活跃窗口';
}

function QuotaWindowBar({
  label,
  win,
  nowMs
}: {
  label: string;
  win: QuotaWindow;
  nowMs: number;
}) {
  if (!win.available) {
    return (
      <div className="quota-win-row unavailable">
        <div className="quota-win-head">
          <span className="quota-win-label">{label}</span>
          <span className="quota-win-reset">账户未返回</span>
        </div>
      </div>
    );
  }

  const pct = win.remainingPct;
  const health = getQuotaHealthClass(pct);
  const barWidth = pct != null ? Math.max(0, Math.min(100, pct)) : 0;
  const resetCaption = renderResetCaption(win, nowMs);
  const resetTitle = win.resetAt
    ? `预计重置时间：${new Date(win.resetAt).toLocaleString('zh-CN', { hour12: false })}`
    : win.description || undefined;

  return (
    <div className="quota-win-row" title={resetTitle}>
      <div className="quota-win-head">
        <span className="quota-win-label">{label}</span>
        <span className="quota-win-meta">
          <span className="quota-win-reset">
            <Clock size={10} />
            {resetCaption}
          </span>
          <strong className={`quota-win-pct mono ${health}`}>
            {pct != null ? `${pct.toFixed(1)}%` : '-'}
          </strong>
        </span>
      </div>
      <div
        className="quota-bar-track"
        role="progressbar"
        aria-label={`${label}剩余配额`}
        aria-valuenow={pct != null ? Math.round(pct) : 0}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`quota-bar-fill ${health}`}
          style={{ width: `${barWidth}%` }}
        />
      </div>
    </div>
  );
}

export default function QuotaPanel({
  quota,
  refreshing = false,
  compact = false,
  onRefresh
}: Props) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Tick local countdown smoothly every 30s without network traffic
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  if (!quota) {
    return (
      <section className={`panel-card quota-panel ${compact ? 'compact' : ''}`} aria-label="账户配额余量">
        <div className="quota-offline-row">
          <span className="quota-offline-text">
            <BatteryCharging size={14} />
            正在探测本机 Antigravity 5h / 周配额余量...
          </span>
        </div>
      </section>
    );
  }

  if (!quota.available || quota.groups.length === 0) {
    return (
      <section className={`panel-card quota-panel offline ${compact ? 'compact' : ''}`} aria-label="账户配额余量">
        <div className="quota-offline-row">
          <span className="quota-offline-text" title={quota.error || undefined}>
            <AlertCircle size={14} />
            <span>
              本机配额接口暂不可用
              {quota.error ? `（${quota.error}）` : '（请保持 Antigravity 客户端运行）'}
            </span>
          </span>
          <button
            type="button"
            className="btn-ghost quota-refresh-btn"
            onClick={onRefresh}
            disabled={refreshing}
            title="重新探测本机 Antigravity 配额接口"
          >
            <RefreshCw size={12} className={refreshing ? 'spin' : ''} />
            <span>重试</span>
          </button>
        </div>
      </section>
    );
  }

  const fetchedLabel = quota.fetchedAt
    ? new Date(quota.fetchedAt).toLocaleTimeString('zh-CN', { hour12: false })
    : '-';

  return (
    <section className={`panel-card quota-panel ${compact ? 'compact' : ''}`} aria-label="账户模型池配额余量">
      <div className="panel-header" style={{ marginBottom: 10 }}>
        <div className="panel-title-wrap">
          <h2 className="panel-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <BatteryCharging size={15} />
            <span>{compact ? '配额余量 (5h / 周)' : '账户模型池真实配额余量（5h 滚动 / 周额度）'}</span>
            {quota.planName && <span className="quota-plan-pill">{quota.planName}</span>}
            {quota.status === 'stale' && (
              <span className="quota-stale-pill" title={quota.error || '最近刷新失败，显示缓存值'}>
                缓存
              </span>
            )}
          </h2>
          {!compact && (
            <span className="panel-meta">
              纯只读本机接口探测 · 更新于 {fetchedLabel}
            </span>
          )}
        </div>

        <button
          type="button"
          className="btn-ghost quota-refresh-btn"
          onClick={onRefresh}
          disabled={refreshing}
          title={`手动刷新配额（上次更新 ${fetchedLabel}）`}
        >
          <RefreshCw size={12} className={refreshing ? 'spin' : ''} />
          <span>{compact ? '刷新' : '刷新配额'}</span>
        </button>
      </div>

      <div className="quota-groups-grid">
        {quota.groups.map((group) => (
          <article key={group.id} className="quota-group-card">
            <div className="quota-group-head">
              <div className="quota-group-name-wrap">
                <span
                  className="model-dot"
                  style={{ backgroundColor: getPoolDotColor(group.poolKey) }}
                  aria-hidden="true"
                />
                <span className="quota-group-name">{group.name}</span>
              </div>
              {!compact && group.description && (
                <span className="quota-group-desc" title={group.description}>
                  {group.description.replace(/^Models within this group:\s*/i, '')}
                </span>
              )}
            </div>

            <div className="quota-windows-stack">
              <QuotaWindowBar label="5 小时滚动" win={group.windows['5h']} nowMs={nowMs} />
              <QuotaWindowBar label="每周额度" win={group.windows.weekly} nowMs={nowMs} />
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
