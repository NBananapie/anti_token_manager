import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3820;
const defaultAntigravityDir = process.env.USERPROFILE
  ? path.join(process.env.USERPROFILE, '.gemini', 'antigravity')
  : (process.env.HOME ? path.join(process.env.HOME, '.gemini', 'antigravity') : path.resolve('C:/Users/SXF-Admin/.gemini/antigravity'));
const BASE_DIR = process.env.ANTIGRAVITY_DATA_DIR
  ? path.resolve(process.env.ANTIGRAVITY_DATA_DIR)
  : defaultAntigravityDir;
const SUMMARIES_DB_PATH = path.join(BASE_DIR, 'conversation_summaries.db');
const CONVERSATIONS_DIR = path.join(BASE_DIR, 'conversations');
const ANNOTATIONS_DIR = path.join(BASE_DIR, 'annotations');
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'dist'))
  ? path.join(__dirname, 'dist')
  : path.join(__dirname, 'public');

// --- Protobuf Decoder for gen_metadata ---
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

function mergeSpeedAcc(target, src) {
  target.ttftSum += src.ttftSum;
  target.ttftCount += src.ttftCount;
  target.streamTokSum += src.streamTokSum;
  target.streamSecSum += src.streamSecSum;
  target.e2eTokSum += src.e2eTokSum;
  target.e2eSecSum += src.e2eSecSum;
  target.thinkTokSum += src.thinkTokSum;
  target.outTokSum += src.outTokSum;
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
              if (fNum === 2) inputTokens = v.val;
              if (fNum === 3) outputTokens = v.val;
              if (fNum === 5) cacheReadTokens = v.val;
              if (fNum === 9) thinkingTokens = v.val;
              if (fNum === 10) responseTokens = v.val;
            } else if (wType === 2) {
              const sl = readVarint(sub, p4);
              if (sl.error) break;
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
      model: model || 'unknown',
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

// In-memory cache for session details
const sessionCache = new Map();
let globalStatsCache = null;
let lastCacheTime = 0;

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
    const rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
    db.close();

    const generations = [];
    const modelCounts = {};
    const modelSpeedAcc = {};
    const sessionAcc = createSpeedAcc();
    let totalInputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalOutputTokens = 0;
    let totalThinkingTokens = 0;
    let totalResponseTokens = 0;

    for (const r of rows) {
      const parsed = parseGenMetadataBlob(Buffer.from(r.data));
      if (parsed) {
        const item = {
          idx: r.idx,
          model: parsed.model,
          inputTokens: parsed.inputTokens,
          cacheReadTokens: parsed.cacheReadTokens,
          outputTokens: parsed.outputTokens,
          thinkingTokens: parsed.thinkingTokens,
          responseTokens: parsed.responseTokens,
          ttftSec: parsed.ttftSec,
          streamSec: parsed.streamSec,
          totalSec: parsed.totalSec,
          streamTps: parsed.streamTps,
          e2eTps: parsed.e2eTps,
          metadata: parsed.metadataMap
        };
        generations.push(item);
        modelCounts[parsed.model] = (modelCounts[parsed.model] || 0) + 1;
        totalInputTokens += parsed.inputTokens;
        totalCacheReadTokens += parsed.cacheReadTokens;
        totalOutputTokens += parsed.outputTokens;
        totalThinkingTokens += parsed.thinkingTokens;
        totalResponseTokens += parsed.responseTokens;

        addTurnToSpeedAcc(sessionAcc, item);
        if (!modelSpeedAcc[parsed.model]) {
          modelSpeedAcc[parsed.model] = createSpeedAcc();
        }
        addTurnToSpeedAcc(modelSpeedAcc[parsed.model], item);
      }
    }

    const speed = finalizeSpeedAcc(sessionAcc);
    const result = {
      conversationId,
      totalCalls: generations.length,
      modelCounts,
      totalInputTokens,
      totalCacheReadTokens,
      totalOutputTokens,
      totalThinkingTokens,
      totalResponseTokens,
      avgTtftSec: speed.avgTtftSec,
      streamTps: speed.streamTps,
      e2eTps: speed.e2eTps,
      thinkingSharePct: speed.thinkingSharePct,
      _speedAcc: sessionAcc,
      _modelSpeedAcc: modelSpeedAcc,
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

  // 1. Direct explicit title from summaries
  if (title) {
    return {
      title,
      sessionType: 'main',
      agentName: '',
      parentId
    };
  }

  // 2. Title from annotations .pbtxt
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

  // 3. Extract prompt from brain transcript.jsonl
  const transcriptFile = path.join(BASE_DIR, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
  if (fs.existsSync(transcriptFile)) {
    try {
      const fd = fs.openSync(transcriptFile, 'r');
      const buf = Buffer.alloc(16384);
      const bytesRead = fs.readSync(fd, buf, 0, 16384, 0);
      fs.closeSync(fd);
      const text = buf.subarray(0, bytesRead).toString('utf-8');

      // Check subagent prompt format
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

      // Check user request
      const mReq = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
      if (mReq) {
        let cleanPrompt = mReq[1].trim().replace(/\s+/g, ' ');
        const sideIdx = cleanPrompt.indexOf('Here is the question:');
        let sessionType = 'main';
        if (sideIdx !== -1) {
          cleanPrompt = cleanPrompt.slice(sideIdx + 21).trim();
          sessionType = 'side_query';
        }
        return {
          title: cleanPrompt.slice(0, 60),
          sessionType: isSubagent ? 'subagent' : sessionType,
          agentName,
          parentId
        };
      }
    } catch (e) {}
  }

  // 4. Extract prompt from steps table in conversation DB
  const dbFile = path.join(CONVERSATIONS_DIR, `${id}.db`);
  if (fs.existsSync(dbFile)) {
    try {
      const db = new DatabaseSync(dbFile, { open: true, readOnly: true });
      const rows = db.prepare('SELECT step_payload FROM steps ORDER BY idx ASC LIMIT 3').all();
      db.close();
      for (const row of rows) {
        if (!row?.step_payload) continue;
        const str = Buffer.from(row.step_payload).toString('utf-8');
        const mReq = str.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
        if (mReq) {
          let cleanPrompt = mReq[1].trim().replace(/\s+/g, ' ');
          const sideIdx = cleanPrompt.indexOf('Here is the question:');
          let sessionType = 'main';
          if (sideIdx !== -1) {
            cleanPrompt = cleanPrompt.slice(sideIdx + 21).trim();
            sessionType = 'side_query';
          }
          return {
            title: (isSubagent ? `[子任务 · ${agentName}] ` : '') + cleanPrompt.slice(0, 60),
            sessionType: isSubagent ? 'subagent' : sessionType,
            agentName,
            parentId
          };
        }
        const clean = str.replace(/[^\x20-\x7E\u4e00-\u9fa5]/g, ' ').replace(/\s+/g, ' ').trim();
        const parts = clean.split(' ').filter(p => p.length >= 6);
        const textPart = parts.find(p => /[\u4e00-\u9fa5]/.test(p) || p.length > 15);
        if (textPart) {
          return {
            title: (isSubagent ? `[子任务 · ${agentName}] ` : '') + textPart.slice(0, 60),
            sessionType: isSubagent ? 'subagent' : 'side_query',
            agentName,
            parentId
          };
        }
      }
    } catch (e) {}
  }

  // Fallback
  if (isSubagent) {
    return {
      title: `[子任务 · ${agentName}] ${summary?.preview || id.slice(0, 8)}`,
      sessionType: 'subagent',
      agentName,
      parentId
    };
  }

  return {
    title: `侧栏/临时问答 (${id.slice(0, 8)})`,
    sessionType: 'side_query',
    agentName: '',
    parentId
  };
}

function computeGlobalStats() {
  const now = Date.now();
  if (globalStatsCache && now - lastCacheTime < 3000) {
    return globalStatsCache;
  }

  const summaries = loadAllSummaries();
  const summaryMap = new Map();
  for (const s of summaries) summaryMap.set(s.conversation_id, s);

  // Find all DB files in conversations dir
  let dbFiles = [];
  try {
    dbFiles = fs.readdirSync(CONVERSATIONS_DIR)
      .filter(f => f.endsWith('.db'))
      .map(f => f.replace('.db', ''));
  } catch (err) {}

  const allIds = Array.from(new Set([...summaryMap.keys(), ...dbFiles]));

  const modelTotals = {};
  const modelSessionCount = {};
  const modelSpeedAccMap = {};
  const globalSpeedAcc = createSpeedAcc();
  const typeCounts = { main: 0, subagent: 0, side_query: 0 };
  let totalCalls = 0;
  let totalTokens = 0;
  let totalCacheReadTokens = 0;

  const sessionList = [];

  for (const id of allIds) {
    const sDetail = getSessionModelStats(id);
    const summary = summaryMap.get(id);
    const resolved = resolveSessionInfo(id, summary);

    const modelsUsed = sDetail ? Object.keys(sDetail.modelCounts) : [];
    const calls = sDetail ? sDetail.totalCalls : 0;
    totalCalls += calls;
    if (sDetail) {
      totalTokens += sDetail.totalInputTokens + sDetail.totalCacheReadTokens + sDetail.totalOutputTokens;
      totalCacheReadTokens += sDetail.totalCacheReadTokens;
      mergeSpeedAcc(globalSpeedAcc, sDetail._speedAcc);
      for (const [m, cnt] of Object.entries(sDetail.modelCounts)) {
        modelTotals[m] = (modelTotals[m] || 0) + cnt;
        modelSessionCount[m] = (modelSessionCount[m] || 0) + 1;
      }
      for (const [m, mAcc] of Object.entries(sDetail._modelSpeedAcc)) {
        if (!modelSpeedAccMap[m]) modelSpeedAccMap[m] = createSpeedAcc();
        mergeSpeedAcc(modelSpeedAccMap[m], mAcc);
      }
    }

    typeCounts[resolved.sessionType] = (typeCounts[resolved.sessionType] || 0) + 1;

    sessionList.push({
      conversation_id: id,
      title: resolved.title,
      sessionType: resolved.sessionType,
      agentName: resolved.agentName,
      parentId: resolved.parentId,
      preview: summary?.preview || '',
      step_count: summary?.step_count || calls,
      last_modified_time: summary?.last_modified_time || '',
      calls,
      modelsUsed,
      modelCounts: sDetail ? sDetail.modelCounts : {},
      totalInputTokens: sDetail ? sDetail.totalInputTokens : 0,
      totalCacheReadTokens: sDetail ? sDetail.totalCacheReadTokens : 0,
      totalOutputTokens: sDetail ? sDetail.totalOutputTokens : 0,
      totalThinkingTokens: sDetail ? sDetail.totalThinkingTokens : 0,
      totalResponseTokens: sDetail ? sDetail.totalResponseTokens : 0,
      avgTtftSec: sDetail ? sDetail.avgTtftSec : null,
      streamTps: sDetail ? sDetail.streamTps : null,
      e2eTps: sDetail ? sDetail.e2eTps : null,
      thinkingSharePct: sDetail ? sDetail.thinkingSharePct : 0
    });
  }

  const globalSpeed = finalizeSpeedAcc(globalSpeedAcc);
  const modelSpeed = {};
  for (const [m, mAcc] of Object.entries(modelSpeedAccMap)) {
    modelSpeed[m] = finalizeSpeedAcc(mAcc);
  }

  // Sort sessions by last_modified_time descending
  sessionList.sort((a, b) => {
    const tA = new Date(a.last_modified_time || 0).getTime();
    const tB = new Date(b.last_modified_time || 0).getTime();
    return tB - tA;
  });

  globalStatsCache = {
    totalSessions: sessionList.length,
    totalCalls,
    totalTokens,
    totalCacheReadTokens,
    globalSpeed,
    typeCounts,
    modelTotals,
    modelSessionCount,
    modelSpeed,
    sessions: sessionList,
    updatedAt: new Date().toISOString()
  };
  lastCacheTime = now;
  return globalStatsCache;
}

// --- SSE (Server-Sent Events) ---
const sseClients = new Set();

function broadcastUpdate() {
  globalStatsCache = null;
  const data = JSON.stringify({ type: 'update', timestamp: Date.now() });
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
}

// Watch filesystem for updates
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

  // CORS headers
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

  // API: Global Overview
  if (pathname === '/api/overview') {
    const stats = computeGlobalStats();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      totalSessions: stats.totalSessions,
      totalCalls: stats.totalCalls,
      totalTokens: stats.totalTokens,
      totalCacheReadTokens: stats.totalCacheReadTokens,
      globalSpeed: stats.globalSpeed,
      typeCounts: stats.typeCounts,
      modelTotals: stats.modelTotals,
      modelSessionCount: stats.modelSessionCount,
      modelSpeed: stats.modelSpeed,
      updatedAt: stats.updatedAt
    }));
    return;
  }

  // API: Sessions List (with filter & pagination)
  if (pathname === '/api/sessions') {
    const stats = computeGlobalStats();
    const search = (urlObj.searchParams.get('search') || '').toLowerCase().trim();
    const modelFilter = urlObj.searchParams.get('model') || '';
    const typeFilter = urlObj.searchParams.get('type') || '';
    const page = parseInt(urlObj.searchParams.get('page') || '1', 10);
    const pageSize = parseInt(urlObj.searchParams.get('pageSize') || '20', 10);

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

  // API: Session Detail
  if (pathname.startsWith('/api/sessions/')) {
    const sessionId = pathname.replace('/api/sessions/', '').trim();
    const detail = getSessionModelStats(sessionId);
    if (!detail) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }
    const summaries = loadAllSummaries();
    const summary = summaries.find(s => s.conversation_id === sessionId);
    const resolved = resolveSessionInfo(sessionId, summary);

    const { _speedAcc, _modelSpeedAcc, ...publicDetail } = detail;

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      conversation_id: sessionId,
      title: resolved.title,
      sessionType: resolved.sessionType,
      agentName: resolved.agentName,
      parentId: resolved.parentId,
      preview: summary?.preview || '',
      last_modified_time: summary?.last_modified_time || '',
      step_count: summary?.step_count || detail.totalCalls,
      ...publicDetail
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
