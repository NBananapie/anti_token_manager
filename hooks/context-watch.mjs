import fs from 'node:fs';
import {
  loadGuardSettings,
  loadJsonState,
  saveJsonState
} from '../core/plugin-store.mjs';
import {
  getSingleSessionCostUsd,
  getSingleSessionWatermark,
  getTodayTotalCostUsd,
  toLocalDateKey
} from '../core/telemetry.mjs';

function readStdinText() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function outputJson(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function formatK(tokens) {
  if (!tokens || tokens <= 0) return '0';
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(2)}M`;
  if (tokens >= 1e3) return `${(tokens / 1e3).toFixed(1)}K`;
  return String(tokens);
}

function main() {
  const raw = readStdinText();
  if (!raw || !raw.trim()) {
    outputJson({});
    return;
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    outputJson({});
    return;
  }

  const conversationId = typeof input.conversationId === 'string' ? input.conversationId.trim() : '';
  if (!conversationId) {
    outputJson({});
    return;
  }

  const settings = loadGuardSettings();
  const alerts = [];

  // 1. Context Watermark Alert (once per compaction cycle)
  if (settings.watermarkAlertEnabled) {
    const watermark = getSingleSessionWatermark(conversationId);
    if (watermark && watermark.currentContextTokens > 0 && watermark.usagePct >= settings.watermarkThresholdPct) {
      const wmState = loadJsonState('watermark-state.json', {});
      const prevCompactionCount = wmState[conversationId]?.compactionCount;
      if (prevCompactionCount !== watermark.compactionCount) {
        wmState[conversationId] = {
          compactionCount: watermark.compactionCount,
          alertedAt: new Date().toISOString(),
          usagePct: watermark.usagePct
        };
        const keys = Object.keys(wmState);
        if (keys.length > 200) {
          for (const k of keys.slice(0, keys.length - 200)) delete wmState[k];
        }
        saveJsonState('watermark-state.json', wmState);

        alerts.push(
          `> **上下文高水位提醒**：当前会话已达 **${watermark.usagePct}%**（约 ${formatK(watermark.currentContextTokens)} / ${watermark.limitLabel}，剩余约 ${formatK(watermark.remainingTokens)}），接近自动压缩阈值。`
        );
      }
    }
  }

  // 2. Session & Daily Budget Alerts (once per session / per day)
  if (settings.sessionBudgetUsd > 0 || settings.dailyBudgetUsd > 0) {
    const budgetState = loadJsonState('budget-alert-state.json', { sessions: {}, daily: {} });
    if (!budgetState.sessions) budgetState.sessions = {};
    if (!budgetState.daily) budgetState.daily = {};
    let stateChanged = false;

    if (settings.sessionBudgetUsd > 0) {
      const sessCost = getSingleSessionCostUsd(conversationId);
      const alertedLimit = Number(budgetState.sessions[conversationId] || 0);
      if (sessCost >= settings.sessionBudgetUsd && alertedLimit !== settings.sessionBudgetUsd) {
        budgetState.sessions[conversationId] = settings.sessionBudgetUsd;
        stateChanged = true;
        alerts.push(
          `> **单会话预算提醒**：本会话估算费用已达 **$${sessCost.toFixed(2)}**，超出设定上限 **$${settings.sessionBudgetUsd.toFixed(2)}**。`
        );
      }
    }

    if (settings.dailyBudgetUsd > 0) {
      const todayKey = toLocalDateKey(Date.now());
      const todayCost = getTodayTotalCostUsd({ maxCacheAgeMs: 60000 });
      const alertedLimit = Number(budgetState.daily[todayKey] || 0);
      if (todayCost >= settings.dailyBudgetUsd && alertedLimit !== settings.dailyBudgetUsd) {
        budgetState.daily[todayKey] = settings.dailyBudgetUsd;
        stateChanged = true;
        alerts.push(
          `> **今日费用预算提醒**：今日估算总支出已达 **$${todayCost.toFixed(2)}**，超出设定日预算 **$${settings.dailyBudgetUsd.toFixed(2)}**。`
        );
      }
    }

    if (stateChanged) {
      saveJsonState('budget-alert-state.json', budgetState);
    }
  }

  if (alerts.length === 0) {
    outputJson({});
    return;
  }

  alerts.push(
    `> 可打开 [Token & 上下文监控](sidecar://antigravity-token-manager/token-monitor/) 查看实时波形、单步暴涨归因与预算设置。`
  );

  outputJson({
    injectSteps: [
      {
        systemMessage: {
          systemMessage: '',
          metadata: {
            user_markdown: alerts.join('\n')
          }
        }
      }
    ],
    terminationBehavior: ''
  });
}

main();
