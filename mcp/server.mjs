import {
  loadGuardSettings,
  saveGuardSettings
} from '../core/plugin-store.mjs';
import { getQuotaSnapshot } from '../core/quota.mjs';
import {
  findHeavySteps,
  getContextLimitConfig,
  getDailyReportData,
  getOverviewData,
  getSessionAuditDetail,
  getSessionsList,
  getTodayTotalCostUsd,
  invalidateMasterIndexCache
} from '../core/telemetry.mjs';

const SERVER_INFO = {
  name: 'antigravity-token-manager',
  version: '2.1.0'
};

const TOOLS = [
  {
    name: 'token_get_overview',
    description: '查询指定时间范围、日期或项目的 Antigravity Token 消耗、双厂商（Gemini / Claude）估算费用、缓存节省比例、各模型分档速率/TTFT、项目分摊汇总、上下文压缩总数与最近活跃会话水位。',
    inputSchema: {
      type: 'object',
      properties: {
        range: {
          type: 'string',
          enum: ['today', '7d', '30d', 'all'],
          description: '时间周期：today（今日）、7d（近 7 天，默认）、30d（近 30 天）、all（全部历史）。若提供 date 则优先按 date 查询。'
        },
        date: {
          type: 'string',
          description: '可选，按指定自然日查询，格式 YYYY-MM-DD（例如 2026-11-20）。'
        },
        start_date: {
          type: 'string',
          description: '可选，自定义起始日期 YYYY-MM-DD（可单独传或配合 end_date 查询任意区间）。'
        },
        end_date: {
          type: 'string',
          description: '可选，自定义结束日期 YYYY-MM-DD。'
        },
        workspace: {
          type: 'string',
          description: '可选，按项目路径或 file:// URI 过滤统计范围。'
        },
        focus_conversation_id: {
          type: 'string',
          description: '可选，若希望确保某个指定会话出现在 activeSessions 水位快照中，传入其 conversation_id。'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'token_get_session_audit',
    description: '审计指定会话（支持完整 ID 或前缀匹配；留空则自动审计最近活跃的主会话）的上下文水位、压缩事件、单步暴涨归因、主会话分项指标以及递归合并所有派生子智能体后的总 Token 与费用。',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'string',
          description: '目标会话的 conversation_id 或其唯一前缀；若省略则默认取最近活跃的主会话。'
        },
        include_turns: {
          type: 'boolean',
          description: '是否返回完整逐轮 generations 明细（默认 false 以节省输出长度，需要逐轮轨迹时设为 true）。'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'token_get_context_limit',
    description: '以纯只读方式探测本机 language_server 二进制实际生效的上下文窗口上限（如 256K / 512K / 1M (840K)）及 Cloud Mendel 覆盖绕过状态。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'token_get_daily_report',
    description: '生成 Antigravity Token 消耗与成本结构化日报或周报（默认规则：周一统计过去 7 天，其余工作日/周末统计昨日；也可指定 date 或 weekly=true）。',
    inputSchema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: '可选，指定统计日期 YYYY-MM-DD。'
        },
        weekly: {
          type: 'boolean',
          description: '可选，设为 true 强制输出近 7 天周报汇总。'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'token_find_heavy_steps',
    description: '扫描指定会话中单步上下文增量（Token 暴涨）最严重的前 N 步，并关联 PostToolUse 记录的工具调用归因（定位是哪个文件读取或命令吃掉了大量上下文）。',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'string',
          description: '目标会话的 conversation_id 或前缀；若省略则默认取最近活跃的主会话。'
        },
        min_delta_tokens: {
          type: 'number',
          description: '最小单步增量阈值（默认 15000 tokens）。'
        },
        top_n: {
          type: 'number',
          description: '返回最多前几步（默认 8，上限 30）。'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'token_get_quota',
    description: '只读查询当前本机 Antigravity 账户各模型池（Gemini / Argon / Claude 等）的 5 小时滚动配额与周配额剩余比例及重置倒计时。',
    inputSchema: {
      type: 'object',
      properties: {
        force: {
          type: 'boolean',
          description: '是否跳过 45 秒本地缓存强制重新探测（默认 false）。'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'token_get_guard_settings',
    description: '读取当前插件的上下文高水位提醒阈值、客户端热更新上限失效巡检基线、今日/单会话费用预算上限及当前今日实时支出。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'token_set_guard_config',
    description: '更新插件守卫配置（保存在 $PLUGIN_DATA/settings.json）：可调整上下文高水位告警阈值、上限失效巡检开关与预期上限、日预算/单会话预算（USD，0 表示关闭）以及超预算门控模式（warn 仅内联提醒 / ask 弹窗二次确认）。',
    inputSchema: {
      type: 'object',
      properties: {
        watermark_alert_enabled: {
          type: 'boolean',
          description: '是否启用上下文高水位提醒。'
        },
        watermark_threshold_pct: {
          type: 'number',
          description: '高水位提醒百分比阈值（50-99，默认 85）。'
        },
        limit_watch_enabled: {
          type: 'boolean',
          description: '是否启用 SessionStart 上限失效巡检（防止客户端自动更新重置回 256K）。'
        },
        expected_context_limit: {
          type: ['number', 'null'],
          description: '预期上下文上限 token 数（例如 840000 或 512000；传 null 清除基线）。'
        },
        daily_budget_usd: {
          type: 'number',
          description: '每日估算费用预算上限（USD，设为 0 关闭）。'
        },
        session_budget_usd: {
          type: 'number',
          description: '单会话估算费用预算上限（USD，设为 0 关闭）。'
        },
        budget_gate_mode: {
          type: 'string',
          enum: ['warn', 'ask'],
          description: '超预算处置方式：warn（仅在界面内联提醒）或 ask（在 PreToolUse 弹窗要求确认后继续执行）。'
        }
      },
      additionalProperties: false
    }
  }
];

function writeMessage(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendResult(id, result) {
  writeMessage({
    jsonrpc: '2.0',
    id,
    result
  });
}

function sendError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  writeMessage({
    jsonrpc: '2.0',
    id,
    error: err
  });
}

function resolveDefaultMainSessionId(inputId) {
  const trimmed = typeof inputId === 'string' ? inputId.trim() : '';
  if (trimmed) return trimmed;
  const list = getSessionsList({ range: 'all', type: 'main', page: 1, pageSize: 1 });
  if (!list.sessions.length) {
    throw new Error('未找到任何主会话记录');
  }
  return list.sessions[0].conversation_id;
}

async function executeTool(name, args = {}) {
  if (name === 'token_get_quota') {
    return getQuotaSnapshot({ force: Boolean(args.force) });
  }

  invalidateMasterIndexCache();

  if (name === 'token_get_overview') {
    const range = typeof args.range === 'string' && args.range ? args.range : '7d';
    const date = typeof args.date === 'string' && args.date.trim() ? args.date.trim() : null;
    const startDate = typeof args.start_date === 'string' && args.start_date.trim() ? args.start_date.trim() : null;
    const endDate = typeof args.end_date === 'string' && args.end_date.trim() ? args.end_date.trim() : null;
    for (const [label, val] of [['date', date], ['start_date', startDate], ['end_date', endDate]]) {
      if (val && !/^\d{4}-\d{2}-\d{2}$/.test(val)) {
        throw new Error(`${label} 格式必须为 YYYY-MM-DD`);
      }
    }
    const workspace = typeof args.workspace === 'string' && args.workspace.trim()
      ? args.workspace.trim()
      : null;
    const focusId = typeof args.focus_conversation_id === 'string' && args.focus_conversation_id.trim()
      ? args.focus_conversation_id.trim()
      : null;
    return getOverviewData({ range, date, startDate, endDate, focusConversationId: focusId, workspace });
  }

  if (name === 'token_get_session_audit') {
    const targetId = resolveDefaultMainSessionId(args.conversation_id);
    const includeTurns = Boolean(args.include_turns);
    const detail = getSessionAuditDetail(targetId, { includeTurns });
    if (!detail) {
      throw new Error(`未找到匹配的会话记录: ${targetId}`);
    }
    return detail;
  }

  if (name === 'token_get_context_limit') {
    return getContextLimitConfig();
  }

  if (name === 'token_get_daily_report') {
    const date = typeof args.date === 'string' && args.date.trim() ? args.date.trim() : null;
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error('date 格式必须为 YYYY-MM-DD');
    }
    const weekly = Boolean(args.weekly);
    return getDailyReportData({ date, weekly });
  }

  if (name === 'token_find_heavy_steps') {
    const targetId = resolveDefaultMainSessionId(args.conversation_id);
    const result = findHeavySteps(targetId, {
      minDeltaTokens: args.min_delta_tokens,
      topN: args.top_n
    });
    if (!result) {
      throw new Error(`未找到匹配的会话记录: ${targetId}`);
    }
    return result;
  }

  if (name === 'token_get_guard_settings') {
    const settings = loadGuardSettings();
    const contextConfig = getContextLimitConfig();
    const todayCostUsd = getTodayTotalCostUsd({ maxCacheAgeMs: 10000 });
    return {
      settings,
      todayCostUsd,
      contextConfig
    };
  }

  if (name === 'token_set_guard_config') {
    const patch = {};
    if (args.watermark_alert_enabled !== undefined) patch.watermarkAlertEnabled = args.watermark_alert_enabled;
    if (args.watermark_threshold_pct !== undefined) patch.watermarkThresholdPct = args.watermark_threshold_pct;
    if (args.limit_watch_enabled !== undefined) patch.limitWatchEnabled = args.limit_watch_enabled;
    if (args.expected_context_limit !== undefined) patch.expectedContextLimit = args.expected_context_limit;
    if (args.daily_budget_usd !== undefined) patch.dailyBudgetUsd = args.daily_budget_usd;
    if (args.session_budget_usd !== undefined) patch.sessionBudgetUsd = args.session_budget_usd;
    if (args.budget_gate_mode !== undefined) patch.budgetGateMode = args.budget_gate_mode;
    const saved = saveGuardSettings(patch);
    return { ok: true, settings: saved };
  }

  throw new Error(`未知工具: ${name}`);
}

function handleRequest(req) {
  if (!req || typeof req !== 'object') return;
  const { id, method, params } = req;

  if (id === undefined || id === null) {
    return;
  }

  if (method === 'initialize') {
    const clientVersion = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05';
    sendResult(id, {
      protocolVersion: clientVersion,
      capabilities: {
        tools: {}
      },
      serverInfo: SERVER_INFO
    });
    return;
  }

  if (method === 'ping') {
    sendResult(id, {});
    return;
  }

  if (method === 'tools/list') {
    sendResult(id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    Promise.resolve()
      .then(() => executeTool(toolName, toolArgs))
      .then((payload) => {
        sendResult(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(payload, null, 2)
            }
          ],
          isError: false
        });
      })
      .catch((err) => {
        sendResult(id, {
          content: [
            {
              type: 'text',
              text: `Error: ${err instanceof Error ? err.message : String(err)}`
            }
          ],
          isError: true
        });
      });
    return;
  }

  sendError(id, -32601, `Method not found: ${method}`);
}

process.stdin.setEncoding('utf8');
let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const nlIndex = buffer.indexOf('\n');
    if (nlIndex === -1) break;
    const line = buffer.slice(0, nlIndex).trim();
    buffer = buffer.slice(nlIndex + 1);
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      handleRequest(parsed);
    } catch (err) {
      console.error('[antigravity-token-manager MCP] Invalid JSON input:', err instanceof Error ? err.message : String(err));
    }
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => process.exit(0));
}
