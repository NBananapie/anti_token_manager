import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadGuardSettings,
  saveGuardSettings
} from '../core/plugin-store.mjs';
import { getQuotaSnapshot } from '../core/quota.mjs';
import {
  BASE_DIR,
  CONVERSATIONS_DIR,
  SUMMARIES_DB_PATH,
  getContextLimitConfig,
  getDashboardData,
  getHeatmapData,
  getOverviewData,
  getSessionAuditDetail,
  getSessionsList,
  getTodayTotalCostUsd,
  getWorkspaceBreakdown,
  invalidateMasterIndexCache,
  markSessionDirty,
  markSummariesDirty,
  toLocalDateKey
} from '../core/telemetry.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IS_SIDECAR = process.env.ANTIGRAVITY_TOKEN_SIDECAR === '1' || Boolean(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT);
const PORT = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.PORT || 3820);
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'dist'))
  ? path.join(__dirname, 'dist')
  : path.join(__dirname, 'public');

function loadSidecarPreloadJs() {
  const candidates = [
    path.join(BASE_DIR, 'lib', 'node_modules', 'sidecar_sdk', 'preload.js')
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        return fs.readFileSync(p, 'utf-8');
      }
    } catch {}
  }
  return '// sidecar preload unavailable in standalone mode\n';
}

const PRELOAD_JS = loadSidecarPreloadJs();

let cachedInlinedHtml = null;
let cachedIndexMtime = 0;

function getRenderedIndexHtml() {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (!fs.existsSync(indexPath)) return null;
  const stat = fs.statSync(indexPath);
  if (cachedInlinedHtml && cachedIndexMtime === stat.mtimeMs) {
    return cachedInlinedHtml;
  }

  let html = fs.readFileSync(indexPath, 'utf-8');

  // Inline /preload.js so window.sidecar & theme-change work regardless of proxy path prefix
  html = html.replace(
    /<script\s+src="\/preload\.js"><\/script>/i,
    () => `<script>${PRELOAD_JS.replace(/<\/script/gi, '<\\/script')}</script>`
  );

  // Inline built stylesheets to avoid crossorigin/CORS or relative-path failures inside sidecar iframes
  html = html.replace(
    /<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/gi,
    (match, href) => {
      const cleanRel = href.replace(/^\.?\//, '');
      const cssPath = path.resolve(PUBLIC_DIR, cleanRel);
      if (cssPath.startsWith(path.resolve(PUBLIC_DIR) + path.sep) && fs.existsSync(cssPath)) {
        const css = fs.readFileSync(cssPath, 'utf-8');
        return `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`;
      }
      return match;
    }
  );

  // Move and inline built IIFE bundle at end of <body> as classic script (no type="module", no crossorigin)
  const inlinedScripts = [];
  html = html.replace(
    /<script\b[^>]*src="([^"]+)"[^>]*><\/script>/gi,
    (match, src) => {
      if (src.startsWith('http://') || src.startsWith('https://')) return match;
      const cleanRel = src.replace(/^\.?\//, '');
      const jsPath = path.resolve(PUBLIC_DIR, cleanRel);
      if (jsPath.startsWith(path.resolve(PUBLIC_DIR) + path.sep) && fs.existsSync(jsPath)) {
        const js = fs.readFileSync(jsPath, 'utf-8');
        inlinedScripts.push(`<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`);
        return '';
      }
      return match;
    }
  );

  if (inlinedScripts.length > 0) {
    html = html.replace(/<\/body>/i, () => `${inlinedScripts.join('\n')}\n</body>`);
  }

  cachedInlinedHtml = html;
  cachedIndexMtime = stat.mtimeMs;
  return cachedInlinedHtml;
}

// --- Incremental Watchers, Version State & SSE ---
const MAX_SSE_CLIENTS = 3;
const sseClients = new Set();
const watchers = [];
let debounceTimer = null;
let dataVersion = 1;
let lastDataChangeAt = new Date().toISOString();

function broadcastUpdate() {
  dataVersion += 1;
  lastDataChangeAt = new Date().toISOString();
  if (sseClients.size === 0) return;
  const data = JSON.stringify({ type: 'update', version: dataVersion, timestamp: Date.now() });
  for (const client of sseClients) {
    try {
      client.write(`data: ${data}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }
}

const sseHeartbeatTimer = setInterval(() => {
  if (sseClients.size === 0) return;
  for (const client of sseClients) {
    try {
      client.write(': ping\n\n');
    } catch {
      sseClients.delete(client);
    }
  }
}, 25000);
if (typeof sseHeartbeatTimer.unref === 'function') sseHeartbeatTimer.unref();

try {
  const triggerDebouncedBroadcast = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      broadcastUpdate();
    }, 1200);
  };

  if (fs.existsSync(CONVERSATIONS_DIR)) {
    watchers.push(fs.watch(CONVERSATIONS_DIR, (_eventType, filename) => {
      if (typeof filename === 'string' && filename) {
        const m = filename.match(/^([a-zA-Z0-9_-]+)\.db(?:-(?:wal|shm|journal))?$/i);
        if (!m) return;
        markSessionDirty(m[1]);
      } else {
        invalidateMasterIndexCache();
      }
      triggerDebouncedBroadcast();
    }));
  }
  if (fs.existsSync(SUMMARIES_DB_PATH)) {
    watchers.push(fs.watch(SUMMARIES_DB_PATH, () => {
      markSummariesDirty();
      triggerDebouncedBroadcast();
    }));
  }
  const summariesWalPath = `${SUMMARIES_DB_PATH}-wal`;
  if (fs.existsSync(summariesWalPath)) {
    watchers.push(fs.watch(summariesWalPath, () => {
      markSummariesDirty();
      triggerDebouncedBroadcast();
    }));
  }
} catch {
  console.error('[Anti Model Monitor] Filesystem watch unavailable, falling back to on-demand polling.');
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function resolveSafeStaticPath(pathname) {
  const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const resolvedRoot = path.resolve(PUBLIC_DIR);
  const candidate = path.resolve(resolvedRoot, relPath);
  if (candidate !== resolvedRoot && !candidate.startsWith(resolvedRoot + path.sep)) {
    return null;
  }
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }
  return path.join(resolvedRoot, 'index.html');
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

// --- HTTP Server ---
const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = urlObj.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sidecar-Token');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Compatibility stub for sidecar_sdk/preload.js optional metadata probe
  if (pathname === '/_sidecar/get-conversation-metadata') {
    sendJson(res, 200, {});
    return;
  }

  // Sidecar preload bridge script
  if (pathname === '/preload.js') {
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(PRELOAD_JS);
    return;
  }

  // Health endpoint
  if (pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      sidecar: IS_SIDECAR,
      dataDir: BASE_DIR,
      port: server.address()?.port ?? PORT
    });
    return;
  }

  // Lightweight version probe endpoint (0 SQLite / disk reads)
  if (pathname === '/api/version') {
    sendJson(res, 200, {
      version: dataVersion,
      updatedAt: lastDataChangeAt,
      dateKey: toLocalDateKey(Date.now())
    });
    return;
  }

  // Combined dashboard endpoint (1 computeWindowStats call for overview + sessions + optional heatmap)
  if (pathname === '/api/dashboard') {
    const range = urlObj.searchParams.get('range') || '7d';
    const date = urlObj.searchParams.get('date') || null;
    const startDate = urlObj.searchParams.get('start') || null;
    const endDate = urlObj.searchParams.get('end') || null;
    const focusConversationId = urlObj.searchParams.get('focusConversationId') || null;
    const workspace = urlObj.searchParams.get('workspace') || null;
    const search = urlObj.searchParams.get('search') || '';
    const model = urlObj.searchParams.get('model') || '';
    const type = urlObj.searchParams.get('type') || '';
    const page = parseInt(urlObj.searchParams.get('page') || '1', 10);
    const pageSize = parseInt(urlObj.searchParams.get('pageSize') || '500', 10);
    const includeHeatmap = urlObj.searchParams.get('includeHeatmap') === '1';
    sendJson(res, 200, {
      version: dataVersion,
      ...getDashboardData({
        range,
        date,
        startDate,
        endDate,
        focusConversationId,
        workspace,
        search,
        model,
        type,
        page,
        pageSize,
        includeHeatmap
      })
    });
    return;
  }

  // SSE endpoint (capped and heartbeat-guarded for backward compatibility)
  if (pathname === '/api/events') {
    while (sseClients.size >= MAX_SSE_CLIENTS) {
      const oldest = sseClients.values().next().value;
      if (!oldest) break;
      sseClients.delete(oldest);
      try { oldest.end(); } catch {}
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write('retry: 3000\n\n');
    res.write(`data: ${JSON.stringify({ type: 'connected', version: dataVersion })}\n\n`);
    sseClients.add(res);

    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // API: Read-only Local Account Quota (5h rolling & weekly pools)
  if (pathname === '/api/quota') {
    const force = urlObj.searchParams.get('force') === '1' || urlObj.searchParams.get('force') === 'true';
    getQuotaSnapshot({ force })
      .then((snapshot) => sendJson(res, 200, snapshot))
      .catch((err) => {
        sendJson(res, 200, {
          available: false,
          status: 'offline',
          source: 'none',
          lsVersion: null,
          planName: null,
          groups: [],
          fetchedAt: null,
          error: err instanceof Error ? err.message : 'Quota probe failed'
        });
      });
    return;
  }

  // API: Heatmap (daily calendar + 7x24 hourly matrix)
  if (pathname === '/api/heatmap') {
    sendJson(res, 200, getHeatmapData());
    return;
  }

  // API: Guard settings (read/write $PLUGIN_DATA/settings.json)
  if (pathname === '/api/guard-settings') {
    if (req.method === 'GET') {
      sendJson(res, 200, {
        settings: loadGuardSettings(),
        todayCostUsd: getTodayTotalCostUsd({ maxCacheAgeMs: 15000 }),
        contextConfig: getContextLimitConfig()
      });
      return;
    }
    if (req.method === 'POST') {
      readJsonBody(req)
        .then((body) => {
          const saved = saveGuardSettings(body);
          sendJson(res, 200, { ok: true, settings: saved });
        })
        .catch((err) => {
          sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid JSON' });
        });
      return;
    }
  }

  // API: Workspace Cost Breakdown
  if (pathname === '/api/workspaces') {
    const range = urlObj.searchParams.get('range') || '7d';
    const date = urlObj.searchParams.get('date') || null;
    const startDate = urlObj.searchParams.get('start') || null;
    const endDate = urlObj.searchParams.get('end') || null;
    sendJson(res, 200, getWorkspaceBreakdown({ range, date, startDate, endDate }));
    return;
  }

  // API: Global Overview (supports ?range=today|7d|30d|all, ?date=YYYY-MM-DD, ?start=...&end=..., ?focusConversationId=..., ?workspace=...)
  if (pathname === '/api/overview') {
    const range = urlObj.searchParams.get('range') || '7d';
    const date = urlObj.searchParams.get('date') || null;
    const startDate = urlObj.searchParams.get('start') || null;
    const endDate = urlObj.searchParams.get('end') || null;
    const focusConversationId = urlObj.searchParams.get('focusConversationId') || null;
    const workspace = urlObj.searchParams.get('workspace') || null;
    sendJson(res, 200, getOverviewData({ range, date, startDate, endDate, focusConversationId, workspace }));
    return;
  }

  // API: Sessions List (supports range, date, start, end, workspace, search, model, type, pagination)
  if (pathname === '/api/sessions') {
    const range = urlObj.searchParams.get('range') || '7d';
    const date = urlObj.searchParams.get('date') || null;
    const startDate = urlObj.searchParams.get('start') || null;
    const endDate = urlObj.searchParams.get('end') || null;
    const workspace = urlObj.searchParams.get('workspace') || null;
    const search = urlObj.searchParams.get('search') || '';
    const model = urlObj.searchParams.get('model') || '';
    const type = urlObj.searchParams.get('type') || '';
    const page = parseInt(urlObj.searchParams.get('page') || '1', 10);
    const pageSize = parseInt(urlObj.searchParams.get('pageSize') || '500', 10);
    sendJson(res, 200, getSessionsList({ range, date, startDate, endDate, workspace, search, model, type, page, pageSize }));
    return;
  }

  // API: Session Detail
  if (pathname.startsWith('/api/sessions/')) {
    const sessionId = decodeURIComponent(pathname.replace('/api/sessions/', '').trim());
    const detail = getSessionAuditDetail(sessionId, { includeTurns: true });
    if (!detail) {
      sendJson(res, 404, { error: 'Session not found' });
      return;
    }
    sendJson(res, 200, detail);
    return;
  }

  // Static files serving (render self-contained HTML for SPA root to ensure zero CORS/module issues in sidecar webviews)
  const filePath = resolveSafeStaticPath(pathname);
  if (!filePath) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') {
    const html = getRenderedIndexHtml();
    if (!html) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(html);
    return;
  }

  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

let shuttingDown = false;
function gracefulShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (debounceTimer) clearTimeout(debounceTimer);
  clearInterval(sseHeartbeatTimer);
  for (const w of watchers) {
    try { w.close(); } catch {}
  }
  for (const client of sseClients) {
    try { client.end(); } catch {}
  }
  sseClients.clear();
  server.close(() => process.exit(0));
  server.closeAllConnections?.();
  setTimeout(() => process.exit(0), 500).unref();
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, gracefulShutdown);
}

server.listen(PORT, '127.0.0.1', () => {
  const boundPort = server.address()?.port ?? PORT;
  const modeLabel = IS_SIDECAR ? 'Sidecar' : 'Standalone';
  console.error(`[Anti Model Monitor] ${modeLabel} server listening on http://127.0.0.1:${boundPort}`);
});
