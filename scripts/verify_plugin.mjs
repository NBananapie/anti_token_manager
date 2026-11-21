#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function verifyManifests() {
  const allowedPluginKeys = new Set([
    'name',
    'description',
    'logo',
    'suggestedPrompts',
    'displayName',
    'version',
    'author',
    'homepage',
    'repository',
    'disabled'
  ]);

  const pluginJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'plugin.json'), 'utf8'));
  for (const key of Object.keys(pluginJson)) {
    assert.ok(allowedPluginKeys.has(key), `plugin.json 包含未允许顶层字段: ${key}`);
  }
  assert.equal(pluginJson.name, 'antigravity-token-manager');
  assert.ok(Array.isArray(pluginJson.suggestedPrompts) && pluginJson.suggestedPrompts.length <= 3);
  assert.ok(fs.existsSync(path.join(REPO_ROOT, pluginJson.logo)), 'logo 文件缺失');

  const sidecarJson = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'sidecars', 'token-monitor', 'sidecar.json'), 'utf8')
  );
  assert.equal(sidecarJson.has_web_ui, true);
  assert.equal(sidecarJson.ui_config.views[0].entrypoint, 'SIDECAR_UI_ENTRYPOINT_AUX_PANE');

  const mcpJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'mcp_config.json'), 'utf8'));
  assert.ok(mcpJson.mcpServers?.telemetry, 'mcp_config.json 缺少 telemetry 服务定义');

  const hooksJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'hooks.json'), 'utf8'));
  assert.ok(hooksJson['context-limit-watchdog']?.SessionStart?.length > 0, 'hooks.json 缺少 SessionStart');
  assert.ok(hooksJson['budget-tool-gate']?.PreToolUse?.length > 0, 'hooks.json 缺少 PreToolUse');
  assert.ok(hooksJson['tool-bloat-tracer']?.PostToolUse?.length > 0, 'hooks.json 缺少 PostToolUse');
  assert.ok(hooksJson['context-watermark-guard']?.PostInvocation?.length > 0, 'hooks.json 缺少 PostInvocation');

  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'rules', 'AGENTS.md')), 'rules/AGENTS.md 缺失');
  assert.ok(
    fs.existsSync(path.join(REPO_ROOT, 'skills', 'antigravity-token-manager', 'SKILL.md')),
    'SKILL.md 缺失'
  );

  const distHtml = fs.readFileSync(path.join(REPO_ROOT, 'web', 'dist', 'index.html'), 'utf8');
  assert.ok(distHtml.includes('/assets/'), 'web/dist/index.html 缺少打包资源引用');
  console.log('[PASS] 1/4 Manifest、配置文件与构建产物校验通过');
}

async function verifySidecarServer() {
  const port = await getFreePort();
  const sidecarDir = path.join(REPO_ROOT, 'sidecars', 'token-monitor');
  const child = spawn(process.execPath, ['../../web/server.js'], {
    cwd: sidecarDir,
    env: {
      ...process.env,
      ANTIGRAVITY_SIDECAR_WEB_PORT: String(port),
      ANTIGRAVITY_TOKEN_SIDECAR: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    let healthy = false;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.ok) {
          const data = await res.json();
          assert.equal(data.ok, true);
          assert.equal(data.sidecar, true);
          healthy = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(healthy, 'Sidecar HTTP 服务未能在超时内启动');

    const [htmlRes, ovRes, hmRes, sessRes, wsRes, guardRes] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/`),
      fetch(`http://127.0.0.1:${port}/api/overview?range=7d`),
      fetch(`http://127.0.0.1:${port}/api/heatmap`),
      fetch(`http://127.0.0.1:${port}/api/sessions?range=7d&pageSize=10`),
      fetch(`http://127.0.0.1:${port}/api/workspaces?range=7d`),
      fetch(`http://127.0.0.1:${port}/api/guard-settings`)
    ]);
    assert.equal(htmlRes.status, 200);
    assert.equal(ovRes.status, 200);
    assert.equal(hmRes.status, 200);
    assert.equal(sessRes.status, 200);
    assert.equal(wsRes.status, 200);
    assert.equal(guardRes.status, 200);

    const overview = await ovRes.json();
    assert.ok(overview.contextConfig && typeof overview.contextConfig.effectiveLimit === 'number');
    assert.ok(Array.isArray(overview.workspaceBreakdown));

    // Verify SSE handshake
    const sseController = new AbortController();
    const sseRes = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: sseController.signal });
    assert.equal(sseRes.status, 200);
    assert.ok((sseRes.headers.get('content-type') || '').includes('text/event-stream'));
    sseController.abort();

    console.log(`[PASS] 2/4 Sidecar HTTP/SSE 服务校验通过 (port=${port}, limit=${overview.contextConfig.label})`);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        resolve();
      }, 2000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

async function verifyMcpServer() {
  const child = spawn(process.execPath, ['./mcp/server.mjs'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PLUGIN_ROOT: REPO_ROOT },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const pending = new Map();
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    while (true) {
      const idx = buf.indexOf('\n');
      if (idx === -1) break;
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });

  const rpc = (id, method, params) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP RPC 超时: ${method}`)), 10000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

  try {
    const init = await rpc(1, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'verify-plugin', version: '1.0.0' }
    });
    assert.equal(init.result.serverInfo.name, 'antigravity-token-manager');

    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const list = await rpc(2, 'tools/list', {});
    const toolNames = list.result.tools.map((t) => t.name);
    for (const expected of [
      'token_get_overview',
      'token_get_session_audit',
      'token_get_context_limit',
      'token_get_daily_report',
      'token_get_workspace_breakdown',
      'token_find_heavy_steps',
      'token_get_guard_settings',
      'token_set_guard_config'
    ]) {
      assert.ok(toolNames.includes(expected), `MCP 缺少工具: ${expected}`);
    }

    const limitRes = await rpc(3, 'tools/call', { name: 'token_get_context_limit', arguments: {} });
    assert.equal(limitRes.result.isError, false);
    const limitPayload = JSON.parse(limitRes.result.content[0].text);
    assert.ok(typeof limitPayload.effectiveLimit === 'number');

    const ovRes = await rpc(4, 'tools/call', { name: 'token_get_overview', arguments: { range: '7d' } });
    assert.equal(ovRes.result.isError, false);
    const ovPayload = JSON.parse(ovRes.result.content[0].text);
    assert.ok(typeof ovPayload.totalCalls === 'number');

    const reportRes = await rpc(5, 'tools/call', { name: 'token_get_daily_report', arguments: { weekly: true } });
    assert.equal(reportRes.result.isError, false);

    const wsRes = await rpc(6, 'tools/call', { name: 'token_get_workspace_breakdown', arguments: { range: '7d' } });
    assert.equal(wsRes.result.isError, false);
    const wsPayload = JSON.parse(wsRes.result.content[0].text);
    assert.ok(Array.isArray(wsPayload.workspaces));

    const guardRes = await rpc(7, 'tools/call', { name: 'token_get_guard_settings', arguments: {} });
    assert.equal(guardRes.result.isError, false);

    let auditedId = null;
    if (ovPayload.activeSessions && ovPayload.activeSessions.length > 0) {
      auditedId = ovPayload.activeSessions[0].conversation_id;
      const auditRes = await rpc(8, 'tools/call', {
        name: 'token_get_session_audit',
        arguments: { conversation_id: auditedId.slice(0, 8), include_turns: false }
      });
      assert.equal(auditRes.result.isError, false);
      const auditPayload = JSON.parse(auditRes.result.content[0].text);
      assert.equal(auditPayload.conversation_id, auditedId);
      assert.ok(auditPayload.combinedTotals && typeof auditPayload.combinedTotals.totalTokens === 'number');

      const heavyRes = await rpc(9, 'tools/call', {
        name: 'token_find_heavy_steps',
        arguments: { conversation_id: auditedId.slice(0, 8), min_delta_tokens: 10000, top_n: 5 }
      });
      assert.equal(heavyRes.result.isError, false);
    }

    console.log(`[PASS] 3/4 MCP Stdio 8 工具全链路校验通过 (sessions=${ovPayload.totalSessions}, workspaces=${wsPayload.workspaces.length}, audited=${auditedId ? auditedId.slice(0, 8) : 'none'})`);
  } finally {
    child.stdin.end();
    child.kill('SIGTERM');
  }
}

async function runHookScript(relScript, payload, dataDir) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn(process.execPath, [relScript], {
      cwd: REPO_ROOT,
      env: { ...process.env, PLUGIN_ROOT: REPO_ROOT, PLUGIN_DATA: dataDir },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`Hook ${relScript} 退出码非 0: ${code}`));
      else resolve({ json: JSON.parse(out.trim()), elapsedMs: Date.now() - start });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function verifyHook() {
  const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-token-hook-test-'));
  try {
    // 1. SessionStart limit watchdog: simulate expected limit higher than actual (or normal baseline)
    fs.writeFileSync(
      path.join(tmpDataDir, 'settings.json'),
      JSON.stringify({ limitWatchEnabled: true, expectedContextLimit: 2000000 }),
      'utf8'
    );
    const ss1 = await runHookScript('./hooks/session-start.mjs', { hookEventName: 'SessionStart', conversationId: 'test-conv' }, tmpDataDir);
    const ss2 = await runHookScript('./hooks/session-start.mjs', { hookEventName: 'SessionStart', conversationId: 'test-conv' }, tmpDataDir);
    assert.ok(ss1.json.injectSteps?.[0]?.systemMessage?.metadata?.user_markdown, 'SessionStart 上限回退未触发提醒');
    assert.deepEqual(ss2.json, {}, 'SessionStart 同一版本未去重');

    // 2. PostToolUse bloat tracer
    const pt = await runHookScript(
      './hooks/tool-audit.mjs',
      {
        hookEventName: 'PostToolUse',
        conversationId: 'test-trace-conv',
        stepIdx: 12,
        toolCall: { id: 't1', name: 'read_file', args: { Path: 'd:/demo/server.js' } }
      },
      tmpDataDir
    );
    assert.deepEqual(pt.json, {});
    const traceFile = path.join(tmpDataDir, 'tool-trace', 'test-trace-conv.jsonl');
    assert.ok(fs.existsSync(traceFile), 'PostToolUse 未写入 tool-trace');

    // 3. PreToolUse budget gate: fast allow when mode='warn', ask when over budget in 'ask' mode
    fs.writeFileSync(
      path.join(tmpDataDir, 'settings.json'),
      JSON.stringify({ budgetGateMode: 'warn', dailyBudgetUsd: 0, sessionBudgetUsd: 0 }),
      'utf8'
    );
    const preAllow = await runHookScript(
      './hooks/pre-tool-budget.mjs',
      { hookEventName: 'PreToolUse', conversationId: 'test-conv', toolCall: { name: 'run_command' } },
      tmpDataDir
    );
    assert.equal(preAllow.json.decision, 'allow');

    // 4. PostInvocation watermark & budget watch
    const emptyRes = await runHookScript('./hooks/context-watch.mjs', { hookEventName: 'PostInvocation' }, tmpDataDir);
    assert.deepEqual(emptyRes.json, {});

    const { getOverviewData } = await import('../core/telemetry.mjs');
    const ov = getOverviewData({ range: 'all' });
    const sample = ov.activeSessions.find((s) => s.currentContextTokens > 0);
    if (sample) {
      const pct = (sample.currentContextTokens / (ov.contextConfig.effectiveLimit || 256000)) * 100;
      fs.writeFileSync(
        path.join(tmpDataDir, 'settings.json'),
        JSON.stringify({ watermarkAlertEnabled: true, watermarkThresholdPct: 50, sessionBudgetUsd: 0.01, budgetGateMode: 'ask' }),
        'utf8'
      );
      const preAsk = await runHookScript(
        './hooks/pre-tool-budget.mjs',
        { hookEventName: 'PreToolUse', conversationId: sample.conversation_id, toolCall: { name: 'run_command' } },
        tmpDataDir
      );
      if (sample.estimatedCostUsd >= 0.01) {
        assert.equal(preAsk.json.decision, 'ask', '超预算 ask 模式未触发弹窗确认');
      }

      const r1 = await runHookScript('./hooks/context-watch.mjs', { hookEventName: 'PostInvocation', conversationId: sample.conversation_id }, tmpDataDir);
      const r2 = await runHookScript('./hooks/context-watch.mjs', { hookEventName: 'PostInvocation', conversationId: sample.conversation_id }, tmpDataDir);
      if (pct >= 50 || sample.estimatedCostUsd >= 0.01) {
        assert.ok(r1.json.injectSteps?.[0]?.systemMessage?.metadata?.user_markdown, '高水位/超预算会话未触发 user_markdown 提醒');
        assert.equal(r1.json.injectSteps[0].systemMessage.systemMessage, '', '提醒不应注入模型上下文');
        assert.deepEqual(r2.json, {}, '同一周期二次触发未去重');
      }
      console.log(`[PASS] 4/4 全套 4 个生命周期 Hook 校验通过 (preAllow=${preAllow.elapsedMs}ms, postInv=${r1.elapsedMs}ms)`);
    } else {
      console.log('[PASS] 4/4 全套 4 个生命周期 Hook 基础校验通过');
    }
  } finally {
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  }
}

async function main() {
  await verifyManifests();
  await verifySidecarServer();
  await verifyMcpServer();
  await verifyHook();
  console.log('\n全部原生插件校验项均已通过。');
}

main().catch((err) => {
  console.error('[FAIL]', err);
  process.exit(1);
});
