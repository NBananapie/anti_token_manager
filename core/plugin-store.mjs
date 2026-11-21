import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PLUGIN_NAME = 'antigravity-token-manager';

export function resolveAntigravityBaseDir() {
  if (process.env.ANTIGRAVITY_DATA_DIR) {
    return path.resolve(process.env.ANTIGRAVITY_DATA_DIR);
  }
  if (process.env.USERPROFILE) {
    return path.join(process.env.USERPROFILE, '.gemini', 'antigravity');
  }
  if (process.env.HOME) {
    return path.join(process.env.HOME, '.gemini', 'antigravity');
  }
  return path.join(os.homedir(), '.gemini', 'antigravity');
}

/**
 * Resolves the unified persistent plugin data directory shared across
 * Hooks, MCP server, and Sidecar UI (~/.gemini/antigravity/plugin_data/antigravity-token-manager).
 */
export function getPluginDataDir() {
  if (process.env.PLUGIN_DATA && process.env.PLUGIN_DATA.trim()) {
    return path.resolve(process.env.PLUGIN_DATA.trim());
  }
  return path.join(resolveAntigravityBaseDir(), 'plugin_data', PLUGIN_NAME);
}

export const DEFAULT_GUARD_SETTINGS = {
  watermarkAlertEnabled: true,
  watermarkThresholdPct: 85,
  limitWatchEnabled: true,
  expectedContextLimit: null,
  dailyBudgetUsd: 0,
  sessionBudgetUsd: 0,
  budgetGateMode: 'warn' // 'warn' | 'ask'
};

function atomicWriteJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

export function loadJsonState(filename, fallback = {}) {
  const filePath = path.join(getPluginDataDir(), filename);
  if (!fs.existsSync(filePath)) return fallback;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function saveJsonState(filename, data) {
  try {
    const filePath = path.join(getPluginDataDir(), filename);
    atomicWriteJson(filePath, data);
    return true;
  } catch {
    return false;
  }
}

export function sanitizeGuardSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};

  // Backward compatibility with legacy settings.json keys (enabled / thresholdPct)
  const watermarkAlertEnabled =
    src.watermarkAlertEnabled !== undefined
      ? Boolean(src.watermarkAlertEnabled)
      : src.enabled !== undefined
        ? Boolean(src.enabled)
        : DEFAULT_GUARD_SETTINGS.watermarkAlertEnabled;

  const rawThreshold = src.watermarkThresholdPct !== undefined ? src.watermarkThresholdPct : src.thresholdPct;
  const numThreshold = Number(rawThreshold);
  const watermarkThresholdPct = Number.isFinite(numThreshold)
    ? Math.max(50, Math.min(99, Math.round(numThreshold)))
    : DEFAULT_GUARD_SETTINGS.watermarkThresholdPct;

  const limitWatchEnabled =
    src.limitWatchEnabled !== undefined
      ? Boolean(src.limitWatchEnabled)
      : DEFAULT_GUARD_SETTINGS.limitWatchEnabled;

  const rawExpected = src.expectedContextLimit;
  const numExpected = Number(rawExpected);
  const expectedContextLimit =
    rawExpected != null && rawExpected !== '' && Number.isFinite(numExpected) && numExpected >= 64000
      ? Math.round(numExpected)
      : null;

  const rawDaily = Number(src.dailyBudgetUsd);
  const dailyBudgetUsd = Number.isFinite(rawDaily) && rawDaily >= 0
    ? Number(rawDaily.toFixed(2))
    : DEFAULT_GUARD_SETTINGS.dailyBudgetUsd;

  const rawSession = Number(src.sessionBudgetUsd);
  const sessionBudgetUsd = Number.isFinite(rawSession) && rawSession >= 0
    ? Number(rawSession.toFixed(2))
    : DEFAULT_GUARD_SETTINGS.sessionBudgetUsd;

  const budgetGateMode = src.budgetGateMode === 'ask' ? 'ask' : 'warn';

  return {
    watermarkAlertEnabled,
    watermarkThresholdPct,
    limitWatchEnabled,
    expectedContextLimit,
    dailyBudgetUsd,
    sessionBudgetUsd,
    budgetGateMode
  };
}

export function loadGuardSettings() {
  const raw = loadJsonState('settings.json', {});
  return sanitizeGuardSettings(raw);
}

export function saveGuardSettings(patch) {
  const current = loadGuardSettings();
  const merged = sanitizeGuardSettings({ ...current, ...(patch || {}) });
  saveJsonState('settings.json', merged);
  return merged;
}

// --- Tool Trace Storage for Single-Step Token Bloat Attribution ---
const MAX_TRACE_FILES = 80;
const MAX_TRACE_LINES_READ = 600;

export function getToolTracePath(conversationId) {
  if (!conversationId || /[\\/:\0]/.test(conversationId)) return null;
  return path.join(getPluginDataDir(), 'tool-trace', `${conversationId}.jsonl`);
}

export function appendToolTrace(conversationId, entry) {
  const filePath = getToolTracePath(conversationId);
  if (!filePath) return;
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');

    // Light probabilistic pruning to keep directory bounded
    if (Math.random() < 0.05) {
      const files = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => {
          const full = path.join(dir, f);
          try {
            return { full, mtimeMs: fs.statSync(full).mtimeMs };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const stale of files.slice(MAX_TRACE_FILES)) {
        try { fs.rmSync(stale.full, { force: true }); } catch {}
      }
    }
  } catch {
    // Non-fatal
  }
}

export function readToolTraces(conversationId) {
  const filePath = getToolTracePath(conversationId);
  if (!filePath || !fs.existsSync(filePath)) return [];
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    const tail = lines.length > MAX_TRACE_LINES_READ ? lines.slice(-MAX_TRACE_LINES_READ) : lines;
    const out = [];
    for (const line of tail) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object') out.push(parsed);
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}
