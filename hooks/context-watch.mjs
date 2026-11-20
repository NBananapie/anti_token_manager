import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSingleSessionWatermark } from '../core/telemetry.mjs';

const DEFAULT_THRESHOLD_PCT = 85;

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

function getDataDir() {
  if (process.env.PLUGIN_DATA && process.env.PLUGIN_DATA.trim()) {
    return path.resolve(process.env.PLUGIN_DATA.trim());
  }
  return path.join(os.tmpdir(), 'antigravity-token-manager-hook');
}

function loadSettings(dataDir) {
  const settingsPath = path.join(dataDir, 'settings.json');
  const defaults = { enabled: true, thresholdPct: DEFAULT_THRESHOLD_PCT };
  if (!fs.existsSync(settingsPath)) return defaults;
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return {
      enabled: parsed.enabled !== false,
      thresholdPct: Number.isFinite(Number(parsed.thresholdPct))
        ? Math.max(50, Math.min(99, Number(parsed.thresholdPct)))
        : DEFAULT_THRESHOLD_PCT
    };
  } catch {
    return defaults;
  }
}

function loadState(statePath) {
  if (!fs.existsSync(statePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveState(statePath, state) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    // Trim old entries to keep state file compact
    const keys = Object.keys(state);
    if (keys.length > 200) {
      for (const k of keys.slice(0, keys.length - 200)) {
        delete state[k];
      }
    }
    const tmp = `${statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, statePath);
  } catch {
    // Non-fatal
  }
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

  const dataDir = getDataDir();
  const settings = loadSettings(dataDir);
  if (!settings.enabled) {
    outputJson({});
    return;
  }

  const watermark = getSingleSessionWatermark(conversationId);
  if (!watermark || watermark.currentContextTokens <= 0) {
    outputJson({});
    return;
  }

  if (watermark.usagePct < settings.thresholdPct) {
    outputJson({});
    return;
  }

  const statePath = path.join(dataDir, 'watermark-state.json');
  const state = loadState(statePath);
  const prevCompactionCount = state[conversationId]?.compactionCount;

  // Alert at most once per compaction cycle for a given conversation
  if (prevCompactionCount === watermark.compactionCount) {
    outputJson({});
    return;
  }

  state[conversationId] = {
    compactionCount: watermark.compactionCount,
    alertedAt: new Date().toISOString(),
    usagePct: watermark.usagePct
  };
  saveState(statePath, state);

  const md = [
    `> 当前会话上下文水位已达 **${watermark.usagePct}%**（约 ${formatK(watermark.currentContextTokens)} / ${watermark.limitLabel}，剩余约 ${formatK(watermark.remainingTokens)}），接近自动压缩阈值。`,
    `> 可点击 [Token & 上下文监控](sidecar://antigravity-token-manager/token-monitor/) 查看实时锯齿波形与缓存命中情况。`
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
    ],
    terminationBehavior: ''
  });
}

main();
