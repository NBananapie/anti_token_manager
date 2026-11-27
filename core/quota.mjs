import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { BASE_DIR } from './telemetry.mjs';

const SERVICE_PREFIX = '/exa.language_server_pb.LanguageServerService/';
const DAEMON_FILE_RE = /^(?:ls|hub)_[^/\\]+\.json$/i;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const CACHE_TTL_MS = 45_000;
const REQUEST_TIMEOUT_MS = 4_000;
const MAX_DAEMON_FILE_BYTES = 16_384;
const MAX_DAEMON_FILES = 64;

let cachedSnapshot = null;
let cachedAtMs = 0;
let inFlightPromise = null;

function isValidPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isValidPid(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff;
}

function isProcessAlive(pid) {
  if (!isValidPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function parseLoopbackEndpoint(address) {
  if (typeof address !== 'string') return null;
  const trimmed = address.trim();
  if (!trimmed) return null;
  try {
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
    const parsed = new URL(hasScheme ? trimmed : `http://${trimmed}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return null;
    const port = Number(parsed.port);
    if (!isValidPort(port)) return null;
    return { port, useHttps: parsed.protocol === 'https:' };
  } catch {
    return null;
  }
}

function discoverAliveDaemonEndpoints(baseDir) {
  const daemonDir = path.join(baseDir, 'daemon');
  try {
    const dirStat = fs.lstatSync(daemonDir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return [];
  } catch {
    return [];
  }

  let entries;
  try {
    entries = fs.readdirSync(daemonDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const statList = [];
  for (const entry of entries) {
    const name = entry?.name;
    if (typeof name !== 'string' || !DAEMON_FILE_RE.test(name)) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) continue;
    const fullPath = path.join(daemonDir, name);
    try {
      const st = fs.lstatSync(fullPath);
      if (st.isSymbolicLink() || !st.isFile()) continue;
      if (st.size <= 0 || st.size > MAX_DAEMON_FILE_BYTES) continue;
      statList.push({ name, fullPath, mtimeMs: Number.isFinite(st.mtimeMs) ? st.mtimeMs : 0 });
    } catch {}
  }

  statList.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));

  const endpoints = [];
  for (const item of statList.slice(0, MAX_DAEMON_FILES)) {
    try {
      const raw = fs.readFileSync(item.fullPath, 'utf8').replace(/^\uFEFF/, '');
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
      const pid = Number(data.pid);
      if (!isProcessAlive(pid)) continue;
      const httpPort = Number(data.httpPort ?? data.http_port);
      const httpsPort = Number(data.httpsPort ?? data.https_port);
      const csrfToken = typeof (data.csrfToken ?? data.csrf_token) === 'string'
        ? String(data.csrfToken ?? data.csrf_token).trim()
        : '';
      if (!csrfToken || csrfToken.length > 512) continue;

      if (isValidPort(httpPort)) {
        endpoints.push({
          port: httpPort,
          useHttps: false,
          csrfToken,
          pid,
          source: 'daemon-file',
          lsVersion: typeof (data.lsVersion ?? data.ls_version) === 'string'
            ? String(data.lsVersion ?? data.ls_version).slice(0, 64)
            : null
        });
      }
      if (isValidPort(httpsPort)) {
        endpoints.push({
          port: httpsPort,
          useHttps: true,
          csrfToken,
          pid,
          source: 'daemon-file',
          lsVersion: typeof (data.lsVersion ?? data.ls_version) === 'string'
            ? String(data.lsVersion ?? data.ls_version).slice(0, 64)
            : null
        });
      }
    } catch {}
  }

  return endpoints;
}

function callLocalRpc(endpoint, method, body = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const transport = endpoint.useHttps ? https : http;
    const req = transport.request(
      {
        hostname: '127.0.0.1',
        port: endpoint.port,
        method: 'POST',
        path: `${SERVICE_PREFIX}${method}`,
        ...(endpoint.useHttps ? { rejectUnauthorized: false } : {}),
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': endpoint.csrfToken,
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        let text = '';
        let bytes = 0;
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 2 * 1024 * 1024) {
            req.destroy(new Error('Quota response too large'));
            return;
          }
          text += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            const err = new Error(`Local RPC ${method} HTTP ${res.statusCode}`);
            err.status = res.statusCode;
            reject(err);
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error(`Invalid JSON from ${method}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Local RPC ${method} timeout`));
    });
    req.end(payload);
  });
}

function parseFraction(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
  }
  if (typeof value === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value.trim())) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
  }
  return null;
}

function parseResetTimeMs(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  }
  if (raw && typeof raw === 'object' && raw.seconds != null) {
    const sec = Number(raw.seconds);
    if (!Number.isFinite(sec)) return null;
    const nanos = Number(raw.nanos);
    return sec * 1000 + (Number.isFinite(nanos) ? Math.floor(nanos / 1e6) : 0);
  }
  return null;
}

function inferPoolKey(groupName = '', bucketId = '') {
  const combined = `${groupName} ${bucketId}`;
  if (/argon/i.test(combined)) return 'argon';
  if (/claude|gpt|\b3p\b/i.test(combined)) return 'claude';
  if (/gemini/i.test(combined)) return 'gemini';
  return 'other';
}

function inferDisplayLabel(poolKey, rawName) {
  if (rawName && rawName.trim()) {
    if (/^gemini models$/i.test(rawName.trim())) return 'Gemini 模型池';
    if (/^claude and gpt models$/i.test(rawName.trim())) return 'Claude / GPT (3P)';
    return rawName.trim();
  }
  if (poolKey === 'gemini') return 'Gemini 模型池';
  if (poolKey === 'argon') return 'Argon 专属池';
  if (poolKey === 'claude') return 'Claude / GPT (3P)';
  return '模型配额池';
}

function normalizeQuotaResponse(rawResp, nowMs = Date.now()) {
  const root = rawResp && typeof rawResp.response === 'object' && rawResp.response !== null
    ? rawResp.response
    : (rawResp && typeof rawResp === 'object' ? rawResp : {});

  const bucketFamily = (b) => String(b?.bucketId || '').replace(/-(5h|weekly)$/i, '');
  const getCadence = (b) => {
    if (b && typeof b.window === 'string') {
      return b.window === '5h' || b.window === 'weekly' ? b.window : null;
    }
    const m = String(b?.bucketId || '').match(/-(5h|weekly)$/i);
    return m ? m[1].toLowerCase() : null;
  };
  const getRemainingField = (b, field) => {
    if (b && Object.prototype.hasOwnProperty.call(b, field)) return b[field];
    if (b?.remaining && typeof b.remaining === 'object') {
      if (b.remaining.case === field) return b.remaining.value;
      return b.remaining[field];
    }
    return undefined;
  };

  let rawGroups = Array.isArray(root.groups)
    ? root.groups.filter((g) => g && typeof g === 'object' && !Array.isArray(g))
    : [];

  if (!rawGroups.length && Array.isArray(root.buckets)) {
    const familyMap = new Map();
    for (let i = 0; i < root.buckets.length; i++) {
      const bucket = root.buckets[i];
      if (!bucket || typeof bucket !== 'object') continue;
      const key = bucketFamily(bucket) || `group-${i}`;
      if (!familyMap.has(key)) {
        familyMap.set(key, {
          displayName: typeof bucket.displayName === 'string' ? bucket.displayName : key,
          description: '',
          buckets: []
        });
      }
      familyMap.get(key).buckets.push(bucket);
    }
    rawGroups = Array.from(familyMap.values());
  }

  return rawGroups.map((group, idx) => {
    const buckets = Array.isArray(group.buckets)
      ? group.buckets.filter((b) => b && typeof b === 'object')
      : [];
    const firstFamily = buckets.map(bucketFamily).find(Boolean) || `group-${idx}`;
    const rawName = typeof group.displayName === 'string' ? group.displayName.trim() : '';
    const poolKey = inferPoolKey(rawName, firstFamily);

    const buildWindow = (winKey) => {
      const bucket = buckets.find((b) => getCadence(b) === winKey);
      if (!bucket) {
        return {
          available: false,
          bucketId: null,
          remainingFraction: null,
          remainingPct: null,
          resetAt: null,
          resetInSec: null,
          expired: false,
          disabled: false,
          description: ''
        };
      }
      const frac = parseFraction(getRemainingField(bucket, 'remainingFraction'));
      const resetMs = parseResetTimeMs(bucket.resetTime ?? bucket.resetTimeMs);
      const expired = resetMs !== null && resetMs <= nowMs;
      const resetInSec = resetMs !== null ? Math.max(0, Math.round((resetMs - nowMs) / 1000)) : null;
      return {
        available: true,
        bucketId: typeof bucket.bucketId === 'string' ? bucket.bucketId : null,
        remainingFraction: frac,
        remainingPct: frac !== null ? Number((frac * 100).toFixed(1)) : null,
        resetAt: resetMs !== null ? new Date(resetMs).toISOString() : null,
        resetInSec,
        expired,
        disabled: bucket.disabled === true,
        description: typeof bucket.description === 'string' ? bucket.description : ''
      };
    };

    return {
      id: firstFamily,
      poolKey,
      name: inferDisplayLabel(poolKey, rawName),
      rawName: rawName || firstFamily,
      description: typeof group.description === 'string' ? group.description : '',
      windows: {
        '5h': buildWindow('5h'),
        weekly: buildWindow('weekly')
      }
    };
  });
}

function extractPlanName(userResp) {
  const status = userResp?.userStatus || userResp || {};
  const planInfo = status?.planStatus?.planInfo;
  const tierName = status?.userTier?.name || status?.userTier?.id || '';
  const planName = planInfo?.planName || '';
  const teamsTier = planInfo?.teamsTier || '';
  const combined = `${planName} ${tierName} ${teamsTier}`;
  const ultraMatch = combined.match(/ultra[\s_-]*(20|5)\s*[x×]?/i);
  if (ultraMatch) return `Google AI Ultra ${ultraMatch[1]}x`;
  if (/ultra/i.test(combined)) return 'Google AI Ultra';
  if (planName && planName.trim()) return planName.trim();
  if (/pro/i.test(combined)) return 'Pro';
  if (/plus/i.test(combined)) return 'Plus';
  if (/free/i.test(combined)) return 'Free';
  return null;
}

async function fetchQuotaNow(baseDir) {
  const candidates = [];

  // 1. Official Antigravity Sidecar env variables (loopback only)
  const envEndpoint = parseLoopbackEndpoint(process.env.ANTIGRAVITY_LS_ADDRESS);
  const envCsrf = typeof process.env.ANTIGRAVITY_CSRF_TOKEN === 'string'
    ? process.env.ANTIGRAVITY_CSRF_TOKEN.trim()
    : '';
  if (envEndpoint && envCsrf) {
    candidates.push({
      ...envEndpoint,
      csrfToken: envCsrf,
      pid: null,
      source: 'sidecar-env',
      lsVersion: null
    });
  }

  // 2. Local Antigravity daemon discovery files (~/.gemini/antigravity/daemon/{ls,hub}_*.json)
  const daemonCandidates = discoverAliveDaemonEndpoints(baseDir);
  for (const dc of daemonCandidates) {
    if (!candidates.some((c) => c.port === dc.port && c.useHttps === dc.useHttps)) {
      candidates.push(dc);
    }
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      error: '未检测到运行中的 Antigravity 本地服务'
    };
  }

  let lastError = '无法连接 Antigravity 本地配额接口';
  for (const endpoint of candidates) {
    try {
      const rawQuota = await callLocalRpc(endpoint, 'RetrieveUserQuotaSummary', {});
      const nowMs = Date.now();
      const groups = normalizeQuotaResponse(rawQuota, nowMs);
      let planName = null;
      try {
        const userResp = await callLocalRpc(endpoint, 'GetUserStatus', {});
        planName = extractPlanName(userResp);
      } catch {
        // Optional plan metadata; never block quota display
      }
      return {
        ok: true,
        snapshot: {
          available: groups.length > 0,
          status: 'live',
          source: endpoint.source,
          lsVersion: endpoint.lsVersion,
          planName,
          groups,
          fetchedAt: new Date(nowMs).toISOString(),
          error: null
        }
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    ok: false,
    error: lastError
  };
}

/**
 * Read-only local quota snapshot (5h rolling & weekly remaining percentages + reset countdown).
 * Strictly queries 127.0.0.1 official LanguageServerService without CDP or credential persistence.
 */
export async function getQuotaSnapshot({ force = false, baseDir = BASE_DIR } = {}) {
  const now = Date.now();
  if (!force && cachedSnapshot && now - cachedAtMs < CACHE_TTL_MS) {
    return cachedSnapshot;
  }
  if (inFlightPromise) {
    return inFlightPromise;
  }

  inFlightPromise = (async () => {
    const res = await fetchQuotaNow(baseDir);
    if (res.ok) {
      cachedSnapshot = res.snapshot;
      cachedAtMs = Date.now();
      return cachedSnapshot;
    }
    if (cachedSnapshot) {
      return {
        ...cachedSnapshot,
        status: 'stale',
        error: res.error
      };
    }
    return {
      available: false,
      status: 'offline',
      source: 'none',
      lsVersion: null,
      planName: null,
      groups: [],
      fetchedAt: null,
      error: res.error
    };
  })().finally(() => {
    inFlightPromise = null;
  });

  return inFlightPromise;
}
