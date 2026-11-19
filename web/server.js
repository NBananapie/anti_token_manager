import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3820;
const defaultAntigravityDir = process.env.USERPROFILE
  ? path.join(process.env.USERPROFILE, '.gemini', 'antigravity')
  : (process.env.HOME ? path.join(process.env.HOME, '.gemini', 'antigravity') : path.join(os.homedir(), '.gemini', 'antigravity'));
const BASE_DIR = process.env.ANTIGRAVITY_DATA_DIR
  ? path.resolve(process.env.ANTIGRAVITY_DATA_DIR)
  : defaultAntigravityDir;
const SUMMARIES_DB_PATH = path.join(BASE_DIR, 'conversation_summaries.db');
const CONVERSATIONS_DIR = path.join(BASE_DIR, 'conversations');
const ANNOTATIONS_DIR = path.join(BASE_DIR, 'annotations');
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'dist'))
  ? path.join(__dirname, 'dist')
  : path.join(__dirname, 'public');

// --- Model Pricing Table (Synced with scripts/gemini_pricing.json) ---
const FALLBACK_PRICING = {
  'gemini-3.8-flash': { input: 0.75, cache_read: 0.075, output: 3.75 },
  'gemini-4-neon': { input: 3.0, cache_read: 0.15, output: 15.0 },
  'gemini-4-carbon': { input: 2.0, cache_read: 0.1, output: 10.0 },
  'gemini-4-argon': { input: 2.0, cache_read: 0.1, output: 10.0 },
  'gemini-4-hydrogen': { input: 1.5, cache_read: 0.075, output: 7.5 },
  'gemini-pro-orchestrator': { input: 2.0, cache_read: 0.1, output: 10.0 },
  'gemini-pro-orchestrator-argon': { input: 2.0, cache_read: 0.1, output: 10.0 },
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
  const pricingPath = path.resolve(__dirname, '..', 'scripts', 'gemini_pricing.json');
  try {
    if (fs.existsSync(pricingPath)) {
      const parsed = JSON.parse(fs.readFileSync(pricingPath, 'utf-8'));
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          if (v && typeof v === 'object') table[k] = { ...(table[k] || {}), ...v };
        }
      }
    }
  } catch (err) {}
  return table;
}

const PRICING_TABLE = loadPricingTable();

// Authoritative Model enum ID -> { base, tier } synced with scripts/pricing.py
const MODEL_ENUM_INFO = {
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
  1533: { base: 'gemini-4-neon', tier: 'Medium' },
  1535: { base: 'gemini-4-neon', tier: 'XHigh' },
  1667: { base: 'gemini-pro-orchestrator', tier: 'Carbon' },
  1669: { base: 'gemini-flash-worker-agy', tier: 'Worker' }
};

function resolveModelWithTier(rawBackendModel, modelEnum) {
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
    // Strip redundant trailing tier suffix from backend ID so we render tier uniformly as "endpoint (Tier)"
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
    // Special case: safety filter endpoint keeps its own name without inheriting flash thinking tier
    if (base.toLowerCase().includes('safety')) {
      tier = null;
    }
  }

  const label = tier ? `${base} (${tier})` : base;
  return { model: label, rawModel: rawBackendModel || base, tier };
}

function mapModelToPricingKey(modelName) {
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

function computeTurnCostDetails(modelName, inputTokens, cacheReadTokens, outputTokens) {
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

function findLanguageServerBinary() {
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

function formatLimitLabel(limit) {
  if (limit >= 840000) return '1M (840K)';
  if (limit >= 1000 && limit % 1000 === 0) return `${limit / 1000}K`;
  return `${Math.round(limit / 1000)}K`;
}

function getContextLimitConfig() {
  const defaultCfg = {
    detected: false,
    effectiveLimit: 256000,
    configuredLimit: 256000,
    cloudOverrideBypassed: false,
    label: '256K'
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
      label: formatLimitLabel(effectiveLimit)
    };
    cachedBinaryMtime = stat.mtimeMs;
    return cachedContextConfig;
  } catch (err) {
    return defaultCfg;
  }
}

// --- Local Date / Time Formatting Helpers (UTC+8 / Local Machine Time) ---
function toLocalDateKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getRangeBounds(rangeStr, exactDateStr) {
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
  // Default: 7d (including today)
  const start = new Date(todayStart);
  start.setDate(start.getDate() - 6);
  return { startMs: start.getTime(), endMs: null, range: '7d', date: null };
}

// --- Protobuf Decoders for gen_metadata and steps ---
function readVarint(b, pos) {
  let bigVal = 0n, shift = 0n, bVal;
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
  let pos = 0, sec = 0, nanos = 0, hasField = false;
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
  if (secs === null || secs < 1577836800) return null; // Sanity >= 2020-01-01
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
  } catch (err) {
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
    let pos = 0, f1 = null;
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
          let pSub = 0, k = '', v = '';
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
  } catch (err) {
    return null;
  }
}

// In-memory cache for parsed sessions
const sessionCache = new Map();
let masterIndexCache = null;
let lastMasterCacheTime = 0;

function getSessionModelStats(conversationId) {
  const dbFile = path.join(CONVERSATIONS_DIR, `${conversationId}.db`);
  if (!fs.existsSync(dbFile)) return null;

  try {
    const stat = fs.statSync(dbFile);
    const cached = sessionCache.get(conversationId);
    if (cached && cached.mtime === stat.mtimeMs) {
      return cached.data;
    }

    const db = new DatabaseSync(dbFile, { open: true, readOnly: true });
    const genRows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();

    let plannerSteps = [];
    let rawCheckpoints = [];
    try {
      plannerSteps = db.prepare('SELECT idx, metadata FROM steps WHERE step_type = 15 AND metadata IS NOT NULL ORDER BY idx ASC').all();
      rawCheckpoints = db.prepare('SELECT idx, metadata FROM steps WHERE step_type = 23 ORDER BY idx ASC').all();
    } catch (e) {}
    db.close();

    // Map bot_id -> step timing & exact stepIndex from steps table
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

      // Associate with steps(15) via botId, else last_step_index metadata, else positional fallback
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
      const effEnum = linkedStep?.stepEnum ?? parsed.modelEnum ?? null;
      const { model: resolvedModel, tier: modelTier } = resolveModelWithTier(parsed.model, effEnum);
      const timestampMs = linkedStep?.timestampMs || Math.round(stat.mtimeMs);
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

    // Build compaction (CHECKPOINT) events with peak/reset context & reduction %
    const sortedGensByStep = [...generations].sort((a, b) => a.stepIndex - b.stepIndex || a.idx - b.idx);
    const checkpoints = [];
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

      checkpoints.push({
        index: cIdx + 1,
        stepIndex: cpStep,
        timestampMs: tsMs,
        beforeStepIndex: beforeTurn ? beforeTurn.stepIndex : null,
        afterStepIndex: afterTurn ? afterTurn.stepIndex : null,
        peakContext,
        resetContext,
        reductionPct
      });
    }

    const latestModel = generations.length > 0 ? generations[generations.length - 1].model : 'unknown';
    const speed = finalizeSpeedAcc(sessionAcc);

    const result = {
      conversationId,
      mtimeMs: Math.round(stat.mtimeMs),
      totalCalls: generations.length,
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
      mtime: stat.mtimeMs,
      data: result
    });

    return result;
  } catch (err) {
    console.error(`Error reading session ${conversationId}:`, err.message);
    return null;
  }
}

function loadAllSummaries() {
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

// --- Smart Title & Context Resolution ---
function resolveSessionInfo(id, summary) {
  let title = summary?.title?.trim() || '';
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
    } catch (e) {}
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
        } catch (err) {}
      }
    } catch (err) {}
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

// --- Master Index (Caches full parsed sessions + heatmap aggregates for 3s) ---
function getMasterIndex() {
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
  } catch (err) {}

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
          // Monday = 0 .. Sunday = 6
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
          const b = dailyMap.get(dKey);
          if (b) b.compactions += 1;
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

  // Sort records by lastTs descending
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

// Compute time-sliced overview & session list
function computeWindowStats(rangeStr, exactDateStr) {
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

    if (filteredTurns.length === 0) continue;

    const filteredCps = (bounds.startMs === null && bounds.endMs === null)
      ? d.checkpoints
      : d.checkpoints.filter(cp => inBounds(cp.timestampMs));

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

    for (const m of Object.keys(sessModelCounts)) {
      modelSessionCount[m] = (modelSessionCount[m] || 0) + 1;
    }

    totalCalls += filteredTurns.length;
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
      step_count: rec.summary?.step_count || filteredTurns.length,
      last_modified_time: sLastTs ? new Date(sLastTs).toISOString() : rec.lastModifiedIso,
      calls: filteredTurns.length,
      latestModel: d.latestModel,
      modelsUsed: Object.keys(sessModelCounts),
      modelCounts: sessModelCounts,
      totalInputTokens: sIn,
      totalCacheReadTokens: sCache,
      totalOutputTokens: sOut,
      totalThinkingTokens: sThink,
      totalResponseTokens: sResp,
      // Always reflect actual live context window state of the session
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

  // Live Context Monitor candidates: most recently active main sessions (always from master, regardless of range)
  const activeSessions = master.records
    .filter(r => r.detail && r.detail.totalCalls > 0 && r.resolved.sessionType === 'main')
    .slice(0, 8)
    .map(r => {
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
        childCount: (master.childrenByParent.get(r.id) || []).length
      };
    });

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

// --- SSE (Server-Sent Events) ---
const sseClients = new Set();

function broadcastUpdate() {
  masterIndexCache = null;
  const data = JSON.stringify({ type: 'update', timestamp: Date.now() });
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
}

try {
  let debounceTimer = null;
  const triggerDebouncedBroadcast = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      broadcastUpdate();
    }, 500);
  };

  if (fs.existsSync(CONVERSATIONS_DIR)) {
    fs.watch(CONVERSATIONS_DIR, triggerDebouncedBroadcast);
  }
  if (fs.existsSync(SUMMARIES_DB_PATH)) {
    fs.watch(SUMMARIES_DB_PATH, triggerDebouncedBroadcast);
  }
} catch (e) {
  console.warn('Filesystem watch failed, falling back to on-demand polling.');
}

// --- HTTP Server ---
const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // SSE endpoint
  if (pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write('retry: 3000\n\n');
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    sseClients.add(res);

    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // API: Heatmap (daily calendar + 7x24 hourly matrix)
  if (pathname === '/api/heatmap') {
    const master = getMasterIndex();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ...master.heatmap,
      updatedAt: master.updatedAt
    }));
    return;
  }

  // API: Global Overview (supports ?range=today|7d|30d|all and ?date=YYYY-MM-DD)
  if (pathname === '/api/overview') {
    const range = urlObj.searchParams.get('range') || '7d';
    const date = urlObj.searchParams.get('date') || null;
    const stats = computeWindowStats(range, date);
    const { sessions: _omit, ...overviewPayload } = stats;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(overviewPayload));
    return;
  }

  // API: Sessions List (supports range, date, search, model, type, pagination)
  if (pathname === '/api/sessions') {
    const range = urlObj.searchParams.get('range') || '7d';
    const date = urlObj.searchParams.get('date') || null;
    const stats = computeWindowStats(range, date);
    const search = (urlObj.searchParams.get('search') || '').toLowerCase().trim();
    const modelFilter = urlObj.searchParams.get('model') || '';
    const typeFilter = urlObj.searchParams.get('type') || '';
    const page = parseInt(urlObj.searchParams.get('page') || '1', 10);
    const pageSize = parseInt(urlObj.searchParams.get('pageSize') || '500', 10);

    let filtered = stats.sessions;
    if (search) {
      filtered = filtered.filter(s =>
        s.title.toLowerCase().includes(search) ||
        s.conversation_id.toLowerCase().includes(search)
      );
    }
    if (modelFilter) {
      filtered = filtered.filter(s => s.modelsUsed.includes(modelFilter));
    }
    if (typeFilter && typeFilter !== 'ALL') {
      filtered = filtered.filter(s => s.sessionType === typeFilter);
    }

    const total = filtered.length;
    const startIndex = (page - 1) * pageSize;
    const paginated = filtered.slice(startIndex, startIndex + pageSize);

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      total,
      page,
      pageSize,
      sessions: paginated
    }));
    return;
  }

  // API: Session Detail (with checkpoints, context trajectory, parent/subagents, contextConfig)
  if (pathname.startsWith('/api/sessions/')) {
    const sessionId = decodeURIComponent(pathname.replace('/api/sessions/', '').trim());
    const detail = getSessionModelStats(sessionId);
    if (!detail) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }

    const master = getMasterIndex();
    const rec = master.recordMap.get(sessionId);
    const resolved = rec ? rec.resolved : resolveSessionInfo(sessionId, null);
    const childIds = master.childrenByParent.get(sessionId) || [];
    const childSessions = childIds
      .map(cid => master.recordMap.get(cid))
      .filter(Boolean)
      .map(cr => ({
        conversation_id: cr.id,
        title: cr.resolved.title,
        agentName: cr.resolved.agentName || 'subagent',
        latestModel: cr.detail?.latestModel || 'unknown',
        modelsUsed: cr.detail ? Object.keys(cr.detail.modelCounts) : [],
        calls: cr.detail?.totalCalls || 0,
        totalTokens: cr.detail
          ? (cr.detail.totalInputTokens + cr.detail.totalCacheReadTokens + cr.detail.totalOutputTokens)
          : 0,
        estimatedCostUsd: cr.detail?.estimatedCostUsd || 0,
        compactionCount: cr.detail?.compactionCount || 0,
        firstTimestampMs: cr.firstTs,
        lastTimestampMs: cr.lastTs
      }))
      .sort((a, b) => (a.firstTimestampMs || 0) - (b.firstTimestampMs || 0));

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

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      conversation_id: sessionId,
      title: resolved.title,
      sessionType: resolved.sessionType,
      agentName: resolved.agentName,
      parentId: resolved.parentId,
      parentSession,
      childSessions,
      preview: rec?.summary?.preview || '',
      last_modified_time: rec?.lastModifiedIso || new Date(detail.lastTimestampMs).toISOString(),
      step_count: rec?.summary?.step_count || detail.totalCalls,
      cacheSavingsPct,
      contextConfig: getContextLimitConfig(),
      ...detail
    }));
    return;
  }

  // Static files serving
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }

  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml'
  };

  const contentType = mimeTypes[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[Anti Model Monitor] Server running on http://127.0.0.1:${PORT}`);
});
