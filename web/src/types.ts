export interface SpeedMetrics {
  avgTtftSec: number | null;
  streamTps: number | null;
  e2eTps: number | null;
  thinkingSharePct: number;
}

export interface ContextLimitConfig {
  detected: boolean;
  effectiveLimit: number;
  configuredLimit: number;
  cloudOverrideBypassed: boolean;
  label: string;
}

export interface CacheAnomaly {
  kind: 'cleared' | 'dropped' | 'missed';
  stepIndex: number;
  timestampMs: number;
  model: string;
  gapSec: number;
  prevStepIndex: number;
  prevHitPct: number;
  curHitPct: number;
  prevCacheTokens: number;
  curCacheTokens: number;
  contextTokens: number;
  wastedCostUsd: number;
}

export interface QuotaWindow {
  available: boolean;
  bucketId: string | null;
  remainingFraction: number | null;
  remainingPct: number | null;
  resetAt: string | null;
  resetInSec: number | null;
  expired: boolean;
  disabled: boolean;
  description: string;
}

export interface QuotaPoolGroup {
  id: string;
  poolKey: 'gemini' | 'argon' | 'claude' | 'other';
  name: string;
  rawName: string;
  description: string;
  windows: {
    '5h': QuotaWindow;
    weekly: QuotaWindow;
  };
}

export interface QuotaSnapshot {
  available: boolean;
  status: 'live' | 'stale' | 'offline';
  source: 'sidecar-env' | 'daemon-file' | 'cache' | 'none';
  lsVersion: string | null;
  planName: string | null;
  groups: QuotaPoolGroup[];
  fetchedAt: string | null;
  error: string | null;
}

export interface ActiveSessionSnapshot {
  conversation_id: string;
  title: string;
  latestModel: string;
  last_modified_time: string;
  currentContextTokens: number;
  lastInputTokens: number;
  lastCacheReadTokens: number;
  peakContextTokens: number;
  compactionCount: number;
  cacheAnomalyCount?: number;
  cacheAnomalyWastedUsd?: number;
  totalCalls: number;
  estimatedCostUsd: number;
  cacheSavingsUsd: number;
  streamTps: number | null;
  avgTtftSec: number | null;
  childCount: number;
}

export interface WorkspaceSummary {
  key: string;
  label: string;
  uri: string;
  sessions: number;
  calls: number;
  totalTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  cacheHitPct: number;
  estimatedCostUsd: number;
  cacheSavingsUsd: number;
  compactions: number;
  lastActiveMs: number;
}

export interface ToolAttribution {
  stepIndex: number;
  toolName: string;
  target: string;
  bytes?: number;
  error?: string;
}

export interface HeavyStepSummary {
  stepIndex: number;
  timestampMs: number;
  model: string;
  deltaContextTokens: number;
  contextTokens: number;
  costUsd: number;
  tools: ToolAttribution[];
  calledTools?: ToolAttribution[];
}

export interface GuardSettings {
  watermarkAlertEnabled: boolean;
  watermarkThresholdPct: number;
  limitWatchEnabled: boolean;
  expectedContextLimit: number | null;
  dailyBudgetUsd: number;
  sessionBudgetUsd: number;
  budgetGateMode: 'warn' | 'ask';
}

export interface GlobalOverview {
  range: string;
  date: string | null;
  workspaceFilter?: string[] | null;
  dateFrom: string | null;
  dateTo: string | null;
  totalSessions: number;
  totalCalls: number;
  totalTokens: number;
  totalInputTokens?: number;
  totalCacheReadTokens: number;
  totalOutputTokens?: number;
  totalEstimatedCostUsd: number;
  totalCacheSavingsUsd: number;
  cacheSavingsPct: number;
  totalCompactions: number;
  totalCacheAnomalies?: number;
  totalCacheAnomalyWastedUsd?: number;
  globalSpeed: SpeedMetrics;
  typeCounts: {
    main: number;
    subagent: number;
    side_query: number;
  };
  modelTotals: Record<string, number>;
  modelSessionCount: Record<string, number>;
  modelCosts?: Record<string, number>;
  modelTokens?: Record<string, number>;
  modelSpeed: Record<string, SpeedMetrics>;
  workspaceBreakdown?: WorkspaceSummary[];
  contextConfig: ContextLimitConfig;
  activeSessions: ActiveSessionSnapshot[];
  updatedAt: string;
}

export interface HeatmapDay {
  date: string;
  tokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costUsd: number;
  calls: number;
  sessions: number;
  compactions: number;
}

export interface HeatmapHourCell {
  tokens: number;
  costUsd: number;
  calls: number;
}

export interface HeatmapData {
  daily: HeatmapDay[];
  hourlyMatrix: HeatmapHourCell[][];
  minDate: string | null;
  maxDate: string | null;
  updatedAt: string;
}

export interface SessionItem {
  conversation_id: string;
  title: string;
  sessionType: 'main' | 'subagent' | 'side_query';
  agentName: string;
  parentId: string;
  childCount: number;
  workspaceKey?: string;
  workspaceLabel?: string;
  workspaceUris?: string[];
  preview: string;
  step_count: number;
  last_modified_time: string;
  calls: number;
  latestModel: string;
  modelsUsed: string[];
  modelCounts: Record<string, number>;
  totalInputTokens: number;
  totalCacheReadTokens: number;
  totalOutputTokens: number;
  totalThinkingTokens: number;
  totalResponseTokens: number;
  currentContextTokens: number;
  peakContextTokens: number;
  compactionCount: number;
  cacheAnomalyCount?: number;
  cacheAnomalyWastedUsd?: number;
  estimatedCostUsd: number;
  cacheSavingsUsd: number;
  avgTtftSec: number | null;
  streamTps: number | null;
  e2eTps: number | null;
  thinkingSharePct: number;
}

export interface CheckpointEvent {
  index: number;
  stepIndex: number;
  timestampMs: number;
  beforeStepIndex: number | null;
  afterStepIndex: number | null;
  peakContext: number;
  resetContext: number | null;
  reductionPct: number | null;
  model?: string;
  inputTokens?: number;
  cacheReadTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface ChildSessionSummary {
  conversation_id: string;
  title: string;
  agentName: string;
  latestModel: string;
  modelsUsed: string[];
  calls: number;
  totalTokens: number;
  estimatedCostUsd: number;
  compactionCount: number;
  firstTimestampMs: number;
  lastTimestampMs: number;
}

export interface GenerationTurn {
  idx: number;
  stepIndex: number;
  timestampMs: number;
  model: string;
  inputTokens: number;
  cacheReadTokens: number;
  contextTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  responseTokens: number;
  costUsd: number;
  cacheSavingsUsd: number;
  ttftSec: number | null;
  streamSec: number | null;
  totalSec: number | null;
  streamTps: number | null;
  e2eTps: number | null;
  deltaContextTokens?: number;
  isPostCompaction?: boolean;
  cacheAnomaly?: CacheAnomaly;
  bloatTools?: ToolAttribution[];
  calledTools?: ToolAttribution[];
  metadata: Record<string, string>;
}

export interface SessionDetail extends SessionItem {
  totalCalls: number;
  firstTimestampMs: number;
  lastTimestampMs: number;
  cacheSavingsPct: number;
  checkpoints: CheckpointEvent[];
  cacheAnomalies?: CacheAnomaly[];
  heavySteps?: HeavyStepSummary[];
  childSessions: ChildSessionSummary[];
  parentSession: { conversation_id: string; title: string } | null;
  contextConfig: ContextLimitConfig;
  generations: GenerationTurn[];
}

export type TimeRange = 'today' | '7d' | '30d' | 'all' | 'custom';

export function getModelColor(model: string): string {
  const m = (model || '').toLowerCase();
  if (m.includes('claude')) return '#e11d48';
  if (m.includes('orchestrator')) return '#9333ea';
  if (m.includes('neon')) return '#f97316';
  if (m.includes('hydrogen')) return '#0284c7';
  if (m.includes('carbon')) return '#0d9488';
  if (m.includes('argon')) return '#4f46e5';
  if (m.includes('-n')) return '#10b981';
  if (m.includes('-exp-a')) return '#8b5cf6';
  if (m.includes('-exp-b')) return '#f59e0b';
  if (m.includes('flash')) return '#2563eb';
  return '#64748b';
}

export type TierTone = 'xhigh' | 'high' | 'medium' | 'low' | 'neutral';

export function splitModelTier(model: string): { base: string; tier: string | null; tone: TierTone } {
  if (!model) return { base: 'unknown', tier: null, tone: 'neutral' };
  const m = model.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (!m) return { base: model, tier: null, tone: 'neutral' };
  const base = m[1].trim();
  const tier = m[2].trim();
  const tLow = tier.toLowerCase();
  let tone: TierTone = 'neutral';
  if (tLow === 'xhigh' || tLow === 'max') tone = 'xhigh';
  else if (tLow === 'high' || tLow === 'thinking') tone = 'high';
  else if (tLow === 'medium') tone = 'medium';
  else if (tLow === 'low') tone = 'low';
  return { base, tier, tone };
}

export function formatCompactTokens(n: number): string {
  if (!n || n <= 0) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString();
}

export function formatUsd(amount: number | undefined): string {
  if (amount == null || Number.isNaN(amount)) return '-';
  if (amount === 0) return '$0.00';
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  if (amount < 100) return `$${amount.toFixed(2)}`;
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatRelativeTime(isoOrMs: string | number): string {
  if (!isoOrMs) return '-';
  const d = new Date(isoOrMs);
  if (Number.isNaN(d.getTime())) return '-';
  const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diffSec < 60 && diffSec >= 0) return '刚刚';
  if (diffSec < 3600 && diffSec >= 0) return `${Math.floor(diffSec / 60)} 分钟前`;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hhmm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (sameDay) return `今天 ${hhmm}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();
  if (isYesterday) return `昨天 ${hhmm}`;
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd} ${hhmm}`;
}

export function formatShortDateTime(ms: number): string {
  if (!ms) return '-';
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

export function formatTimeHms(ms: number): string {
  if (!ms) return '-';
  const d = new Date(ms);
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

export function getContextHealthClass(pct: number): 'ok' | 'warn' | 'danger' {
  if (pct >= 85) return 'danger';
  if (pct >= 65) return 'warn';
  return 'ok';
}

export function getQuotaHealthClass(remainingPct: number | null): 'ok' | 'warn' | 'danger' {
  if (remainingPct == null) return 'ok';
  if (remainingPct <= 20) return 'danger';
  if (remainingPct <= 50) return 'warn';
  return 'ok';
}

export function formatCountdownSec(totalSec: number | null): string {
  if (totalSec == null || !Number.isFinite(totalSec)) return '-';
  const s = Math.max(0, Math.round(totalSec));
  if (s < 60) return '<1分钟';
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days}天${hours}小时` : `${days}天`;
  if (hours > 0) return mins > 0 ? `${hours}小时${mins}分` : `${hours}小时`;
  return `${mins}分钟`;
}

export function getCacheAnomalyLabel(kind: CacheAnomaly['kind']): string {
  if (kind === 'cleared') return '缓存清零';
  if (kind === 'dropped') return '命中骤降';
  return '缓存未命中';
}

// Deterministic, irreversible privacy masking helpers (zero original text leakage)
export function maskSessionId(id: string): string {
  if (!id) return '••••';
  return `${id.slice(0, 4)}••••`;
}

export function maskSessionTitle(
  id: string,
  sessionType?: 'main' | 'subagent' | 'side_query',
  agentName?: string
): string {
  // Derive deterministic short tag (01..99) from conversation_id so titles stay consistent across views
  let hash = 0;
  for (let i = 0; i < (id || '').length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  const num = String((hash % 99) + 1).padStart(2, '0');
  const shortCode = (id || '0000').slice(0, 4).toUpperCase();
  if (sessionType === 'subagent') {
    return agentName ? `子任务 · ${agentName} #${num}` : `子智能体任务 #${num}`;
  }
  if (sessionType === 'side_query') {
    return `侧栏提问 #${num} (${shortCode})`;
  }
  return `隐私会话 #${num} · ${shortCode}`;
}

export function applyColorSchemeMeta(scheme: string | null) {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  if (meta) {
    meta.content = scheme === 'light' || scheme === 'dark' ? scheme : 'light dark';
  }
}

export function toggleColorScheme() {
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const systemScheme = systemDark ? 'dark' : 'light';
  let stored: string | null = null;
  try {
    stored = localStorage.getItem('color-scheme');
  } catch {}
  const currentRendered = stored === 'light' || stored === 'dark' ? stored : systemScheme;
  const target = currentRendered === 'dark' ? 'light' : 'dark';

  if (target === systemScheme) {
    try {
      localStorage.removeItem('color-scheme');
    } catch {}
    applyColorSchemeMeta(null);
  } else {
    try {
      localStorage.setItem('color-scheme', target);
    } catch {}
    applyColorSchemeMeta(target);
  }
}
