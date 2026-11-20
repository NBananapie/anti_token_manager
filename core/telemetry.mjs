import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

export function resolveAntigravityDataDir() {
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

export const BASE_DIR = resolveAntigravityDataDir();
export const SUMMARIES_DB_PATH = path.join(BASE_DIR, 'conversation_summaries.db');
export const CONVERSATIONS_DIR = path.join(BASE_DIR, 'conversations');
export const ANNOTATIONS_DIR = path.join(BASE_DIR, 'annotations');

// --- Model Pricing Table (Synced with scripts/gemini_pricing.json) ---
export const FALLBACK_PRICING = {
  'gemini-3.8-flash': { input: 0.75, cache_read: 0.075, output: 3.75 },
  'gemini-4-neon': { input: 3.0, cache_read: 0.15, output: 15.0 },
  'gemini-4-carbon': { input: 2.0, cache_read: 0.1, output: 10.0 },
  'gemini-4-argon': { input: 2.0, cache_read: 0.1, output: 10.0 },
  'gemini-4-hydrogen': { input: 1.5, cache_read: 0.075, output: 7.5 },
  'gemini-pro-orchestrator': { input: 2.0, cache_read: 0.1, output: 10.0 },
  'gemini-pro-orchestrator-argon': { input: 2.0, cache_read: 0.1, output: 10.0 },
  'gemini-pro-orchestrator-neon': { input: 3.0, cache_read: 0.15, output: 15.0 },
  'gemini-3.5-flash-lite': { input: 0.3, cache_read: 0.03, output: 2.5 },
  'gemini-3.1-pro': { input: 2.0, cache_read: 0.2, output: 12.0 },
  'gpt-oss-120b': { input: 0.15, cache_read: 0.075, output: 0.6 },
  'claude-opus-5-5': { input: 4.0, cache_read: 0.2, output: 20.0 },
  'claude-sonnet-5-5': { input: 2.0, cache_read: 0.1, output: 10.0 },
  'claude-opus-4-6': { input: 5.0, cache_read: 0.5, output: 25.0 },
  'claude-opus-4': { input: 15.0, cache_read: 1.5, output: 75.0 },
  'claude-sonnet-4.6': { input: 3.0, cache_read: 0.3, output: 15.0 },
  'claude-haiku-4-5': { input: 1.0, cache_read: 0.1, output: 5.0 }
};

function loadPricingTable() {
  const table = { ...FALLBACK_PRICING };
  const candidates = [
    path.join(REPO_ROOT, 'scripts', 'gemini_pricing.json'),
    path.join(REPO_ROOT, 'skills', 'antigravity-token-manager', 'scripts', 'gemini_pricing.json')
  ];
  for (const pricingPath of candidates) {
    try {
      if (fs.existsSync(pricingPath)) {
        const parsed = JSON.parse(fs.readFileSync(pricingPath, 'utf-8'));
        if (parsed && typeof parsed === 'object') {
          for (const [k, v] of Object.entries(parsed)) {
            if (v && typeof v === 'object') table[k] = { ...(table[k] || {}), ...v };
          }
        }
        break;
      }
    } catch {
      // Fallback to built-in table
    }
  }
  return table;
}

export const PRICING_TABLE = loadPricingTable();

// Authoritative Model enum ID -> { base, tier } synced with scripts/pricing.py
export const MODEL_ENUM_INFO = {
  // Anthropic Claude series
  281: { base: 'claude-sonnet-4', tier: null },
  282: { base: 'claude-sonnet-4', tier: 'Thinking' },
  290: { base: 'claude-opus-4', tier: null },
  291: { base: 'claude-opus-4', tier: 'Thinking' },
  333: { base: 'claude-sonnet-4-5', tier: null },
  334: { base: 'claude-sonnet-4-5', tier: 'Thinking' },
  340: { base: 'claude-haiku-4-5', tier: null },
  341: { base: 'claude-haiku-4-5', tier: 'Thinking' },
  1011: { base: 'claude-opus-4-5', tier: null },
  1012: { base: 'claude-opus-4-5', tier: 'Thinking' },
  1026: { base: 'claude-opus-4-6', tier: 'Thinking' },
  1035: { base: 'claude-sonnet-4-6', tier: 'Thinking' },
  1254: { base: 'claude-opus-4-8', tier: null },
  1368: { base: 'claude-opus-5-5', tier: 'High' },
  1400: { base: 'claude-opus-5-5', tier: 'Low' },
  1401: { base: 'claude-opus-5-5', tier: 'Medium' },
  1402: { base: 'claude-opus-5-5', tier: 'High' },
  1406: { base: 'claude-opus-5-5', tier: 'Max' },
  1403: { base: 'claude-sonnet-5-5', tier: 'Low' },
  1404: { base: 'claude-sonnet-5-5', tier: 'Medium' },
  1405: { base: 'claude-sonnet-5-5', tier: 'High' },
  1407: { base: 'claude-sonnet-5-5', tier: 'Max' },
  // Google Gemini series
  246: { base: 'gemini-2.5-pro', tier: null },
  312: { base: 'gemini-2.5-flash', tier: null },
  313: { base: 'gemini-2.5-flash', tier: null },
  327: { base: 'gemini-2.5-pro', tier: null },
  329: { base: 'gemini-2.5-flash', tier: null },
  330: { base: 'gemini-2.5-flash-lite', tier: null },
  331: { base: 'gemini-2.5-pro', tier: null },
  348: { base: 'gemini-3.1-pro', tier: null },
  352: { base: 'gemini-3.1-pro', tier: null },
  353: { base: 'gemini-3.1-pro', tier: null },
  1009: { base: 'gemini-3-pro-image', tier: null },
  1018: { base: 'gemini-3-flash', tier: null },
  1020: { base: 'gemini-3.5-flash', tier: 'Low' },
  1021: { base: 'gemini-3.1-flash-image', tier: null },
  1036: { base: 'gemini-3.1-pro', tier: 'Low' },
  1050: { base: 'gemini-3.1-flash-lite', tier: null },
  1059: { base: 'gemini-3.1-flash', tier: null },
  1071: { base: 'gemini-3.6-flash', tier: 'High' },
  1072: { base: 'gemini-3.6-flash', tier: 'Medium' },
  1073: { base: 'gemini-3.6-flash', tier: 'Low' },
  1149: { base: 'gemini-3.5-flash', tier: null },
  1187: { base: 'gemini-3.5-flash', tier: 'Low' },
  1196: { base: 'gemini-3.6-flash', tier: null },
  1198: { base: 'gemini-3.5-flash-lite', tier: null },
  1298: { base: 'gemini-3.7-flash', tier: 'High' },
  1299: { base: 'gemini-3.7-flash', tier: 'Medium' },
  1300: { base: 'gemini-3.7-flash', tier: 'Low' },
  1318: { base: 'gemini-3.8-flash', tier: 'High' },
  1319: { base: 'gemini-3.8-flash', tier: 'Medium' },
  1320: { base: 'gemini-3.8-flash', tier: 'Low' },
  1322: { base: 'gemini-3.8-flash-tiered', tier: 'High' },
  1415: { base: 'gemini-4-argon', tier: 'Low' },
  1416: { base: 'gemini-4-argon', tier: 'Medium' },
  1417: { base: 'gemini-4-argon', tier: 'High' },
  1418: { base: 'gemini-4-argon', tier: 'Medium' },
  1419: { base: 'gemini-4-argon', tier: 'Low' },
  1427: { base: 'gemini-4-carbon', tier: 'High' },
  1429: { base: 'gemini-4-carbon', tier: 'High' },
  1430: { base: 'gemini-4-carbon', tier: 'Medium' },
  1431: { base: 'gemini-4-carbon', tier: 'Low' },
  1437: { base: 'gemini-4-carbon', tier: 'Medium' },
  1525: { base: 'gemini-4-hydrogen', tier: 'High' },
  1526: { base: 'gemini-4-hydrogen', tier: 'Medium' },
  1530: { base: 'gemini-4-hydrogen-tiered', tier: 'High' },
  1532: { base: 'gemini-4-neon', tier: 'High' },
  1533: { base: 'gemini-4-neon', tier: 'Medium' },
  1535: { base: 'gemini-4-neon', tier: 'XHigh' },
  1537: { base: 'gemini-pro-orchestrator', tier: 'Neon' },
  1667: { base: 'gemini-pro-orchestrator', tier: 'Carbon' },
  1669: { base: 'gemini-flash-worker-agy', tier: 'Worker' }
};

export function resolveModelWithTier(rawBackendModel, modelEnum) {
  const enumInfo = modelEnum != null ? MODEL_ENUM_INFO[modelEnum] : null;
  let base = (rawBackendModel || '').trim();
  let tier = enumInfo?.tier || null;

  if (!base) {
    if (enumInfo) {
      base = enumInfo.base;
    } else {
      return { model: 'unknown', rawModel: 'unknown', tier: null };
    }
  } else {
    const orchMatch = base.match(/^(gemini-pro-orchestrator)-(neon|argon|carbon)$/i);
    if (orchMatch) {
      const sub = orchMatch[2].toLowerCase();
      if (!tier) tier = sub.charAt(0).toUpperCase() + sub.slice(1);
      base = orchMatch[1];
    }
    const suffixMatch = base.match(/-(xhigh|high|medium|low|max|thinking)$/i);
    if (suffixMatch) {
      const extracted = suffixMatch[1].toLowerCase();
      const normalizedTier =
        extracted === 'xhigh'
          ? 'XHigh'
          : extracted.charAt(0).toUpperCase() + extracted.slice(1);
      if (!tier) tier = normalizedTier;
      base = base.slice(0, -suffixMatch[0].length);
    }
    if (base.toLowerCase().includes('safety')) {
      tier = null;
    }
  }

  const label = tier ? `${base} (${tier})` : base;
  return { model: label, rawModel: rawBackendModel || base, tier };
}

export function mapModelToPricingKey(modelName) {
  if (!modelName) return 'gemini-3.8-flash';
  const mn = String(modelName).toLowerCase();
  if (mn.includes('haiku')) return 'claude-haiku-4-5';
  if (mn.includes('opus')) {
    if (['opus-4-5', 'opus 4.5', 'opus-4-6', 'opus 4.6', 'opus-4-8', 'opus 4.8'].some(v => mn.includes(v))) {
      return 'claude-opus-4-6';
    }
    if (['opus-4@', 'opus 4'].some(v => mn.includes(v)) && !mn.includes('5.5') && !mn.includes('5-5')) {
      return 'claude-opus-4';
    }
    return 'claude-opus-5-5';
  }
  if (mn.includes('sonnet')) {
    return (mn.includes('sonnet-5') || mn.includes('sonnet 5')) ? 'claude-sonnet-5-5' : 'claude-sonnet-4.6';
  }
  if (mn.includes('claude') || mn.includes('anthropic')) return 'claude-sonnet-5-5';
  if (mn.includes('orchestrator')) {
    if (mn.includes('neon')) return 'gemini-pro-orchestrator-neon';
    return (mn.includes('argon') || mn.includes('g1-pro')) ? 'gemini-pro-orchestrator-argon' : 'gemini-pro-orchestrator';
  }
  if (mn.includes('neon')) return 'gemini-4-neon';
  if (mn.includes('hydrogen')) return 'gemini-4-hydrogen';
  if (mn.includes('carbon')) return 'gemini-4-carbon';
  if (mn.includes('argon') || mn.includes('gemini-4') || mn.includes('gemini 4')) return 'gemini-4-argon';
  if (mn.includes('gpt-oss') || mn.includes('120b')) return 'gpt-oss-120b';
  if (mn.includes('lite')) return 'gemini-3.5-flash-lite';
  if (mn.includes('pro')) return 'gemini-3.1-pro';
  return 'gemini-3.8-flash';
}

export function computeTurnCostDetails(modelName, inputTokens, cacheReadTokens, outputTokens) {
  const key = mapModelToPricingKey(modelName);
  const p = PRICING_TABLE[key] || FALLBACK_PRICING['gemini-3.8-flash'];
  const cIn = ((inputTokens || 0) / 1e6) * p.input;
  const cCache = ((cacheReadTokens || 0) / 1e6) * p.cache_read;
  const cOut = ((outputTokens || 0) / 1e6) * p.output;
  const costUsd = cIn + cCache + cOut;
  const uncachedCacheCost = ((cacheReadTokens || 0) / 1e6) * p.input;
  const cacheSavingsUsd = Math.max(0, uncachedCacheCost - cCache);
  return { costUsd, cacheSavingsUsd };
}

// --- Read-Only Language Server Context Limit Detection (Cached by mtime) ---
let cachedContextConfig = null;
let cachedBinaryMtime = 0;

export function findLanguageServerBinary() {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const candidates = [
      path.join(localAppData, 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe'),
      path.join(localAppData, 'Programs', 'Antigravity', 'resources', 'bin', 'language_server.exe'),
      path.join(localAppData, 'Programs', 'Antigravity', 'resources', 'app', 'bin', 'language_server.exe'),
      path.join(localAppData, 'Antigravity', 'bin', 'language_server.exe'),
      path.join(programFiles, 'Antigravity', 'resources', 'app', 'bin', 'language_server.exe')
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }
  const macPath = '/Applications/Antigravity.app/Contents/Resources/bin/language_server';
  return fs.existsSync(macPath) ? macPath : null;
}

export function formatLimitLabel(limit) {
  if (limit >= 840000) return '1M (840K)';
  if (limit >= 1000 && limit % 1000 === 0) return `${limit / 1000}K`;
  return `${Math.round(limit / 1000)}K`;
}

export function getContextLimitConfig() {
  const defaultCfg = {
    detected: false,
    effectiveLimit: 256000,
    configuredLimit: 256000,
    cloudOverrideBypassed: false,
    label: '256K',
    binaryPath: null
  };

  try {
    const binPath = findLanguageServerBinary();
    if (!binPath) return defaultCfg;
    const stat = fs.statSync(binPath);
    if (cachedContextConfig && cachedBinaryMtime === stat.mtimeMs) {
      return cachedContextConfig;
    }

    const buf = fs.readFileSync(binPath);

    // Pattern 1: mov edx, [rsp+0x4c]; cmp edx, <LIMIT>; mov esi, <LIMIT>; ...
    const p1Prefix = Buffer.from([0x8b, 0x54, 0x24, 0x4c, 0x81, 0xfa]);
    let clampLimit = 256000;
    const idx1 = buf.indexOf(p1Prefix);
    if (idx1 !== -1 && idx1 + 16 < buf.length && buf[idx1 + 10] === 0xbe) {
      clampLimit = buf.readUInt32LE(idx1 + 6);
    }

    // Pattern 3: (*overlayFeatureProvider).GetProto bypass check (eb 29)
    const p3Suffix = Buffer.from([
      0x48, 0x8b, 0x54, 0x24, 0x38, 0x4c, 0x8b, 0x42, 0x10,
      0x48, 0x8b, 0x42, 0x18, 0x49, 0x8b, 0x50, 0x38
    ]);
    const p3Bypassed = buf.indexOf(Buffer.concat([Buffer.from([0x84, 0xdb, 0xeb, 0x29]), p3Suffix])) !== -1;

    // Pattern 4: (*snapshotFallbackFactory).NewProvider HasNoCCPAAccess bypass check
    const p4NewBypass = Buffer.from([
      0x48, 0x8b, 0x50, 0x38, 0x48, 0x8b, 0x02, 0xff, 0xd0, 0x84, 0xc0,
      0x90, 0x90, 0x90, 0x90, 0x90, 0x90,
      0x48, 0x8b, 0x44, 0x24, 0x50, 0x48, 0x8b, 0x50, 0x40, 0x48, 0x8b, 0x0a
    ]);
    const p4OldBypass = Buffer.from([
      0x48, 0x8b, 0x50, 0x28, 0x48, 0x8b, 0x02, 0xff, 0xd0, 0x84, 0xc0,
      0x90, 0x90,
      0x48, 0x8b, 0x54, 0x24, 0x40, 0x48, 0x8b, 0x72, 0x10
    ]);
    const p4Bypassed = buf.indexOf(p4NewBypass) !== -1 || buf.indexOf(p4OldBypass) !== -1;
    const cloudOverrideBypassed = p3Bypassed && p4Bypassed;
    const effectiveLimit = cloudOverrideBypassed ? clampLimit : Math.min(clampLimit, 256000);

    cachedContextConfig = {
      detected: true,
      effectiveLimit,
      configuredLimit: clampLimit,
      cloudOverrideBypassed,
      label: formatLimitLabel(effectiveLimit),
      binaryPath: binPath
    };
    cachedBinaryMtime = stat.mtimeMs;
    return cachedContextConfig;
  } catch {
    return defaultCfg;
  }
}

// --- Local Date / Time Formatting Helpers ---
export function toLocalDateKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function getRangeBounds(rangeStr, exactDateStr) {
  const now = new Date();
  if (exactDateStr && /^\d{4}-\d{2}-\d{2}$/.test(exactDateStr)) {
    const [y, m, d] = exactDateStr.split('-').map(Number);
    const start = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
    const end = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
    return { startMs: start, endMs: end, range: 'date', date: exactDateStr };
  }

  const r = (rangeStr || '7d').toLowerCase();
  if (r === 'all') {
    return { startMs: null, endMs: null, range: 'all', date: null };
  }
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  if (r === 'today') {
    return { startMs: todayStart.getTime(), endMs: null, range: 'today', date: null };
  }
  if (r === '30d') {
    const start = new Date(todayStart);
    start.setDate(start.getDate() - 29);
    return { startMs: start.getTime(), endMs: null, range: '30d', date: null };
  }
  const start = new Date(todayStart);
  start.setDate(start.getDate() - 6);
  return { startMs: start.getTime(), endMs: null, range: '7d', date: null };
}

// --- Protobuf Decoders for gen_metadata and steps ---
function readVarint(b, pos) {
  let bigVal = 0n;
  let shift = 0n;
  let bVal;
  do {
    if (pos >= b.length) return { val: Number(bigVal), pos, error: true };
    bVal = b[pos++];
    bigVal |= BigInt(bVal & 0x7f) << shift;
    shift += 7n;
    if (shift > 70n) return { val: 0, pos, error: true };
  } while (bVal & 0x80);
  return { val: Number(BigInt.asIntN(64, bigVal)), pos };
}

function parseDurationSeconds(sub) {
  let pos = 0;
  let sec = 0;
  let nanos = 0;
  let hasField = false;
  while (pos < sub.length) {
    const t = readVarint(sub, pos);
    if (t.error) break;
    pos = t.pos;
    const fNum = t.val >> 3;
    const wType = t.val & 7;
    if (wType === 0) {
      const v = readVarint(sub, pos);
      if (v.error) break;
      pos = v.pos;
      if (fNum === 1) { sec = v.val; hasField = true; }
      if (fNum === 2) { nanos = v.val; hasField = true; }
    } else if (wType === 2) {
      const sl = readVarint(sub, pos);
      if (sl.error) break;
      pos = sl.pos + sl.val;
    } else if (wType === 1) pos += 8;
    else if (wType === 5) pos += 4;
    else break;
  }
  if (!hasField) return null;
  const total = sec + nanos / 1e9;
  return total >= 0 ? total : 0;
}

function parseTimestampMs(sub) {
  const secs = parseDurationSeconds(sub);
  if (secs === null || secs < 1577836800) return null;
  return Math.round(secs * 1000);
}

function parseStepMetadataBlob(buf) {
  if (!buf || !buf.length) return null;
  let pos = 0;
  let timestampMs = null;
  let tsFirstMs = null;
  let tsDoneMs = null;
  let stepEnum = null;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let thinkingTokens = 0;
  let responseTokens = 0;
  let botId = null;

  try {
    while (pos < buf.length) {
      const t = readVarint(buf, pos);
      if (t.error) break;
      pos = t.pos;
      const field = t.val >> 3;
      const wire = t.val & 7;
      if (wire === 0) {
        const v = readVarint(buf, pos);
        if (v.error) break;
        pos = v.pos;
        if (field === 11) stepEnum = v.val;
      } else if (wire === 2) {
        const l = readVarint(buf, pos);
        if (l.error) break;
        const sub = buf.subarray(l.pos, l.pos + l.val);
        pos = l.pos + l.val;
        if (field === 1) timestampMs = parseTimestampMs(sub);
        else if (field === 6) tsFirstMs = parseTimestampMs(sub);
        else if (field === 7) tsDoneMs = parseTimestampMs(sub);
        else if (field === 9) {
          let p9 = 0;
          while (p9 < sub.length) {
            const st = readVarint(sub, p9);
            if (st.error) break;
            p9 = st.pos;
            const sfn = st.val >> 3;
            const swt = st.val & 7;
            if (swt === 0) {
              const v = readVarint(sub, p9);
              if (v.error) break;
              p9 = v.pos;
              if (sfn === 1 && stepEnum === null) stepEnum = v.val;
              else if (sfn === 2) inputTokens = v.val;
              else if (sfn === 3) outputTokens = v.val;
              else if (sfn === 5) cacheReadTokens = v.val;
              else if (sfn === 9) thinkingTokens = v.val;
              else if (sfn === 10) responseTokens = v.val;
            } else if (swt === 2) {
              const sl = readVarint(sub, p9);
              if (sl.error) break;
              if (sfn === 7) {
                botId = sub.subarray(sl.pos, sl.pos + sl.val).toString('utf-8');
              }
              p9 = sl.pos + sl.val;
            } else if (swt === 1) p9 += 8;
            else if (swt === 5) p9 += 4;
            else break;
          }
        }
      } else if (wire === 1) pos += 8;
      else if (wire === 5) pos += 4;
      else break;
    }
    return {
      timestampMs,
      tsFirstMs,
      tsDoneMs,
      stepEnum,
      inputTokens,
      cacheReadTokens,
      outputTokens,
      thinkingTokens,
      responseTokens,
      botId
    };
  } catch {
    return null;
  }
}

function finalizeSpeedAcc(acc) {
  const avgTtftSec = acc.ttftCount > 0 ? Number((acc.ttftSum / acc.ttftCount).toFixed(2)) : null;
  const streamTps = acc.streamSecSum > 0 ? Number((acc.streamTokSum / acc.streamSecSum).toFixed(1)) : null;
  const e2eTps = acc.e2eSecSum > 0 ? Number((acc.e2eTokSum / acc.e2eSecSum).toFixed(1)) : null;
  const thinkingSharePct = acc.outTokSum > 0 ? Number(((acc.thinkTokSum / acc.outTokSum) * 100).toFixed(1)) : 0;
  return {
    avgTtftSec,
    streamTps,
    e2eTps,
    thinkingSharePct
  };
}

function createSpeedAcc() {
  return {
    ttftSum: 0,
    ttftCount: 0,
    streamTokSum: 0,
    streamSecSum: 0,
    e2eTokSum: 0,
    e2eSecSum: 0,
    thinkTokSum: 0,
    outTokSum: 0
  };
}

function addTurnToSpeedAcc(acc, turn) {
  acc.thinkTokSum += turn.thinkingTokens || 0;
  acc.outTokSum += turn.outputTokens || 0;
  if (turn.totalSec !== null && turn.totalSec > 0) {
    if (turn.ttftSec !== null) {
      acc.ttftSum += turn.ttftSec;
      acc.ttftCount += 1;
    }
    if (turn.outputTokens > 0) {
      acc.e2eTokSum += turn.outputTokens;
      acc.e2eSecSum += turn.totalSec;
    }
    if (turn.streamSec !== null && turn.streamSec >= 0.5 && turn.responseTokens > 0) {
      acc.streamTokSum += turn.responseTokens;
      acc.streamSecSum += turn.streamSec;
    }
  }
}

function parseGenMetadataBlob(buf) {
  try {
    let pos = 0;
    let f1 = null;
    while (pos < buf.length) {
      const t = readVarint(buf, pos);
      if (t.error) break;
      pos = t.pos;
      const wire = t.val & 7;
      const field = t.val >> 3;
      if (wire === 2) {
        const l = readVarint(buf, pos);
        if (l.error) break;
        pos = l.pos;
        if (field === 1) f1 = buf.subarray(pos, pos + l.val);
        pos += l.val;
      } else if (wire === 0) {
        const v = readVarint(buf, pos);
        if (v.error) break;
        pos = v.pos;
      } else if (wire === 1) pos += 8;
      else if (wire === 5) pos += 4;
      else break;
    }

    if (!f1) return null;

    let model = null;
    let modelEnum = null;
    let botId = null;
    let inputTokens = 0;
    let cacheReadTokens = 0;
    let outputTokens = 0;
    let thinkingTokens = 0;
    let responseTokens = 0;
    let ttftSec = null;
    let streamSec = null;
    const metadataMap = {};

    pos = 0;
    while (pos < f1.length) {
      const t = readVarint(f1, pos);
      if (t.error) break;
      pos = t.pos;
      const field = t.val >> 3;
      const wire = t.val & 7;
      if (wire === 2) {
        const l = readVarint(f1, pos);
        if (l.error) break;
        const sub = f1.subarray(l.pos, l.pos + l.val);
        pos = l.pos + l.val;

        if (field === 19) {
          model = sub.toString('utf-8');
        } else if (field === 11) {
          ttftSec = parseDurationSeconds(sub);
        } else if (field === 12) {
          streamSec = parseDurationSeconds(sub);
        } else if (field === 20) {
          let pSub = 0;
          let k = '';
          let v = '';
          while (pSub < sub.length) {
            const st = readVarint(sub, pSub);
            if (st.error) break;
            pSub = st.pos;
            const sl = readVarint(sub, pSub);
            if (sl.error) break;
            const sVal = sub.subarray(sl.pos, sl.pos + sl.val).toString('utf-8');
            pSub = sl.pos + sl.val;
            if ((st.val >> 3) === 1) k = sVal;
            if ((st.val >> 3) === 2) v = sVal;
          }
          if (k) metadataMap[k] = v;
        } else if (field === 4) {
          let p4 = 0;
          while (p4 < sub.length) {
            const st = readVarint(sub, p4);
            if (st.error) break;
            p4 = st.pos;
            const fNum = st.val >> 3;
            const wType = st.val & 7;
            if (wType === 0) {
              const v = readVarint(sub, p4);
              if (v.error) break;
              p4 = v.pos;
              if (fNum === 1 && modelEnum === null) modelEnum = v.val;
              if (fNum === 2) inputTokens = v.val;
              if (fNum === 3) outputTokens = v.val;
              if (fNum === 5) cacheReadTokens = v.val;
              if (fNum === 9) thinkingTokens = v.val;
              if (fNum === 10) responseTokens = v.val;
            } else if (wType === 2) {
              const sl = readVarint(sub, p4);
              if (sl.error) break;
              if (fNum === 7) {
                botId = sub.subarray(sl.pos, sl.pos + sl.val).toString('utf-8');
              }
              p4 = sl.pos + sl.val;
            } else if (wType === 1) p4 += 8;
            else if (wType === 5) p4 += 4;
            else break;
          }
        }
      } else if (wire === 0) {
        const v = readVarint(f1, pos);
        if (v.error) break;
        pos = v.pos;
        if (field === 3) modelEnum = v.val;
      } else if (wire === 1) pos += 8;
      else if (wire === 5) pos += 4;
      else break;
    }

    if (thinkingTokens === 0 && responseTokens === 0 && outputTokens > 0) {
      responseTokens = outputTokens;
    }
    const totalSec = (ttftSec !== null && streamSec !== null) ? (ttftSec + streamSec) : null;
    const streamTps = (streamSec !== null && streamSec >= 0.5 && responseTokens > 0)
      ? Number((responseTokens / streamSec).toFixed(1))
      : null;
    const e2eTps = (totalSec !== null && totalSec > 0 && outputTokens > 0)
      ? Number((outputTokens / totalSec).toFixed(1))
      : null;

    return {
      model: model || null,
      modelEnum,
      botId,
      inputTokens,
      cacheReadTokens,
      outputTokens,
      thinkingTokens,
      responseTokens,
      ttftSec: ttftSec !== null ? Number(ttftSec.toFixed(3)) : null,
      streamSec: streamSec !== null ? Number(streamSec.toFixed(3)) : null,
      totalSec: totalSec !== null ? Number(totalSec.toFixed(3)) : null,
      streamTps,
      e2eTps,
      metadataMap
    };
  } catch {
    return null;
  }
}

// In-memory cache for parsed sessions
const sessionCache = new Map();
let masterIndexCache = null;
let lastMasterCacheTime = 0;

export function invalidateMasterIndexCache() {
  masterIndexCache = null;
}

export function getSessionModelStats(conversationId) {
  if (!conversationId || /[\\/:\0]/.test(conversationId)) return null;
  const dbFile = path.join(CONVERSATIONS_DIR, `${conversationId}.db`);
  if (!fs.existsSync(dbFile)) return null;

  try {
    const stat = fs.statSync(dbFile);
    const walFile = `${dbFile}-wal`;
    let walSig = '0';
    let effectiveMtimeMs = stat.mtimeMs;
    if (fs.existsSync(walFile)) {
      try {
        const wStat = fs.statSync(walFile);
        walSig = `${wStat.mtimeMs}:${wStat.size}`;
        if (wStat.mtimeMs > effectiveMtimeMs) effectiveMtimeMs = wStat.mtimeMs;
      } catch {}
    }
    const cacheKey = `${stat.mtimeMs}:${stat.size}:${walSig}`;
    const cached = sessionCache.get(conversationId);
    if (cached && cached.cacheKey === cacheKey) {
      return cached.data;
    }

    const db = new DatabaseSync(dbFile, { open: true, readOnly: true });
    let genRows = [];
    let plannerSteps = [];
    let rawCheckpoints = [];
    try {
      genRows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
    } catch {}
    try {
      plannerSteps = db.prepare('SELECT idx, metadata FROM steps WHERE step_type = 15 AND metadata IS NOT NULL ORDER BY idx ASC').all();
      rawCheckpoints = db.prepare('SELECT idx, metadata FROM steps WHERE step_type = 23 ORDER BY idx ASC').all();
    } catch {}
    db.close();

    const botToStep = new Map();
    const parsedSteps = [];
    for (const s of plannerSteps) {
      const sp = parseStepMetadataBlob(Buffer.from(s.metadata));
      if (!sp) continue;
      const entry = { stepIndex: s.idx, ...sp };
      parsedSteps.push(entry);
      if (sp.botId) {
        botToStep.set(sp.botId, entry);
      }
    }

    const generations = [];
    const matchedStepIndices = new Set();
    const modelCounts = {};
    let totalInputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalOutputTokens = 0;
    let totalThinkingTokens = 0;
    let totalResponseTokens = 0;
    let estimatedCostUsd = 0;
    let cacheSavingsUsd = 0;
    let peakContextTokens = 0;
    let currentContextTokens = 0;
    let firstTimestampMs = null;
    let lastTimestampMs = null;
    const sessionAcc = createSpeedAcc();

    for (let i = 0; i < genRows.length; i++) {
      const r = genRows[i];
      const parsed = parseGenMetadataBlob(Buffer.from(r.data));
      if (!parsed) continue;

      let linkedStep = parsed.botId ? botToStep.get(parsed.botId) : null;
      if (!linkedStep && parsed.metadataMap?.last_step_index) {
        const targetIdx = Number(parsed.metadataMap.last_step_index);
        if (!Number.isNaN(targetIdx)) {
          linkedStep = parsedSteps.find(ps => ps.stepIndex === targetIdx) || null;
        }
      }
      if (!linkedStep && parsedSteps[i]) {
        linkedStep = parsedSteps[i];
      }

      const stepIndex = linkedStep ? linkedStep.stepIndex : (Number(parsed.metadataMap?.last_step_index) || r.idx);
      if (linkedStep) matchedStepIndices.add(linkedStep.stepIndex);
      const effEnum = linkedStep?.stepEnum ?? parsed.modelEnum ?? null;
      const { model: resolvedModel, tier: modelTier } = resolveModelWithTier(parsed.model, effEnum);
      const timestampMs = linkedStep?.timestampMs || Math.round(effectiveMtimeMs);
      if (firstTimestampMs === null || timestampMs < firstTimestampMs) firstTimestampMs = timestampMs;
      if (lastTimestampMs === null || timestampMs > lastTimestampMs) lastTimestampMs = timestampMs;

      const contextTokens = (parsed.inputTokens || 0) + (parsed.cacheReadTokens || 0);
      if (contextTokens > peakContextTokens) peakContextTokens = contextTokens;
      if (contextTokens > 0) currentContextTokens = contextTokens;

      const { costUsd, cacheSavingsUsd: turnSavings } = computeTurnCostDetails(
        resolvedModel,
        parsed.inputTokens,
        parsed.cacheReadTokens,
        parsed.outputTokens
      );

      const item = {
        idx: r.idx,
        stepIndex,
        timestampMs,
        model: resolvedModel,
        modelTier,
        modelEnum: effEnum,
        inputTokens: parsed.inputTokens,
        cacheReadTokens: parsed.cacheReadTokens,
        contextTokens,
        outputTokens: parsed.outputTokens,
        thinkingTokens: parsed.thinkingTokens,
        responseTokens: parsed.responseTokens,
        costUsd: Number(costUsd.toFixed(6)),
        cacheSavingsUsd: Number(turnSavings.toFixed(6)),
        ttftSec: parsed.ttftSec,
        streamSec: parsed.streamSec,
        totalSec: parsed.totalSec,
        streamTps: parsed.streamTps,
        e2eTps: parsed.e2eTps,
        metadata: parsed.metadataMap
      };
      generations.push(item);
      modelCounts[resolvedModel] = (modelCounts[resolvedModel] || 0) + 1;
      totalInputTokens += parsed.inputTokens;
      totalCacheReadTokens += parsed.cacheReadTokens;
      totalOutputTokens += parsed.outputTokens;
      totalThinkingTokens += parsed.thinkingTokens;
      totalResponseTokens += parsed.responseTokens;
      estimatedCostUsd += costUsd;
      cacheSavingsUsd += turnSavings;
      addTurnToSpeedAcc(sessionAcc, item);
    }

    // Backfill steps(15) carrying tokens in SQLite WAL/steps without a gen_metadata row yet
    const lastKnownModel = generations.length > 0 ? generations[generations.length - 1].model : 'unknown';
    for (const ps of parsedSteps) {
      if (matchedStepIndices.has(ps.stepIndex)) continue;
      const psTok = (ps.inputTokens || 0) + (ps.cacheReadTokens || 0) + (ps.outputTokens || 0);
      if (psTok <= 0) continue;

      const resolvedObj = ps.stepEnum != null ? resolveModelWithTier(null, ps.stepEnum) : { model: lastKnownModel, tier: null };
      const psModel = resolvedObj.model !== 'unknown' ? resolvedObj.model : lastKnownModel;
      const tsMs = ps.timestampMs || Math.round(effectiveMtimeMs);
      if (firstTimestampMs === null || tsMs < firstTimestampMs) firstTimestampMs = tsMs;
      if (lastTimestampMs === null || tsMs > lastTimestampMs) lastTimestampMs = tsMs;

      const ctxTok = (ps.inputTokens || 0) + (ps.cacheReadTokens || 0);
      if (ctxTok > peakContextTokens) peakContextTokens = ctxTok;
      if (ctxTok > 0) currentContextTokens = ctxTok;

      const thinkTok = ps.thinkingTokens || 0;
      const respTok = (ps.responseTokens || 0) || (thinkTok === 0 ? ps.outputTokens : Math.max(0, ps.outputTokens - thinkTok));
      const ttftSec = (ps.timestampMs && ps.tsFirstMs && ps.tsFirstMs >= ps.timestampMs)
        ? Number(((ps.tsFirstMs - ps.timestampMs) / 1000).toFixed(3))
        : null;
      const streamSec = (ps.tsFirstMs && ps.tsDoneMs && ps.tsDoneMs >= ps.tsFirstMs)
        ? Number(((ps.tsDoneMs - ps.tsFirstMs) / 1000).toFixed(3))
        : null;
      const totalSec = (ttftSec !== null && streamSec !== null) ? Number((ttftSec + streamSec).toFixed(3)) : null;
      const streamTps = (streamSec !== null && streamSec >= 0.5 && respTok > 0)
        ? Number((respTok / streamSec).toFixed(1))
        : null;
      const e2eTps = (totalSec !== null && totalSec > 0 && ps.outputTokens > 0)
        ? Number((ps.outputTokens / totalSec).toFixed(1))
        : null;
      const { costUsd, cacheSavingsUsd: turnSavings } = computeTurnCostDetails(
        psModel,
        ps.inputTokens,
        ps.cacheReadTokens,
        ps.outputTokens
      );

      const item = {
        idx: generations.length,
        stepIndex: ps.stepIndex,
        timestampMs: tsMs,
        model: psModel,
        modelTier: resolvedObj.tier,
        modelEnum: ps.stepEnum,
        inputTokens: ps.inputTokens,
        cacheReadTokens: ps.cacheReadTokens,
        contextTokens: ctxTok,
        outputTokens: ps.outputTokens,
        thinkingTokens: thinkTok,
        responseTokens: respTok,
        costUsd: Number(costUsd.toFixed(6)),
        cacheSavingsUsd: Number(turnSavings.toFixed(6)),
        ttftSec,
        streamSec,
        totalSec,
        streamTps,
        e2eTps,
        metadata: {}
      };
      generations.push(item);
      modelCounts[psModel] = (modelCounts[psModel] || 0) + 1;
      totalInputTokens += ps.inputTokens;
      totalCacheReadTokens += ps.cacheReadTokens;
      totalOutputTokens += ps.outputTokens;
      totalThinkingTokens += thinkTok;
      totalResponseTokens += respTok;
      estimatedCostUsd += costUsd;
      cacheSavingsUsd += turnSavings;
      addTurnToSpeedAcc(sessionAcc, item);
    }
    generations.sort((a, b) => a.stepIndex - b.stepIndex || a.idx - b.idx);

    const sortedGensByStep = [...generations].sort((a, b) => a.stepIndex - b.stepIndex || a.idx - b.idx);
    const checkpoints = [];
    let billedCheckpointCount = 0;

    for (let cIdx = 0; cIdx < rawCheckpoints.length; cIdx++) {
      const cp = rawCheckpoints[cIdx];
      const cpMeta = cp.metadata ? parseStepMetadataBlob(Buffer.from(cp.metadata)) : null;
      const cpStep = cp.idx;

      let beforeTurn = null;
      let afterTurn = null;
      for (const g of sortedGensByStep) {
        if (g.stepIndex < cpStep && g.contextTokens > 0) {
          beforeTurn = g;
        } else if (g.stepIndex > cpStep && g.contextTokens > 0 && !afterTurn) {
          afterTurn = g;
          break;
        }
      }

      const peakContext = beforeTurn ? beforeTurn.contextTokens : 0;
      const resetContext = afterTurn ? afterTurn.contextTokens : null;
      const reductionPct = (peakContext > 0 && resetContext !== null)
        ? Number((((resetContext - peakContext) / peakContext) * 100).toFixed(2))
        : null;
      const tsMs = cpMeta?.timestampMs || beforeTurn?.timestampMs || afterTurn?.timestampMs || Math.round(stat.mtimeMs);

      const cpIn = cpMeta?.inputTokens || 0;
      const cpCache = cpMeta?.cacheReadTokens || 0;
      const cpOut = cpMeta?.outputTokens || 0;
      const cpThink = cpMeta?.thinkingTokens || 0;
      const cpResp = (cpMeta?.responseTokens || 0) || (cpThink === 0 ? cpOut : Math.max(0, cpOut - cpThink));
      const cpHasTokens = (cpIn + cpCache + cpOut) > 0;

      const cpResolved = cpMeta?.stepEnum != null
        ? resolveModelWithTier(null, cpMeta.stepEnum).model
        : (beforeTurn?.model || afterTurn?.model || 'unknown');
      const cpModel = cpResolved !== 'unknown' ? cpResolved : (beforeTurn?.model || 'unknown');

      let cpCostUsd = 0;
      let cpSavingsUsd = 0;
      if (cpHasTokens) {
        const cDet = computeTurnCostDetails(cpModel, cpIn, cpCache, cpOut);
        cpCostUsd = cDet.costUsd;
        cpSavingsUsd = cDet.cacheSavingsUsd;
        billedCheckpointCount += 1;
        totalInputTokens += cpIn;
        totalCacheReadTokens += cpCache;
        totalOutputTokens += cpOut;
        totalThinkingTokens += cpThink;
        totalResponseTokens += cpResp;
        estimatedCostUsd += cpCostUsd;
        cacheSavingsUsd += cpSavingsUsd;
        modelCounts[cpModel] = (modelCounts[cpModel] || 0) + 1;
        if (firstTimestampMs === null || tsMs < firstTimestampMs) firstTimestampMs = tsMs;
        if (lastTimestampMs === null || tsMs > lastTimestampMs) lastTimestampMs = tsMs;
      }

      checkpoints.push({
        index: cIdx + 1,
        stepIndex: cpStep,
        timestampMs: tsMs,
        beforeStepIndex: beforeTurn ? beforeTurn.stepIndex : null,
        afterStepIndex: afterTurn ? afterTurn.stepIndex : null,
        peakContext,
        resetContext,
        reductionPct,
        model: cpModel,
        inputTokens: cpIn,
        cacheReadTokens: cpCache,
        outputTokens: cpOut,
        thinkingTokens: cpThink,
        responseTokens: cpResp,
        costUsd: Number(cpCostUsd.toFixed(6)),
        cacheSavingsUsd: Number(cpSavingsUsd.toFixed(6))
      });
    }

    const latestModel = generations.length > 0 ? generations[generations.length - 1].model : 'unknown';
    const speed = finalizeSpeedAcc(sessionAcc);

    const result = {
      conversationId,
      mtimeMs: Math.round(stat.mtimeMs),
      totalCalls: generations.length + billedCheckpointCount,
      latestModel,
      modelCounts,
      totalInputTokens,
      totalCacheReadTokens,
      totalOutputTokens,
      totalThinkingTokens,
      totalResponseTokens,
      currentContextTokens,
      peakContextTokens,
      compactionCount: checkpoints.length,
      checkpoints,
      estimatedCostUsd: Number(estimatedCostUsd.toFixed(4)),
      cacheSavingsUsd: Number(cacheSavingsUsd.toFixed(4)),
      firstTimestampMs: firstTimestampMs || Math.round(stat.mtimeMs),
      lastTimestampMs: lastTimestampMs || Math.round(stat.mtimeMs),
      avgTtftSec: speed.avgTtftSec,
      streamTps: speed.streamTps,
      e2eTps: speed.e2eTps,
      thinkingSharePct: speed.thinkingSharePct,
      generations
    };

    sessionCache.set(conversationId, {
      cacheKey,
      mtime: effectiveMtimeMs,
      data: result
    });

    return result;
  } catch (err) {
    console.error(`Error reading session ${conversationId}:`, err.message);
    return null;
  }
}

/**
 * Lightweight single-session context watermark probe (reads only the target .db).
 * Ideal for PostInvocation hooks with minimal latency.
 */
export function getSingleSessionWatermark(conversationId) {
  if (!conversationId || /[\\/:\0]/.test(conversationId)) return null;
  const dbFile = path.join(CONVERSATIONS_DIR, `${conversationId}.db`);
  if (!fs.existsSync(dbFile)) return null;

  try {
    const db = new DatabaseSync(dbFile, { open: true, readOnly: true });
    let latestContextTokens = 0;
    let latestStepIndex = -1;
    let compactionCount = 0;

    try {
      const cpRow = db.prepare('SELECT COUNT(*) AS cnt FROM steps WHERE step_type = 23').get();
      compactionCount = Number(cpRow?.cnt || 0);
    } catch {}

    try {
      const rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx DESC LIMIT 3').all();
      for (const r of rows) {
        const parsed = parseGenMetadataBlob(Buffer.from(r.data));
        if (parsed) {
          const ctx = (parsed.inputTokens || 0) + (parsed.cacheReadTokens || 0);
          if (ctx > 0) {
            latestContextTokens = ctx;
            latestStepIndex = Number(parsed.metadataMap?.last_step_index || r.idx);
            break;
          }
        }
      }
    } catch {}

    if (latestContextTokens === 0) {
      try {
        const stepRows = db.prepare('SELECT idx, metadata FROM steps WHERE step_type = 15 AND metadata IS NOT NULL ORDER BY idx DESC LIMIT 3').all();
        for (const s of stepRows) {
          const sp = parseStepMetadataBlob(Buffer.from(s.metadata));
          if (sp) {
            const ctx = (sp.inputTokens || 0) + (sp.cacheReadTokens || 0);
            if (ctx > 0) {
              latestContextTokens = ctx;
              latestStepIndex = s.idx;
              break;
            }
          }
        }
      } catch {}
    }

    db.close();
    const contextConfig = getContextLimitConfig();
    const limit = contextConfig.effectiveLimit || 256000;
    const usagePct = limit > 0 ? Number(((latestContextTokens / limit) * 100).toFixed(1)) : 0;

    return {
      conversationId,
      currentContextTokens: latestContextTokens,
      effectiveLimit: limit,
      limitLabel: contextConfig.label,
      usagePct,
      remainingTokens: Math.max(0, limit - latestContextTokens),
      compactionCount,
      latestStepIndex
    };
  } catch {
    return null;
  }
}

export function loadAllSummaries() {
  if (!fs.existsSync(SUMMARIES_DB_PATH)) return [];
  try {
    const db = new DatabaseSync(SUMMARIES_DB_PATH, { open: true, readOnly: true });
    const rows = db.prepare(`
      SELECT conversation_id, title, preview, step_count, last_modified_time, last_user_input_time, workspace_uris, agent_name, parent_conversation_id, status
      FROM conversation_summaries
      ORDER BY last_modified_time DESC
    `).all();
    db.close();
    return rows;
  } catch (err) {
    console.error('Error loading summaries:', err.message);
    return [];
  }
}

export function resolveSessionInfo(id, summary) {
  const title = summary?.title?.trim() || '';
  const agentName = summary?.agent_name || '';
  const isSubagent = !!agentName;
  const parentId = summary?.parent_conversation_id || '';

  if (title) {
    return {
      title,
      sessionType: isSubagent ? 'subagent' : 'main',
      agentName,
      parentId
    };
  }

  const pbtxtFile = path.join(ANNOTATIONS_DIR, `${id}.pbtxt`);
  if (fs.existsSync(pbtxtFile)) {
    try {
      const content = fs.readFileSync(pbtxtFile, 'utf-8');
      const m = content.match(/title:\s*"([^"]+)"/);
      if (m && m[1].trim()) {
        return {
          title: m[1].trim(),
          sessionType: isSubagent ? 'subagent' : 'main',
          agentName,
          parentId
        };
      }
    } catch {}
  }

  const transcriptFile = path.join(BASE_DIR, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
  if (fs.existsSync(transcriptFile)) {
    try {
      const fd = fs.openSync(transcriptFile, 'r');
      const buf = Buffer.alloc(16384);
      const bytesRead = fs.readSync(fd, buf, 0, 16384, 0);
      fs.closeSync(fd);
      const text = buf.subarray(0, bytesRead).toString('utf-8');

      if (isSubagent) {
        const mContent = text.match(/content=([^\n\r]+)/);
        if (mContent && mContent[1].trim()) {
          let p = mContent[1].trim();
          p = p.replace(/^[#\*\s]+/, '').replace(/\\n/g, ' ').replace(/\s+/g, ' ');
          return {
            title: `[子任务 · ${agentName}] ${p.slice(0, 55)}`,
            sessionType: 'subagent',
            agentName,
            parentId
          };
        }
      }

      const lines = text.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'USER_INPUT' && obj.content) {
            let prompt = obj.content;
            const reqMatch = prompt.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
            if (reqMatch) {
              prompt = reqMatch[1];
            } else {
              prompt = prompt.replace(/<[^>]+>/g, '');
            }
            prompt = prompt.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
            if (prompt) {
              const prefix = isSubagent ? `[子任务 · ${agentName}] ` : '';
              return {
                title: `${prefix}${prompt.slice(0, 55)}${prompt.length > 55 ? '...' : ''}`,
                sessionType: isSubagent ? 'subagent' : 'side_query',
                agentName,
                parentId
              };
            }
          }
        } catch {}
      }
    } catch {}
  }

  if (summary?.preview) {
    const cleanPrev = summary.preview.replace(/[\r\n]+/g, ' ').trim();
    if (cleanPrev) {
      return {
        title: `${isSubagent ? `[子任务 · ${agentName}] ` : ''}${cleanPrev.slice(0, 50)}`,
        sessionType: isSubagent ? 'subagent' : 'side_query',
        agentName,
        parentId
      };
    }
  }

  return {
    title: isSubagent ? `[子任务 · ${agentName}]` : `后台/侧栏临时对话 (${id.slice(0, 8)})`,
    sessionType: isSubagent ? 'subagent' : 'side_query',
    agentName,
    parentId
  };
}

export function getMasterIndex() {
  const now = Date.now();
  if (masterIndexCache && now - lastMasterCacheTime < 3000) {
    return masterIndexCache;
  }

  const summaries = loadAllSummaries();
  const summaryMap = new Map();
  for (const s of summaries) summaryMap.set(s.conversation_id, s);

  let dbFiles = [];
  try {
    dbFiles = fs.readdirSync(CONVERSATIONS_DIR)
      .filter(f => f.endsWith('.db'))
      .map(f => f.replace('.db', ''));
  } catch {}

  const allIds = Array.from(new Set([...summaryMap.keys(), ...dbFiles]));

  const records = [];
  const childrenByParent = new Map();
  const dailyMap = new Map();
  const hourlyMatrix = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({ tokens: 0, costUsd: 0, calls: 0 }))
  );

  let minTs = null;
  let maxTs = null;

  for (const id of allIds) {
    const sDetail = getSessionModelStats(id);
    const summary = summaryMap.get(id);
    const resolved = resolveSessionInfo(id, summary);

    const lastModifiedIso = summary?.last_modified_time || (sDetail ? new Date(sDetail.lastTimestampMs).toISOString() : '');
    const lastTs = sDetail?.lastTimestampMs || (lastModifiedIso ? new Date(lastModifiedIso).getTime() : 0);
    const firstTs = sDetail?.firstTimestampMs || lastTs;

    if (resolved.parentId) {
      if (!childrenByParent.has(resolved.parentId)) childrenByParent.set(resolved.parentId, []);
      childrenByParent.get(resolved.parentId).push(id);
    }

    if (sDetail && sDetail.generations.length > 0) {
      const seenDatesForSession = new Set();
      for (const g of sDetail.generations) {
        const ts = g.timestampMs || lastTs;
        if (ts) {
          if (minTs === null || ts < minTs) minTs = ts;
          if (maxTs === null || ts > maxTs) maxTs = ts;
          const dKey = toLocalDateKey(ts);
          seenDatesForSession.add(dKey);

          let bucket = dailyMap.get(dKey);
          if (!bucket) {
            bucket = {
              date: dKey,
              tokens: 0,
              inputTokens: 0,
              cacheReadTokens: 0,
              outputTokens: 0,
              costUsd: 0,
              calls: 0,
              sessions: 0,
              compactions: 0
            };
            dailyMap.set(dKey, bucket);
          }
          const tTok = g.inputTokens + g.cacheReadTokens + g.outputTokens;
          bucket.tokens += tTok;
          bucket.inputTokens += g.inputTokens;
          bucket.cacheReadTokens += g.cacheReadTokens;
          bucket.outputTokens += g.outputTokens;
          bucket.costUsd += g.costUsd;
          bucket.calls += 1;

          const dObj = new Date(ts);
          const dow = (dObj.getDay() + 6) % 7;
          const hr = dObj.getHours();
          hourlyMatrix[dow][hr].tokens += tTok;
          hourlyMatrix[dow][hr].costUsd += g.costUsd;
          hourlyMatrix[dow][hr].calls += 1;
        }
      }
      for (const dk of seenDatesForSession) {
        const b = dailyMap.get(dk);
        if (b) b.sessions += 1;
      }
      for (const cp of sDetail.checkpoints) {
        if (cp.timestampMs) {
          const dKey = toLocalDateKey(cp.timestampMs);
          let b = dailyMap.get(dKey);
          if (!b) {
            b = {
              date: dKey,
              tokens: 0,
              inputTokens: 0,
              cacheReadTokens: 0,
              outputTokens: 0,
              costUsd: 0,
              calls: 0,
              sessions: 0,
              compactions: 0
            };
            dailyMap.set(dKey, b);
          }
          b.compactions += 1;
          const cpTok = (cp.inputTokens || 0) + (cp.cacheReadTokens || 0) + (cp.outputTokens || 0);
          if (cpTok > 0) {
            b.tokens += cpTok;
            b.inputTokens += cp.inputTokens || 0;
            b.cacheReadTokens += cp.cacheReadTokens || 0;
            b.outputTokens += cp.outputTokens || 0;
            b.costUsd += cp.costUsd || 0;
            b.calls += 1;
            const dObj = new Date(cp.timestampMs);
            const dow = (dObj.getDay() + 6) % 7;
            const hr = dObj.getHours();
            hourlyMatrix[dow][hr].tokens += cpTok;
            hourlyMatrix[dow][hr].costUsd += cp.costUsd || 0;
            hourlyMatrix[dow][hr].calls += 1;
          }
        }
      }
    }

    records.push({
      id,
      summary,
      resolved,
      detail: sDetail,
      lastModifiedIso,
      firstTs,
      lastTs
    });
  }

  records.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));

  const dailyList = Array.from(dailyMap.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(b => ({ ...b, costUsd: Number(b.costUsd.toFixed(2)) }));

  const roundedHourly = hourlyMatrix.map(row =>
    row.map(cell => ({
      tokens: cell.tokens,
      costUsd: Number(cell.costUsd.toFixed(2)),
      calls: cell.calls
    }))
  );

  masterIndexCache = {
    records,
    recordMap: new Map(records.map(r => [r.id, r])),
    childrenByParent,
    heatmap: {
      daily: dailyList,
      hourlyMatrix: roundedHourly,
      minDate: dailyList.length ? dailyList[0].date : null,
      maxDate: dailyList.length ? dailyList[dailyList.length - 1].date : null
    },
    globalMinTs: minTs,
    globalMaxTs: maxTs,
    updatedAt: new Date().toISOString()
  };
  lastMasterCacheTime = now;
  return masterIndexCache;
}

function buildActiveSnapshot(r, childrenByParent) {
  const lastTurn = r.detail.generations[r.detail.generations.length - 1];
  return {
    conversation_id: r.id,
    title: r.resolved.title,
    latestModel: r.detail.latestModel,
    last_modified_time: new Date(r.lastTs).toISOString(),
    currentContextTokens: r.detail.currentContextTokens,
    lastInputTokens: lastTurn?.inputTokens || 0,
    lastCacheReadTokens: lastTurn?.cacheReadTokens || 0,
    peakContextTokens: r.detail.peakContextTokens,
    compactionCount: r.detail.compactionCount,
    totalCalls: r.detail.totalCalls,
    estimatedCostUsd: r.detail.estimatedCostUsd,
    cacheSavingsUsd: r.detail.cacheSavingsUsd,
    streamTps: r.detail.streamTps,
    avgTtftSec: r.detail.avgTtftSec,
    childCount: (childrenByParent.get(r.id) || []).length
  };
}

export function computeWindowStats(rangeStr, exactDateStr, focusConversationId = null) {
  const master = getMasterIndex();
  const bounds = getRangeBounds(rangeStr, exactDateStr);
  const contextConfig = getContextLimitConfig();

  const inBounds = (ts) => {
    if (!ts) return bounds.startMs === null && bounds.endMs === null;
    if (bounds.startMs !== null && ts < bounds.startMs) return false;
    if (bounds.endMs !== null && ts > bounds.endMs) return false;
    return true;
  };

  const modelTotals = {};
  const modelSessionCount = {};
  const modelCosts = {};
  const modelTokens = {};
  const modelSpeedAccMap = {};
  const globalSpeedAcc = createSpeedAcc();
  const typeCounts = { main: 0, subagent: 0, side_query: 0 };

  let totalCalls = 0;
  let totalTokens = 0;
  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalOutputTokens = 0;
  let totalEstimatedCostUsd = 0;
  let totalCacheSavingsUsd = 0;
  let totalCompactions = 0;
  let windowMinTs = null;
  let windowMaxTs = null;

  const sessionList = [];

  for (const rec of master.records) {
    const d = rec.detail;
    const childIds = master.childrenByParent.get(rec.id) || [];

    if (!d || d.generations.length === 0) {
      if (inBounds(rec.lastTs)) {
        typeCounts[rec.resolved.sessionType] = (typeCounts[rec.resolved.sessionType] || 0) + 1;
        sessionList.push({
          conversation_id: rec.id,
          title: rec.resolved.title,
          sessionType: rec.resolved.sessionType,
          agentName: rec.resolved.agentName,
          parentId: rec.resolved.parentId,
          childCount: childIds.length,
          preview: rec.summary?.preview || '',
          step_count: rec.summary?.step_count || 0,
          last_modified_time: rec.lastModifiedIso,
          calls: 0,
          latestModel: 'unknown',
          modelsUsed: [],
          modelCounts: {},
          totalInputTokens: 0,
          totalCacheReadTokens: 0,
          totalOutputTokens: 0,
          totalThinkingTokens: 0,
          totalResponseTokens: 0,
          currentContextTokens: 0,
          peakContextTokens: 0,
          compactionCount: 0,
          estimatedCostUsd: 0,
          cacheSavingsUsd: 0,
          avgTtftSec: null,
          streamTps: null,
          e2eTps: null,
          thinkingSharePct: 0
        });
      }
      continue;
    }

    const filteredTurns = (bounds.startMs === null && bounds.endMs === null)
      ? d.generations
      : d.generations.filter(g => inBounds(g.timestampMs));

    const filteredCps = (bounds.startMs === null && bounds.endMs === null)
      ? d.checkpoints
      : d.checkpoints.filter(cp => inBounds(cp.timestampMs));

    const billedFilteredCps = filteredCps.filter(
      cp => ((cp.inputTokens || 0) + (cp.cacheReadTokens || 0) + (cp.outputTokens || 0)) > 0
    );

    if (filteredTurns.length === 0 && billedFilteredCps.length === 0) continue;

    const sessModelCounts = {};
    const sessSpeedAcc = createSpeedAcc();
    let sIn = 0, sCache = 0, sOut = 0, sThink = 0, sResp = 0, sCost = 0, sSave = 0;
    let sLastTs = 0;

    for (const g of filteredTurns) {
      if (g.timestampMs) {
        if (windowMinTs === null || g.timestampMs < windowMinTs) windowMinTs = g.timestampMs;
        if (windowMaxTs === null || g.timestampMs > windowMaxTs) windowMaxTs = g.timestampMs;
        if (g.timestampMs > sLastTs) sLastTs = g.timestampMs;
      }
      const tTok = g.inputTokens + g.cacheReadTokens + g.outputTokens;
      sIn += g.inputTokens;
      sCache += g.cacheReadTokens;
      sOut += g.outputTokens;
      sThink += g.thinkingTokens;
      sResp += g.responseTokens;
      sCost += g.costUsd;
      sSave += g.cacheSavingsUsd;

      sessModelCounts[g.model] = (sessModelCounts[g.model] || 0) + 1;
      modelTotals[g.model] = (modelTotals[g.model] || 0) + 1;
      modelCosts[g.model] = (modelCosts[g.model] || 0) + g.costUsd;
      modelTokens[g.model] = (modelTokens[g.model] || 0) + tTok;

      addTurnToSpeedAcc(sessSpeedAcc, g);
      addTurnToSpeedAcc(globalSpeedAcc, g);
      if (!modelSpeedAccMap[g.model]) modelSpeedAccMap[g.model] = createSpeedAcc();
      addTurnToSpeedAcc(modelSpeedAccMap[g.model], g);
    }

    for (const cp of billedFilteredCps) {
      if (cp.timestampMs) {
        if (windowMinTs === null || cp.timestampMs < windowMinTs) windowMinTs = cp.timestampMs;
        if (windowMaxTs === null || cp.timestampMs > windowMaxTs) windowMaxTs = cp.timestampMs;
        if (cp.timestampMs > sLastTs) sLastTs = cp.timestampMs;
      }
      const cpTok = (cp.inputTokens || 0) + (cp.cacheReadTokens || 0) + (cp.outputTokens || 0);
      const cpModel = cp.model || d.latestModel || 'unknown';
      sIn += cp.inputTokens || 0;
      sCache += cp.cacheReadTokens || 0;
      sOut += cp.outputTokens || 0;
      sThink += cp.thinkingTokens || 0;
      sResp += cp.responseTokens || 0;
      sCost += cp.costUsd || 0;
      sSave += cp.cacheSavingsUsd || 0;

      sessModelCounts[cpModel] = (sessModelCounts[cpModel] || 0) + 1;
      modelTotals[cpModel] = (modelTotals[cpModel] || 0) + 1;
      modelCosts[cpModel] = (modelCosts[cpModel] || 0) + (cp.costUsd || 0);
      modelTokens[cpModel] = (modelTokens[cpModel] || 0) + cpTok;
    }

    for (const m of Object.keys(sessModelCounts)) {
      modelSessionCount[m] = (modelSessionCount[m] || 0) + 1;
    }

    const billedCalls = filteredTurns.length + billedFilteredCps.length;
    totalCalls += billedCalls;
    totalInputTokens += sIn;
    totalCacheReadTokens += sCache;
    totalOutputTokens += sOut;
    totalTokens += sIn + sCache + sOut;
    totalEstimatedCostUsd += sCost;
    totalCacheSavingsUsd += sSave;
    totalCompactions += filteredCps.length;
    typeCounts[rec.resolved.sessionType] = (typeCounts[rec.resolved.sessionType] || 0) + 1;

    const sSpeed = finalizeSpeedAcc(sessSpeedAcc);

    sessionList.push({
      conversation_id: rec.id,
      title: rec.resolved.title,
      sessionType: rec.resolved.sessionType,
      agentName: rec.resolved.agentName,
      parentId: rec.resolved.parentId,
      childCount: childIds.length,
      preview: rec.summary?.preview || '',
      step_count: rec.summary?.step_count || billedCalls,
      last_modified_time: sLastTs ? new Date(sLastTs).toISOString() : rec.lastModifiedIso,
      calls: billedCalls,
      latestModel: d.latestModel,
      modelsUsed: Object.keys(sessModelCounts),
      modelCounts: sessModelCounts,
      totalInputTokens: sIn,
      totalCacheReadTokens: sCache,
      totalOutputTokens: sOut,
      totalThinkingTokens: sThink,
      totalResponseTokens: sResp,
      currentContextTokens: d.currentContextTokens,
      peakContextTokens: d.peakContextTokens,
      compactionCount: d.compactionCount,
      estimatedCostUsd: Number(sCost.toFixed(4)),
      cacheSavingsUsd: Number(sSave.toFixed(4)),
      avgTtftSec: sSpeed.avgTtftSec,
      streamTps: sSpeed.streamTps,
      e2eTps: sSpeed.e2eTps,
      thinkingSharePct: sSpeed.thinkingSharePct
    });
  }

  sessionList.sort((a, b) => new Date(b.last_modified_time || 0).getTime() - new Date(a.last_modified_time || 0).getTime());

  const activeSessions = master.records
    .filter(r => r.detail && r.detail.totalCalls > 0 && r.resolved.sessionType === 'main')
    .slice(0, 8)
    .map(r => buildActiveSnapshot(r, master.childrenByParent));

  // If sidecar requests a specific host conversationId that isn't in top 8, prepend it
  if (focusConversationId && !activeSessions.some(s => s.conversation_id === focusConversationId)) {
    const focusRec = master.recordMap.get(focusConversationId);
    if (focusRec && focusRec.detail && focusRec.detail.totalCalls > 0) {
      activeSessions.unshift(buildActiveSnapshot(focusRec, master.childrenByParent));
    }
  }

  const globalSpeed = finalizeSpeedAcc(globalSpeedAcc);
  const modelSpeed = {};
  for (const [m, acc] of Object.entries(modelSpeedAccMap)) {
    modelSpeed[m] = finalizeSpeedAcc(acc);
  }
  const roundedModelCosts = {};
  for (const [m, c] of Object.entries(modelCosts)) {
    roundedModelCosts[m] = Number(c.toFixed(2));
  }

  const uncachedTotalCost = totalEstimatedCostUsd + totalCacheSavingsUsd;
  const cacheSavingsPct = uncachedTotalCost > 0
    ? Number(((totalCacheSavingsUsd / uncachedTotalCost) * 100).toFixed(1))
    : 0;

  return {
    range: bounds.range,
    date: bounds.date,
    dateFrom: windowMinTs ? toLocalDateKey(windowMinTs) : (bounds.startMs ? toLocalDateKey(bounds.startMs) : master.heatmap.minDate),
    dateTo: windowMaxTs ? toLocalDateKey(windowMaxTs) : toLocalDateKey(Date.now()),
    totalSessions: sessionList.length,
    totalCalls,
    totalTokens,
    totalInputTokens,
    totalCacheReadTokens,
    totalOutputTokens,
    totalEstimatedCostUsd: Number(totalEstimatedCostUsd.toFixed(2)),
    totalCacheSavingsUsd: Number(totalCacheSavingsUsd.toFixed(2)),
    cacheSavingsPct,
    totalCompactions,
    globalSpeed,
    typeCounts,
    modelTotals,
    modelSessionCount,
    modelCosts: roundedModelCosts,
    modelTokens,
    modelSpeed,
    contextConfig,
    activeSessions,
    sessions: sessionList,
    updatedAt: master.updatedAt
  };
}

export function getOverviewData({ range = '7d', date = null, focusConversationId = null } = {}) {
  const stats = computeWindowStats(range, date, focusConversationId);
  const { sessions: _omit, ...overviewPayload } = stats;
  return overviewPayload;
}

export function getHeatmapData() {
  const master = getMasterIndex();
  return {
    ...master.heatmap,
    updatedAt: master.updatedAt
  };
}

export function getSessionsList({
  range = '7d',
  date = null,
  search = '',
  model = '',
  type = '',
  page = 1,
  pageSize = 500
} = {}) {
  const stats = computeWindowStats(range, date);
  const q = String(search || '').toLowerCase().trim();
  let filtered = stats.sessions;

  if (q) {
    filtered = filtered.filter(s =>
      s.title.toLowerCase().includes(q) ||
      s.conversation_id.toLowerCase().includes(q)
    );
  }
  if (model) {
    filtered = filtered.filter(s => s.modelsUsed.includes(model));
  }
  if (type && type !== 'ALL') {
    filtered = filtered.filter(s => s.sessionType === type);
  }

  const total = filtered.length;
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.max(1, Math.min(1000, Number(pageSize) || 500));
  const startIndex = (safePage - 1) * safePageSize;
  const paginated = filtered.slice(startIndex, startIndex + safePageSize);

  return {
    total,
    page: safePage,
    pageSize: safePageSize,
    sessions: paginated
  };
}

function collectDescendantIds(rootId, childrenByParent) {
  const visited = new Set([rootId]);
  const queue = [...(childrenByParent.get(rootId) || [])];
  const descendants = [];
  while (queue.length > 0) {
    const cid = queue.shift();
    if (!cid || visited.has(cid)) continue;
    visited.add(cid);
    descendants.push(cid);
    const next = childrenByParent.get(cid);
    if (next && next.length > 0) {
      queue.push(...next);
    }
  }
  return descendants;
}

/**
 * Resolve full session detail (supports exact ID or unambiguous prefix match).
 * Includes parent reference, recursive descendant subagents, and combined totals.
 */
export function getSessionAuditDetail(sessionIdOrPrefix, { includeTurns = true } = {}) {
  const rawQuery = String(sessionIdOrPrefix || '').trim();
  if (!rawQuery) return null;

  const master = getMasterIndex();
  let resolvedId = rawQuery;
  if (!master.recordMap.has(resolvedId)) {
    const matches = master.records.filter(r => r.id.startsWith(rawQuery));
    if (matches.length === 1) {
      resolvedId = matches[0].id;
    } else if (matches.length > 1) {
      resolvedId = matches[0].id;
    }
  }

  const detail = getSessionModelStats(resolvedId);
  if (!detail) return null;

  const rec = master.recordMap.get(resolvedId);
  const resolved = rec ? rec.resolved : resolveSessionInfo(resolvedId, null);
  const directChildIds = master.childrenByParent.get(resolvedId) || [];
  const allDescendantIds = collectDescendantIds(resolvedId, master.childrenByParent);

  const mapChildRecord = (cid) => {
    const cr = master.recordMap.get(cid);
    if (!cr) return null;
    return {
      conversation_id: cr.id,
      title: cr.resolved.title,
      agentName: cr.resolved.agentName || 'subagent',
      parentId: cr.resolved.parentId || resolvedId,
      latestModel: cr.detail?.latestModel || 'unknown',
      modelsUsed: cr.detail ? Object.keys(cr.detail.modelCounts) : [],
      calls: cr.detail?.totalCalls || 0,
      totalInputTokens: cr.detail?.totalInputTokens || 0,
      totalCacheReadTokens: cr.detail?.totalCacheReadTokens || 0,
      totalOutputTokens: cr.detail?.totalOutputTokens || 0,
      totalTokens: cr.detail
        ? (cr.detail.totalInputTokens + cr.detail.totalCacheReadTokens + cr.detail.totalOutputTokens)
        : 0,
      estimatedCostUsd: cr.detail?.estimatedCostUsd || 0,
      cacheSavingsUsd: cr.detail?.cacheSavingsUsd || 0,
      compactionCount: cr.detail?.compactionCount || 0,
      firstTimestampMs: cr.firstTs,
      lastTimestampMs: cr.lastTs
    };
  };

  const childSessions = directChildIds
    .map(mapChildRecord)
    .filter(Boolean)
    .sort((a, b) => (a.firstTimestampMs || 0) - (b.firstTimestampMs || 0));

  const descendantSessions = allDescendantIds
    .map(mapChildRecord)
    .filter(Boolean)
    .sort((a, b) => (a.firstTimestampMs || 0) - (b.firstTimestampMs || 0));

  const combined = {
    sessionCount: 1 + descendantSessions.length,
    subagentCount: descendantSessions.length,
    totalCalls: detail.totalCalls,
    totalInputTokens: detail.totalInputTokens,
    totalCacheReadTokens: detail.totalCacheReadTokens,
    totalOutputTokens: detail.totalOutputTokens,
    totalTokens: detail.totalInputTokens + detail.totalCacheReadTokens + detail.totalOutputTokens,
    estimatedCostUsd: detail.estimatedCostUsd,
    cacheSavingsUsd: detail.cacheSavingsUsd,
    compactionCount: detail.compactionCount
  };
  for (const sub of descendantSessions) {
    combined.totalCalls += sub.calls;
    combined.totalInputTokens += sub.totalInputTokens;
    combined.totalCacheReadTokens += sub.totalCacheReadTokens;
    combined.totalOutputTokens += sub.totalOutputTokens;
    combined.totalTokens += sub.totalTokens;
    combined.estimatedCostUsd += sub.estimatedCostUsd;
    combined.cacheSavingsUsd += sub.cacheSavingsUsd;
    combined.compactionCount += sub.compactionCount;
  }
  combined.estimatedCostUsd = Number(combined.estimatedCostUsd.toFixed(4));
  combined.cacheSavingsUsd = Number(combined.cacheSavingsUsd.toFixed(4));

  let parentSession = null;
  if (resolved.parentId) {
    const pRec = master.recordMap.get(resolved.parentId);
    if (pRec) {
      parentSession = {
        conversation_id: pRec.id,
        title: pRec.resolved.title
      };
    }
  }

  const uncached = detail.estimatedCostUsd + detail.cacheSavingsUsd;
  const cacheSavingsPct = uncached > 0
    ? Number(((detail.cacheSavingsUsd / uncached) * 100).toFixed(1))
    : 0;

  const { generations, ...detailWithoutTurns } = detail;

  return {
    conversation_id: resolvedId,
    title: resolved.title,
    sessionType: resolved.sessionType,
    agentName: resolved.agentName,
    parentId: resolved.parentId,
    parentSession,
    childSessions,
    descendantSessions,
    combinedTotals: combined,
    preview: rec?.summary?.preview || '',
    last_modified_time: rec?.lastModifiedIso || new Date(detail.lastTimestampMs).toISOString(),
    step_count: rec?.summary?.step_count || detail.totalCalls,
    cacheSavingsPct,
    contextConfig: getContextLimitConfig(),
    ...detailWithoutTurns,
    ...(includeTurns ? { generations } : { generationCount: generations.length })
  };
}

export function getDailyReportData({ date = null, weekly = false } = {}) {
  const now = new Date();
  const isMonday = now.getDay() === 1;
  const useWeekly = Boolean(weekly) || (!date && isMonday);

  if (useWeekly && !date) {
    const stats = computeWindowStats('7d', null);
    const { sessions, ...overview } = stats;
    const topSessions = sessions
      .filter(s => s.sessionType === 'main')
      .slice(0, 10)
      .map(s => ({
        conversation_id: s.conversation_id,
        title: s.title,
        latestModel: s.latestModel,
        calls: s.calls,
        totalTokens: s.totalInputTokens + s.totalCacheReadTokens + s.totalOutputTokens,
        estimatedCostUsd: s.estimatedCostUsd,
        compactionCount: s.compactionCount,
        childCount: s.childCount
      }));
    return {
      reportType: 'weekly',
      ...overview,
      topSessions
    };
  }

  let targetDate = date;
  if (!targetDate) {
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    targetDate = toLocalDateKey(yesterday.getTime());
  }

  const stats = computeWindowStats('date', targetDate);
  const { sessions, ...overview } = stats;
  const topSessions = sessions
    .filter(s => s.sessionType === 'main')
    .slice(0, 10)
    .map(s => ({
      conversation_id: s.conversation_id,
      title: s.title,
      latestModel: s.latestModel,
      calls: s.calls,
      totalTokens: s.totalInputTokens + s.totalCacheReadTokens + s.totalOutputTokens,
      estimatedCostUsd: s.estimatedCostUsd,
      compactionCount: s.compactionCount,
      childCount: s.childCount
    }));

  return {
    reportType: 'daily',
    targetDate,
    ...overview,
    topSessions
  };
}
