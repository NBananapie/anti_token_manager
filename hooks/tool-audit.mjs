import fs from 'node:fs';
import path from 'node:path';
import { appendToolTrace } from '../core/plugin-store.mjs';

const SENSITIVE_PATTERN = /(api[_-]?key|token|secret|password|authorization|bearer)/i;

function readStdinText() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function summarizeTarget(toolName, args) {
  if (!args || typeof args !== 'object') return '';
  const name = String(toolName || '').toLowerCase();

  if (args.Path || args.path || args.file_path || args.AbsolutePath) {
    const rawPath = String(args.Path || args.path || args.file_path || args.AbsolutePath);
    return path.basename(rawPath).slice(0, 60);
  }
  if (args.toolSummary) {
    return String(args.toolSummary).trim().slice(0, 60);
  }
  if (name === 'call_mcp_tool' && args.ServerName && args.ToolName) {
    return `${args.ServerName}/${args.ToolName}`.slice(0, 60);
  }
  if (args.CommandLine) {
    const cmd = String(args.CommandLine).replace(/\s+/g, ' ').trim();
    if (SENSITIVE_PATTERN.test(cmd)) return '[command redacted]';
    return cmd.slice(0, 48);
  }
  if (args.query || args.Query) {
    return String(args.query || args.Query).trim().slice(0, 48);
  }
  if (args.Role && args.TypeName) {
    return `${args.TypeName}: ${args.Role}`.slice(0, 60);
  }
  if (args.url || args.Url) {
    try {
      const u = new URL(String(args.url || args.Url));
      return `${u.hostname}${u.pathname}`.slice(0, 60);
    } catch {
      return '';
    }
  }
  return '';
}

function main() {
  const raw = readStdinText();
  if (raw && raw.trim()) {
    try {
      const input = JSON.parse(raw);
      const conversationId = typeof input.conversationId === 'string' ? input.conversationId.trim() : '';
      const toolCall = input.toolCall && typeof input.toolCall === 'object' ? input.toolCall : null;
      if (conversationId && toolCall && toolCall.name) {
        const entry = {
          ts: Date.now(),
          stepIdx: typeof input.stepIdx === 'number' ? input.stepIdx : null,
          toolName: String(toolCall.name).slice(0, 64),
          target: summarizeTarget(toolCall.name, toolCall.args),
          error: typeof input.error === 'string' && input.error ? input.error.slice(0, 80) : ''
        };
        appendToolTrace(conversationId, entry);
      }
    } catch {
      // Non-fatal
    }
  }
  process.stdout.write('{}\n');
}

main();
