import fs from 'node:fs';
import {
  loadGuardSettings,
  loadJsonState,
  saveGuardSettings,
  saveJsonState
} from '../core/plugin-store.mjs';
import { formatLimitLabel, getContextLimitConfig } from '../core/telemetry.mjs';

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
  // Drain stdin cleanly
  readStdinText();

  const settings = loadGuardSettings();
  if (!settings.limitWatchEnabled) {
    outputJson({});
    return;
  }

  const cfg = getContextLimitConfig();
  if (!cfg.detected) {
    outputJson({});
    return;
  }

  // First-time baseline auto-capture when user already has an upgraded limit (>256K)
  if (settings.expectedContextLimit == null) {
    if (cfg.effectiveLimit > 256000 && cfg.cloudOverrideBypassed) {
      saveGuardSettings({ expectedContextLimit: cfg.effectiveLimit });
    }
    outputJson({});
    return;
  }

  // Only alert when actual effective limit dropped below expected baseline
  if (cfg.effectiveLimit >= settings.expectedContextLimit) {
    outputJson({});
    return;
  }

  const state = loadJsonState('limit-watch-state.json', {});
  const binarySig = `${cfg.binaryMtimeMs || 0}:${cfg.effectiveLimit}`;
  if (state.lastAlertedBinarySig === binarySig) {
    outputJson({});
    return;
  }

  saveJsonState('limit-watch-state.json', {
    lastAlertedBinarySig: binarySig,
    alertedAt: new Date().toISOString(),
    expectedContextLimit: settings.expectedContextLimit,
    actualEffectiveLimit: cfg.effectiveLimit
  });

  const expectedLabel = formatLimitLabel(settings.expectedContextLimit);
  const md = [
    `> **上下文上限巡检预警**：检测到本机 \`language_server\` 当前生效上限已回退为 **${cfg.label}**（预期配置为 **${expectedLabel}**，可能因 Antigravity 客户端自动更新覆盖所致）。`,
    `> 如需恢复，可激活 \`antigravity-token-manager\` 技能执行上限重新配置，或打开 [Token & 上下文监控](sidecar://antigravity-token-manager/token-monitor/) 查看当前状态。`
  ].join('\n');

  outputJson({
    injectSteps: [
      {
        systemMessage: {
          systemMessage: '',
          metadata: {
            user_markdown: md
          }
        }
      }
    ]
  });
}

main();
