import React, { useEffect, useState } from 'react';
import { Shield, X, Check } from 'lucide-react';
import { ContextLimitConfig, GuardSettings, formatUsd } from '../types';
import { apiFetch } from '../sidecarBridge';

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function GuardSettingsDrawer({ open, onClose }: Props) {
  const [settings, setSettings] = useState<GuardSettings | null>(null);
  const [todayCostUsd, setTodayCostUsd] = useState<number>(0);
  const [contextConfig, setContextConfig] = useState<ContextLimitConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    apiFetch('/api/guard-settings')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!active || !data) return;
        setSettings(data.settings);
        setTodayCostUsd(Number(data.todayCostUsd || 0));
        setContextConfig(data.contextConfig || null);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [open]);

  if (!open) return null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    setSaving(true);
    setSavedNotice(false);
    try {
      const res = await apiFetch('/api/guard-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      if (res.ok) {
        const data = await res.json();
        setSettings(data.settings);
        setSavedNotice(true);
        setTimeout(() => setSavedNotice(false), 2200);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="panel-card guard-drawer" aria-label="守卫与预算设置">
      <div className="panel-header" style={{ marginBottom: 12 }}>
        <div className="panel-title-wrap">
          <h2 className="panel-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Shield size={15} />
            预算与上下文守卫设置
          </h2>
          <span className="panel-meta">
            今日实时支出 <strong className="mono">{formatUsd(todayCostUsd)}</strong> · 当前上限{' '}
            <strong className="mono">{contextConfig?.label || '256K'}</strong>
          </span>
        </div>
        <button type="button" className="btn-ghost btn-icon" onClick={onClose} title="关闭守卫设置">
          <X size={14} />
        </button>
      </div>

      {!settings ? (
        <div className="empty-cell" style={{ padding: '16px 0' }}>
          正在读取插件守卫配置...
        </div>
      ) : (
        <form className="guard-form" onSubmit={handleSave}>
          <div className="guard-grid">
            <label className="guard-field">
              <span className="guard-label">高水位提醒阈值 (%)</span>
              <div className="guard-inline">
                <input
                  type="checkbox"
                  checked={settings.watermarkAlertEnabled}
                  onChange={(e) =>
                    setSettings({ ...settings, watermarkAlertEnabled: e.target.checked })
                  }
                />
                <input
                  type="number"
                  min={50}
                  max={99}
                  step={1}
                  className="guard-input"
                  value={settings.watermarkThresholdPct}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      watermarkThresholdPct: Number(e.target.value) || 85
                    })
                  }
                />
              </div>
            </label>

            <label className="guard-field">
              <span className="guard-label">每日预算上限 (USD, 0=关闭)</span>
              <input
                type="number"
                min={0}
                step={0.5}
                className="guard-input"
                value={settings.dailyBudgetUsd}
                onChange={(e) =>
                  setSettings({ ...settings, dailyBudgetUsd: Math.max(0, Number(e.target.value) || 0) })
                }
              />
            </label>

            <label className="guard-field">
              <span className="guard-label">单会话预算上限 (USD, 0=关闭)</span>
              <input
                type="number"
                min={0}
                step={0.5}
                className="guard-input"
                value={settings.sessionBudgetUsd}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    sessionBudgetUsd: Math.max(0, Number(e.target.value) || 0)
                  })
                }
              />
            </label>

            <label className="guard-field">
              <span className="guard-label">超预算处置模式</span>
              <select
                className="guard-input"
                value={settings.budgetGateMode}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    budgetGateMode: e.target.value === 'ask' ? 'ask' : 'warn'
                  })
                }
              >
                <option value="warn">仅内联提醒 (PostInvocation)</option>
                <option value="ask">弹窗二次确认 (PreToolUse)</option>
              </select>
            </label>
          </div>

          <div className="guard-foot">
            <label className="guard-check">
              <input
                type="checkbox"
                checked={settings.limitWatchEnabled}
                onChange={(e) =>
                  setSettings({ ...settings, limitWatchEnabled: e.target.checked })
                }
              />
              <span>
                新会话自动巡检客户端更新是否把上限重置回 256K
                {settings.expectedContextLimit
                  ? `（当前基线 ${Math.round(settings.expectedContextLimit / 1000)}K）`
                  : ''}
              </span>
            </label>

            <div className="guard-actions">
              {savedNotice && (
                <span className="guard-saved">
                  <Check size={13} /> 已保存
                </span>
              )}
              <button type="submit" className="btn-primary-sm" disabled={saving}>
                {saving ? '保存中...' : '保存守卫配置'}
              </button>
            </div>
          </div>
        </form>
      )}
    </section>
  );
}
