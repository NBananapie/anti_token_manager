import fs from 'node:fs';
import {
  loadGuardSettings,
  loadJsonState,
  saveJsonState
} from '../core/plugin-store.mjs';
import { getSingleSessionCostUsd, getTodayTotalCostUsd } from '../core/telemetry.mjs';

const COOLDOWN_MS = 5 * 60 * 1000; // Avoid prompting repeatedly on every tool step

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

function main() {
  const raw = readStdinText();
  const settings = loadGuardSettings();

  // Fast path: 0 DB reads when gate mode is not 'ask' or no budgets are configured
  if (
    settings.budgetGateMode !== 'ask' ||
    (settings.dailyBudgetUsd <= 0 && settings.sessionBudgetUsd <= 0)
  ) {
    outputJson({ decision: 'allow' });
    return;
  }

  let input = {};
  if (raw && raw.trim()) {
    try {
      input = JSON.parse(raw);
    } catch {
      outputJson({ decision: 'allow' });
      return;
    }
  }

  const conversationId = typeof input.conversationId === 'string' ? input.conversationId.trim() : '';
  const toolName = String(input.toolCall?.name || '');

  // Never block our own read-only token telemetry tools so user can inspect budgets freely
  if (toolName.includes('token_get_') || toolName.includes('token_find_') || toolName.includes('token_set_guard')) {
    outputJson({ decision: 'allow' });
    return;
  }

  const state = loadJsonState('budget-gate-state.json', {});
  const lastAskedMs = Number(state[conversationId || '__global__'] || 0);
  if (Date.now() - lastAskedMs < COOLDOWN_MS) {
    outputJson({ decision: 'allow' });
    return;
  }

  const reasons = [];
  if (settings.sessionBudgetUsd > 0 && conversationId) {
    const sessCost = getSingleSessionCostUsd(conversationId);
    if (sessCost >= settings.sessionBudgetUsd) {
      reasons.push(`当前会话估算费用已达 $${sessCost.toFixed(2)}（上限 $${settings.sessionBudgetUsd.toFixed(2)}）`);
    }
  }

  if (settings.dailyBudgetUsd > 0) {
    const todayCost = getTodayTotalCostUsd({ maxCacheAgeMs: 60000 });
    if (todayCost >= settings.dailyBudgetUsd) {
      reasons.push(`今日估算总费用已达 $${todayCost.toFixed(2)}（日预算 $${settings.dailyBudgetUsd.toFixed(2)}）`);
    }
  }

  if (reasons.length === 0) {
    outputJson({ decision: 'allow' });
    return;
  }

  state[conversationId || '__global__'] = Date.now();
  saveJsonState('budget-gate-state.json', state);

  outputJson({
    decision: 'ask',
    reason: `Token 费用预算守卫拦截：${reasons.join('；')}。请确认是否继续执行工具 ${toolName || 'tool'}。`
  });
}

main();
