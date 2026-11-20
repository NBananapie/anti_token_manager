import {
  getContextLimitConfig,
  getDailyReportData,
  getOverviewData,
  getSessionAuditDetail,
  getSessionsList,
  invalidateMasterIndexCache
} from '../core/telemetry.mjs';

const SERVER_INFO = {
  name: 'antigravity-token-manager',
  version: '2.0.0'
};

const TOOLS = [
  {
    name: 'token_get_overview',
    description: '查询指定时间范围或日期的 Antigravity Token 消耗、双厂商（Gemini / Claude）估算费用、缓存节省比例、各模型分档速率/TTFT、上下文压缩总数与最近活跃会话水位。',
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
    description: '审计指定会话（支持完整 ID 或前缀匹配；留空则自动审计最近活跃的主会话）的上下文水位、压缩事件、主会话分项指标以及递归合并所有派生子智能体后的总 Token 与费用。',
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

function executeTool(name, args = {}) {
  // Ensure fresh read from SQLite on explicit agent queries
  invalidateMasterIndexCache();

  if (name === 'token_get_overview') {
    const range = typeof args.range === 'string' && args.range ? args.range : '7d';
    const date = typeof args.date === 'string' && args.date.trim() ? args.date.trim() : null;
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error('date 格式必须为 YYYY-MM-DD');
    }
    const focusId = typeof args.focus_conversation_id === 'string' && args.focus_conversation_id.trim()
      ? args.focus_conversation_id.trim()
      : null;
    return getOverviewData({ range, date, focusConversationId: focusId });
  }

  if (name === 'token_get_session_audit') {
    let targetId = typeof args.conversation_id === 'string' ? args.conversation_id.trim() : '';
    const includeTurns = Boolean(args.include_turns);

    if (!targetId) {
      const list = getSessionsList({ range: 'all', type: 'main', page: 1, pageSize: 1 });
      if (!list.sessions.length) {
        throw new Error('未找到任何主会话记录');
      }
      targetId = list.sessions[0].conversation_id;
    }

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

  throw new Error(`未知工具: ${name}`);
}

function handleRequest(req) {
  if (!req || typeof req !== 'object') return;
  const { id, method, params } = req;

  // Notifications carry no id and expect no response
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
    try {
      const payload = executeTool(toolName, toolArgs);
      sendResult(id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify(payload, null, 2)
          }
        ],
        isError: false
      });
    } catch (err) {
      sendResult(id, {
        content: [
          {
            type: 'text',
            text: `Error: ${err instanceof Error ? err.message : String(err)}`
          }
        ],
        isError: true
      });
    }
    return;
  }

  sendError(id, -32601, `Method not found: ${method}`);
}

// --- Stdio JSON-RPC Line Reader ---
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
