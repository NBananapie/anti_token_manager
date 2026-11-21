import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Activity,
  RefreshCw,
  Search,
  Database,
  X,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  ArrowUpDown,
  Bot,
  MessageSquare,
  Compass,
  Coins,
  Sun,
  Moon,
  Layers,
  CalendarDays,
  Eye,
  EyeOff,
  Shield,
  FolderKanban,
  ExternalLink
} from 'lucide-react';
import {
  GlobalOverview,
  HeatmapData,
  SessionDetail,
  SessionItem,
  TimeRange,
  applyColorSchemeMeta,
  formatCompactTokens,
  formatRelativeTime,
  formatUsd,
  getContextHealthClass,
  getModelColor,
  maskSessionId,
  maskSessionTitle,
  splitModelTier,
  toggleColorScheme
} from './types';
import ContextMonitorCard from './components/ContextMonitorCard';
import TokenHeatmap from './components/TokenHeatmap';
import SessionDetailPage from './components/SessionDetailPage';
import ModelBadge from './components/ModelBadge';
import GuardSettingsDrawer from './components/GuardSettingsDrawer';
import {
  apiFetch,
  canJumpHostConversation,
  createApiEventSource,
  getHostConversationId,
  isInSidecar,
  jumpToHostConversation,
  observeHostTheme,
  subscribeHostWorkspaces
} from './sidecarBridge';

type ModelSortBy = 'calls' | 'recent' | 'speed' | 'ttft';
type TableSortKey = 'time' | 'calls' | 'speed' | 'tokens' | 'cost' | 'context';
type SortDir = 'asc' | 'desc';
type CompactTab = 'live' | 'stats' | 'sessions';

function parseSessionIdFromHash(): string | null {
  const h = window.location.hash || '';
  const m = h.match(/^#\/session\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function getInitialPrivacyMode(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    const p = params.get('privacy');
    if (p === '1' || p === 'true') return true;
    if (p === '0' || p === 'false') return false;
    return localStorage.getItem('privacy-mode') === '1';
  } catch {
    return false;
  }
}

export default function App() {
  const [overview, setOverview] = useState<GlobalOverview | null>(null);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [heatmap, setHeatmap] = useState<HeatmapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sseConnected, setSseConnected] = useState(false);
  const [privacyMode, setPrivacyMode] = useState<boolean>(() => getInitialPrivacyMode());
  const [inSidecar] = useState<boolean>(() => isInSidecar());
  const [hostConversationId, setHostConversationId] = useState<string | null>(() => getHostConversationId());
  const [followHost, setFollowHost] = useState<boolean>(true);
  const [isCompact, setIsCompact] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth < 720 : false
  );
  const [compactTab, setCompactTab] = useState<CompactTab>('live');
  const [showGuardSettings, setShowGuardSettings] = useState<boolean>(false);
  const [hostWorkspaceUris, setHostWorkspaceUris] = useState<string[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(null);
  const canJumpConv = canJumpHostConversation();

  const handleTogglePrivacy = () => {
    setPrivacyMode((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('privacy-mode', next ? '1' : '0');
      } catch {}
      return next;
    });
  };

  // Global time range (defaults to 7d) + optional heatmap exact date drill-down
  const [timeRange, setTimeRange] = useState<TimeRange>('7d');
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  // Filters & sorting
  const [search, setSearch] = useState('');
  const [selectedModel, setSelectedModel] = useState<string>('ALL');
  const [selectedType, setSelectedType] = useState<string>('ALL');
  const [modelSortBy, setModelSortBy] = useState<ModelSortBy>('calls');
  const [showAllModels, setShowAllModels] = useState(false);
  const [hoveredModel, setHoveredModel] = useState<string | null>(null);
  const [tableSort, setTableSort] = useState<{ key: TableSortKey; dir: SortDir }>({
    key: 'time',
    dir: 'desc'
  });

  // Independent Session Detail Page route state
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => parseSessionIdFromHash());
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const activeSessionIdRef = useRef<string | null>(activeSessionId);
  const hostConvRef = useRef<string | null>(hostConversationId);
  const rangeRef = useRef<{ range: TimeRange; date: string | null; workspace: string | null }>({
    range: timeRange,
    date: selectedDate,
    workspace: selectedWorkspace
  });
  const savedScrollYRef = useRef<number>(0);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    hostConvRef.current = hostConversationId;
  }, [hostConversationId]);

  useEffect(() => {
    rangeRef.current = { range: timeRange, date: selectedDate, workspace: selectedWorkspace };
  }, [timeRange, selectedDate, selectedWorkspace]);

  // Responsive compact mode for Antigravity narrow Aux Pane (< 720px)
  useEffect(() => {
    const onResize = () => setIsCompact(window.innerWidth < 720);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Sidecar host theme sync, workspace subscription & active conversation tracking
  useEffect(() => {
    const stopTheme = observeHostTheme();
    const stopWs = subscribeHostWorkspaces((uris) => {
      setHostWorkspaceUris(uris);
    });
    const timer = window.setInterval(() => {
      const nextHostId = getHostConversationId();
      if (nextHostId && nextHostId !== hostConvRef.current) {
        setHostConversationId(nextHostId);
        setFollowHost(true);
      }
    }, 1500);
    return () => {
      stopTheme();
      stopWs();
      window.clearInterval(timer);
    };
  }, []);

  // Cross-tab color-scheme sync
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'color-scheme') applyColorSchemeMeta(e.newValue);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Browser back/forward hash sync
  useEffect(() => {
    const onHashChange = () => {
      const id = parseSessionIdFromHash();
      setActiveSessionId(id);
      if (!id) {
        setTimeout(() => window.scrollTo({ top: savedScrollYRef.current, behavior: 'instant' as ScrollBehavior }), 0);
      }
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const openSession = useCallback((id: string) => {
    if (!activeSessionIdRef.current) {
      savedScrollYRef.current = window.scrollY;
    }
    const targetHash = `#/session/${encodeURIComponent(id)}`;
    if (window.location.hash !== targetHash) {
      window.location.hash = targetHash;
    }
    setActiveSessionId(id);
  }, []);

  const backToOverview = useCallback(() => {
    if (window.location.hash) {
      history.pushState(null, '', window.location.pathname + window.location.search);
    }
    setActiveSessionId(null);
    setSessionDetail(null);
    setTimeout(() => window.scrollTo({ top: savedScrollYRef.current, behavior: 'instant' as ScrollBehavior }), 0);
  }, []);

  const fetchSessionDetail = useCallback(async (id: string, silent = false) => {
    if (!silent) setDetailLoading(true);
    try {
      const res = await apiFetch(`./api/sessions/${encodeURIComponent(id)}`);
      if (res.ok) {
        const data = await res.json();
        if (activeSessionIdRef.current === id) {
          setSessionDetail(data);
        }
      }
    } catch (err) {
      console.error('Session detail error:', err);
    } finally {
      if (!silent) setDetailLoading(false);
    }
  }, []);

  const fetchDashboardData = useCallback(
    async (range: TimeRange, date: string | null, includeHeatmap = false, workspace: string | null = null) => {
      try {
        setRefreshing(true);
        const q = date
          ? `date=${encodeURIComponent(date)}`
          : `range=${encodeURIComponent(range)}`;
        const wsParam = workspace ? `&workspace=${encodeURIComponent(workspace)}` : '';
        const focusParam = hostConvRef.current
          ? `&focusConversationId=${encodeURIComponent(hostConvRef.current)}`
          : '';
        const reqs: Promise<Response>[] = [
          apiFetch(`./api/overview?${q}${wsParam}${focusParam}`),
          apiFetch(`./api/sessions?${q}${wsParam}&pageSize=500`)
        ];
        if (includeHeatmap) reqs.push(apiFetch('./api/heatmap'));

        const responses = await Promise.all(reqs);
        if (responses[0].ok) setOverview(await responses[0].json());
        if (responses[1].ok) {
          const sd = await responses[1].json();
          setSessions(sd.sessions || []);
        }
        if (includeHeatmap && responses[2]?.ok) {
          setHeatmap(await responses[2].json());
        }
      } catch (err) {
        console.error('Fetch error:', err);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    []
  );

  // Re-fetch when timeRange, selectedDate, selectedWorkspace, or hostConversationId changes
  useEffect(() => {
    fetchDashboardData(timeRange, selectedDate, heatmap === null, selectedWorkspace);
  }, [timeRange, selectedDate, selectedWorkspace, hostConversationId, fetchDashboardData]);

  // Fetch detail when activeSessionId changes
  useEffect(() => {
    if (!activeSessionId) {
      setSessionDetail(null);
      return;
    }
    fetchSessionDetail(activeSessionId, false);
  }, [activeSessionId, fetchSessionDetail]);

  // SSE live updates
  useEffect(() => {
    const es = createApiEventSource('./api/events');
    es.onopen = () => setSseConnected(true);
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'update') {
          const { range, date, workspace } = rangeRef.current;
          fetchDashboardData(range, date, true, workspace);
          if (activeSessionIdRef.current) {
            fetchSessionDetail(activeSessionIdRef.current, true);
          }
        }
      } catch {}
    };
    es.onerror = () => setSseConnected(false);
    return () => es.close();
  }, [fetchDashboardData, fetchSessionDetail]);

  const handleManualRefresh = () => {
    fetchDashboardData(timeRange, selectedDate, true, selectedWorkspace);
    if (activeSessionId) fetchSessionDetail(activeSessionId, false);
  };

  const handleSelectTimeRange = (r: TimeRange) => {
    setSelectedDate(null);
    setTimeRange(r);
  };

  // Derived latest activity timestamp per model from sessions
  const modelLastActiveMs = useMemo(() => {
    const map: Record<string, number> = {};
    for (const s of sessions) {
      const ts = new Date(s.last_modified_time || 0).getTime();
      if (!ts || Number.isNaN(ts)) continue;
      for (const m of s.modelsUsed || []) {
        if (!map[m] || ts > map[m]) map[m] = ts;
      }
    }
    return map;
  }, [sessions]);

  const sortedModels = useMemo(() => {
    if (!overview) return [];
    const totalCalls = overview.totalCalls || 1;
    const list = Object.entries(overview.modelTotals).map(([model, calls]) => {
      const speed = overview.modelSpeed?.[model];
      return {
        model,
        calls,
        pct: (calls / totalCalls) * 100,
        sessions: overview.modelSessionCount?.[model] || 0,
        cost: overview.modelCosts?.[model] ?? 0,
        lastActiveMs: modelLastActiveMs[model] ?? 0,
        streamTps: speed?.streamTps ?? null,
        avgTtftSec: speed?.avgTtftSec ?? null,
        color: getModelColor(model)
      };
    });

    list.sort((a, b) => {
      if (modelSortBy === 'recent') return b.lastActiveMs - a.lastActiveMs || b.calls - a.calls;
      if (modelSortBy === 'speed') return (b.streamTps ?? -1) - (a.streamTps ?? -1) || b.calls - a.calls;
      if (modelSortBy === 'ttft') {
        return (a.avgTtftSec ?? Infinity) - (b.avgTtftSec ?? Infinity) || b.calls - a.calls;
      }
      return b.calls - a.calls;
    });
    return list;
  }, [overview, modelSortBy, modelLastActiveMs]);

  const ratioSegments = useMemo(() => {
    if (!overview) return [];
    const totalCalls = overview.totalCalls || 1;
    return Object.entries(overview.modelTotals)
      .map(([model, calls]) => ({
        model,
        calls,
        pct: (calls / totalCalls) * 100,
        color: getModelColor(model)
      }))
      .sort((a, b) => b.calls - a.calls);
  }, [overview]);

  const DEFAULT_VISIBLE_MODELS = 6;
  const visibleModels = useMemo(() => {
    if (showAllModels || sortedModels.length <= DEFAULT_VISIBLE_MODELS) return sortedModels;
    const top = sortedModels.slice(0, DEFAULT_VISIBLE_MODELS);
    if (selectedModel !== 'ALL' && !top.some((m) => m.model === selectedModel)) {
      const activeItem = sortedModels.find((m) => m.model === selectedModel);
      if (activeItem) return [...top, activeItem];
    }
    return top;
  }, [sortedModels, showAllModels, selectedModel]);

  const hiddenModelCount = Math.max(0, sortedModels.length - visibleModels.length);

  const cacheHitPct = useMemo(() => {
    if (!overview) return 0;
    const promptTotal = (overview.totalInputTokens ?? 0) + (overview.totalCacheReadTokens ?? 0);
    if (promptTotal > 0) return (overview.totalCacheReadTokens / promptTotal) * 100;
    if (overview.totalTokens > 0) return (overview.totalCacheReadTokens / overview.totalTokens) * 100;
    return 0;
  }, [overview]);

  const filteredSessions = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = sessions.filter((s) => {
      const matchSearch =
        !q ||
        s.title.toLowerCase().includes(q) ||
        s.conversation_id.toLowerCase().includes(q) ||
        (s.agentName && s.agentName.toLowerCase().includes(q)) ||
        (s.modelsUsed && s.modelsUsed.some((m) => m.toLowerCase().includes(q)));

      const matchModel =
        selectedModel === 'ALL' || (s.modelsUsed && s.modelsUsed.includes(selectedModel));

      const matchType = selectedType === 'ALL' || s.sessionType === selectedType;
      return matchSearch && matchModel && matchType;
    });

    const mult = tableSort.dir === 'desc' ? -1 : 1;
    return [...list].sort((a, b) => {
      switch (tableSort.key) {
        case 'calls':
          return (a.calls - b.calls) * mult;
        case 'speed':
          return ((a.streamTps ?? -1) - (b.streamTps ?? -1)) * mult;
        case 'context':
          return ((a.currentContextTokens || 0) - (b.currentContextTokens || 0)) * mult;
        case 'tokens': {
          const ta = a.totalInputTokens + a.totalCacheReadTokens + a.totalOutputTokens;
          const tb = b.totalInputTokens + b.totalCacheReadTokens + b.totalOutputTokens;
          return (ta - tb) * mult;
        }
        case 'cost':
          return ((a.estimatedCostUsd ?? 0) - (b.estimatedCostUsd ?? 0)) * mult;
        case 'time':
        default: {
          const ta = new Date(a.last_modified_time || 0).getTime();
          const tb = new Date(b.last_modified_time || 0).getTime();
          return (ta - tb) * mult;
        }
      }
    });
  }, [sessions, search, selectedModel, selectedType, tableSort]);

  const toggleTableSort = (key: TableSortKey) => {
    setTableSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }
    );
  };

  const renderTypeTag = (session: SessionItem) => {
    if (session.sessionType === 'subagent') {
      return (
        <span className="type-tag subagent">
          <Bot size={11} />
          {session.agentName ? `子任务 · ${session.agentName}` : '子智能体'}
        </span>
      );
    }
    if (session.sessionType === 'side_query') {
      return (
        <span className="type-tag side_query">
          <Compass size={11} />
          侧栏提问
        </span>
      );
    }
    return (
      <span className="type-tag main">
        <MessageSquare size={11} />
        主会话
      </span>
    );
  };

  const renderSortIcon = (key: TableSortKey) => {
    if (tableSort.key !== key) return <ArrowUpDown size={12} style={{ opacity: 0.45 }} />;
    return tableSort.dir === 'desc' ? <ChevronDown size={13} /> : <ChevronUp size={13} />;
  };

  const effectiveLimit = overview?.contextConfig?.effectiveLimit || 256000;
  const rangeCaption = selectedDate
    ? `单日视图 · ${selectedDate}`
    : overview?.dateFrom && overview?.dateTo
      ? `${overview.dateFrom} 至 ${overview.dateTo}`
      : '加载中';

  return (
    <div className={`app-shell ${inSidecar ? 'in-sidecar' : ''} ${isCompact ? 'compact-mode' : ''}`}>
      {/* Compact Sticky Top Navigation */}
      <header className="app-header">
        <div className="header-inner">
          <div className="brand-group">
            <button
              type="button"
              className="brand-home-btn"
              onClick={backToOverview}
              title="返回 Antigravity Monitor 总览"
            >
              <span className="brand-mark" aria-hidden="true">
                <Activity size={17} strokeWidth={2.4} />
              </span>
              <span className="brand-text">
                <h1 className="brand-title">Antigravity Monitor</h1>
                <span className="brand-subtitle">
                  {activeSessionId ? '会话深度分析' : rangeCaption}
                </span>
              </span>
            </button>
          </div>

          <div className="header-actions">
            {!activeSessionId && (
              <div className="segmented" role="group" aria-label="统计时间范围">
                {(
                  [
                    { id: 'today', label: '今日' },
                    { id: '7d', label: '近 7 天' },
                    { id: '30d', label: '近 30 天' },
                    { id: 'all', label: '全部' }
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`seg-btn ${!selectedDate && timeRange === item.id ? 'active' : ''}`}
                    onClick={() => handleSelectTimeRange(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}

            <div
              className={`live-pill ${sseConnected ? '' : 'offline'}`}
              title={
                overview?.updatedAt
                  ? `最近同步：${new Date(overview.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`
                  : '等待本地数据库连接'
              }
            >
              <span className="live-dot" aria-hidden="true" />
              <span>{sseConnected ? '实时同步' : '已断开'}</span>
            </div>

            {!activeSessionId && hostWorkspaceUris.length > 0 && (
              <button
                type="button"
                className={`btn-ghost ${selectedWorkspace === hostWorkspaceUris.join('|') ? 'privacy-active' : ''}`}
                onClick={() => {
                  const hostKey = hostWorkspaceUris.join('|');
                  setSelectedWorkspace((prev) => (prev === hostKey ? null : hostKey));
                }}
                title="仅统计当前 Antigravity 打开的工作区项目"
              >
                <FolderKanban size={13} />
                <span>{selectedWorkspace === hostWorkspaceUris.join('|') ? '当前项目' : '按项目'}</span>
              </button>
            )}

            <button
              type="button"
              className={`btn-ghost btn-icon ${showGuardSettings ? 'privacy-active' : ''}`}
              onClick={() => setShowGuardSettings((v) => !v)}
              aria-pressed={showGuardSettings}
              title="预算与上下文守卫设置"
            >
              <Shield size={15} />
              <span className="sr-only">预算与上下文守卫设置</span>
            </button>

            <button
              type="button"
              className={`btn-ghost btn-icon ${privacyMode ? 'privacy-active' : ''}`}
              onClick={handleTogglePrivacy}
              aria-pressed={privacyMode}
              title={privacyMode ? '关闭隐私打码模式（恢复显示真实标题）' : '开启隐私打码模式（截图/录屏隐藏敏感标题）'}
            >
              {privacyMode ? <EyeOff size={15} /> : <Eye size={15} />}
              <span className="sr-only">{privacyMode ? '关闭隐私打码模式' : '开启隐私打码模式'}</span>
            </button>

            <button
              type="button"
              className="btn-ghost btn-icon"
              onClick={toggleColorScheme}
              title="切换浅色 / 深色主题"
            >
              <span className="theme-icon-light" aria-hidden="true">
                <Moon size={15} />
              </span>
              <span className="theme-icon-dark" aria-hidden="true">
                <Sun size={15} />
              </span>
              <span className="sr-only">切换浅色或深色主题</span>
            </button>

            <button
              type="button"
              className="btn-ghost"
              onClick={handleManualRefresh}
              disabled={refreshing}
            >
              <RefreshCw size={13} className={refreshing ? 'spin' : ''} />
              <span>刷新</span>
            </button>
          </div>
        </div>
      </header>

      {/* Route Switch: Independent Session Detail Page vs Main Dashboard */}
      {activeSessionId ? (
        <SessionDetailPage
          sessionId={activeSessionId}
          detail={sessionDetail}
          loading={detailLoading}
          privacyMode={privacyMode}
          onBack={backToOverview}
          onOpenSession={openSession}
        />
      ) : (
        <main className="app-main">
          <GuardSettingsDrawer
            open={showGuardSettings}
            onClose={() => setShowGuardSettings(false)}
          />

          {selectedWorkspace && (
            <div className="workspace-active-banner">
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <FolderKanban size={13} />
                <span>
                  当前按项目筛选：
                  <strong>
                    {privacyMode
                      ? '隐私项目'
                      : overview?.workspaceBreakdown?.find(
                          (w) => w.key === selectedWorkspace || w.uri === selectedWorkspace
                        )?.label || selectedWorkspace.split('/').pop() || selectedWorkspace}
                  </strong>
                </span>
              </div>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setSelectedWorkspace(null)}
              >
                <X size={12} />
                <span>查看全部项目</span>
              </button>
            </div>
          )}

          {isCompact && (
            <nav className="compact-nav-tabs" role="tablist" aria-label="侧栏视图切换">
              {(
                [
                  { id: 'live', label: '实时监控' },
                  { id: 'stats', label: '热力与模型' },
                  { id: 'sessions', label: `会话 (${filteredSessions.length})` }
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={compactTab === tab.id}
                  className={`compact-tab-btn ${compactTab === tab.id ? 'active' : ''}`}
                  onClick={() => setCompactTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </nav>
          )}

          {/* In compact sidecar mode, prioritize Live Context Monitor at the very top */}
          {isCompact && compactTab === 'live' && (
            <ContextMonitorCard
              activeSessions={overview?.activeSessions || []}
              contextConfig={overview?.contextConfig}
              privacyMode={privacyMode}
              hostConversationId={hostConversationId}
              followHost={followHost}
              onSelectSession={(id) => setFollowHost(Boolean(hostConversationId && id === hostConversationId))}
              onFollowHost={() => setFollowHost(true)}
              onOpenSession={openSession}
            />
          )}

          {/* 4 Balanced KPI Cards */}
          {(!isCompact || compactTab === 'live') && (
          <section className="kpi-grid" aria-label="核心运行指标">
            {/* KPI 1: Total Tokens & Cache Hit */}
            <article className="kpi-card">
              <div className="kpi-top">
                <span className="kpi-label">周期 Token 流转与缓存效率</span>
                <span className="kpi-icon" aria-hidden="true">
                  <Layers size={15} />
                </span>
              </div>
              <div className="kpi-value-row">
                <span
                  className="kpi-value"
                  title={overview ? `${overview.totalTokens.toLocaleString()} tokens` : undefined}
                >
                  {overview ? formatCompactTokens(overview.totalTokens) : '-'}
                </span>
                <span className="kpi-unit">tokens</span>
              </div>
              <div>
                <div className="kpi-sub">
                  <span>缓存命中 {cacheHitPct.toFixed(1)}%</span>
                  <span>·</span>
                  <span>缓存读取 {overview ? formatCompactTokens(overview.totalCacheReadTokens) : '-'}</span>
                </div>
                <div className="kpi-bar-track" aria-hidden="true">
                  <div className="kpi-bar-fill" style={{ width: `${Math.min(100, cacheHitPct)}%` }} />
                </div>
              </div>
            </article>

            {/* KPI 2: Estimated Cost & Cache Savings */}
            <article className="kpi-card">
              <div className="kpi-top">
                <span className="kpi-label">估算费用与缓存节省</span>
                {overview && overview.cacheSavingsPct > 0 ? (
                  <span className="savings-pill">省 {overview.cacheSavingsPct}%</span>
                ) : (
                  <span className="kpi-icon" aria-hidden="true">
                    <Coins size={15} />
                  </span>
                )}
              </div>
              <div className="kpi-value-row">
                <span className="kpi-value accent-cost">
                  {overview ? formatUsd(overview.totalEstimatedCostUsd) : '-'}
                </span>
                <span className="kpi-unit">USD</span>
              </div>
              <div className="kpi-sub">
                <span>缓存已省 {overview ? formatUsd(overview.totalCacheSavingsUsd) : '-'}</span>
                <span>·</span>
                <span>{overview?.totalCalls.toLocaleString() ?? '-'} 次推理</span>
              </div>
            </article>

            {/* KPI 3: Streaming Speed & TTFT */}
            <article className="kpi-card">
              <div className="kpi-top">
                <span className="kpi-label">加权流式输出速率</span>
                <span className="kpi-icon" aria-hidden="true">
                  <Activity size={15} />
                </span>
              </div>
              <div className="kpi-value-row">
                <span className="kpi-value accent-speed">
                  {overview?.globalSpeed?.streamTps != null ? overview.globalSpeed.streamTps : '-'}
                </span>
                <span className="kpi-unit">tok/s</span>
              </div>
              <div className="kpi-sub">
                <span>端到端 {overview?.globalSpeed?.e2eTps ?? '-'} tok/s</span>
                <span>·</span>
                <span>TTFT {overview?.globalSpeed?.avgTtftSec ?? '-'}s</span>
                <span>·</span>
                <span>思考 {overview?.globalSpeed?.thinkingSharePct ?? 0}%</span>
              </div>
            </article>

            {/* KPI 4: Sessions & Compactions */}
            <article className="kpi-card">
              <div className="kpi-top">
                <span className="kpi-label">周期会话与压缩统计</span>
                <span className="kpi-icon" aria-hidden="true">
                  <Database size={15} />
                </span>
              </div>
              <div className="kpi-value-row">
                <span className="kpi-value">
                  {overview?.totalSessions.toLocaleString() ?? '-'}
                </span>
                <span className="kpi-unit">
                  会话 · {overview?.totalCompactions ?? 0} 次压缩
                </span>
              </div>
              <div className="kpi-inline-links">
                <button
                  type="button"
                  className="kpi-link-btn"
                  onClick={() => setSelectedType(selectedType === 'main' ? 'ALL' : 'main')}
                >
                  主会话 {overview?.typeCounts?.main ?? 0}
                </button>
                <span className="panel-meta">·</span>
                <button
                  type="button"
                  className="kpi-link-btn"
                  onClick={() => setSelectedType(selectedType === 'subagent' ? 'ALL' : 'subagent')}
                >
                  子任务 {overview?.typeCounts?.subagent ?? 0}
                </button>
                <span className="panel-meta">·</span>
                <button
                  type="button"
                  className="kpi-link-btn"
                  onClick={() => setSelectedType(selectedType === 'side_query' ? 'ALL' : 'side_query')}
                >
                  侧栏 {overview?.typeCounts?.side_query ?? 0}
                </button>
              </div>
            </article>
          </section>
          )}

          {/* Dual Telemetry Deck: Live Context Monitor (5/12) + Token Heatmap (7/12) */}
          {!isCompact && (
            <section className="telemetry-deck" aria-label="实时上下文监控与消耗热力图">
              <ContextMonitorCard
                activeSessions={overview?.activeSessions || []}
                contextConfig={overview?.contextConfig}
                privacyMode={privacyMode}
                hostConversationId={hostConversationId}
                followHost={followHost}
                onSelectSession={(id) => setFollowHost(Boolean(hostConversationId && id === hostConversationId))}
                onFollowHost={() => setFollowHost(true)}
                onOpenSession={openSession}
              />
              <TokenHeatmap
                data={heatmap}
                selectedDate={selectedDate}
                onSelectDate={(d) => setSelectedDate(d)}
              />
            </section>
          )}

          {isCompact && compactTab === 'stats' && (
            <TokenHeatmap
              data={heatmap}
              selectedDate={selectedDate}
              onSelectDate={(d) => {
                setSelectedDate(d);
                if (d) setCompactTab('sessions');
              }}
            />
          )}

          {/* Model Endpoint Leaderboard & Share Panel */}
          {(!isCompact || compactTab === 'stats') && (
          <section className="panel-card" aria-label="模型端点分布与性能对比">
            <div className="panel-header">
              <div className="panel-title-wrap">
                <h2 className="panel-title">模型端点分布与性能对比</h2>
                <span className="panel-meta">
                  当前周期检测到 {sortedModels.length} 个物理端点 · 点击卡片筛选下方会话
                </span>
              </div>

              <div className="panel-controls">
                {selectedModel !== 'ALL' && (
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => setSelectedModel('ALL')}
                  >
                    <X size={13} />
                    <span>显示全部模型</span>
                  </button>
                )}

                <div className="segmented" role="group" aria-label="模型排序方式">
                  <button
                    type="button"
                    className={`seg-btn ${modelSortBy === 'calls' ? 'active' : ''}`}
                    onClick={() => setModelSortBy('calls')}
                  >
                    按调用量
                  </button>
                  <button
                    type="button"
                    className={`seg-btn ${modelSortBy === 'recent' ? 'active' : ''}`}
                    onClick={() => setModelSortBy('recent')}
                  >
                    按最近活跃
                  </button>
                  <button
                    type="button"
                    className={`seg-btn ${modelSortBy === 'speed' ? 'active' : ''}`}
                    onClick={() => setModelSortBy('speed')}
                  >
                    按吐字速率
                  </button>
                  <button
                    type="button"
                    className={`seg-btn ${modelSortBy === 'ttft' ? 'active' : ''}`}
                    onClick={() => setModelSortBy('ttft')}
                  >
                    按低延迟
                  </button>
                </div>
              </div>
            </div>

            {ratioSegments.length > 0 && (
              <div className="ratio-bar" role="group" aria-label="模型调用占比分布条">
                {ratioSegments.map((seg) => {
                  const isDimmed =
                    (selectedModel !== 'ALL' && selectedModel !== seg.model) ||
                    (hoveredModel !== null && hoveredModel !== seg.model);
                  return (
                    <button
                      key={seg.model}
                      type="button"
                      className={`ratio-seg ${isDimmed ? 'dimmed' : ''}`}
                      style={{
                        width: `${Math.max(seg.pct, 0.4)}%`,
                        backgroundColor: seg.color
                      }}
                      title={`${seg.model}: ${seg.calls.toLocaleString()} 次 (${seg.pct.toFixed(1)}%)`}
                      aria-label={`筛选模型 ${seg.model}，占比 ${seg.pct.toFixed(1)}%`}
                      onClick={() =>
                        setSelectedModel(selectedModel === seg.model ? 'ALL' : seg.model)
                      }
                      onMouseEnter={() => setHoveredModel(seg.model)}
                      onMouseLeave={() => setHoveredModel(null)}
                    />
                  );
                })}
              </div>
            )}

            {visibleModels.length === 0 ? (
              <div className="empty-cell" style={{ padding: '24px 0' }}>
                所选时间范围内暂无模型推理记录
              </div>
            ) : (
              <div className="model-grid">
                {visibleModels.map((item) => {
                  const active = selectedModel === item.model;
                  const parts = splitModelTier(item.model);
                  return (
                    <button
                      key={item.model}
                      type="button"
                      className={`model-tile ${active ? 'active' : ''}`}
                      aria-pressed={active}
                      title={`${item.model} · ${item.calls.toLocaleString()} 次调用 (${item.sessions} 会话) · 估算费用 ${formatUsd(item.cost)}`}
                      onClick={() => setSelectedModel(active ? 'ALL' : item.model)}
                      onMouseEnter={() => setHoveredModel(item.model)}
                      onMouseLeave={() => setHoveredModel(null)}
                    >
                      <div className="model-tile-head">
                        <div className="model-name-wrap">
                          <span
                            className="model-dot"
                            style={{ backgroundColor: item.color }}
                            aria-hidden="true"
                          />
                          <span className="model-name-text">{parts.base}</span>
                          {parts.tier && (
                            <span className={`tier-pill ${parts.tone}`}>{parts.tier}</span>
                          )}
                        </div>
                        <span className="model-share-pct">
                          {item.pct >= 0.1 ? `${item.pct.toFixed(1)}%` : '<0.1%'}
                        </span>
                      </div>

                      <div className="model-mini-track" aria-hidden="true">
                        <div
                          className="model-mini-fill"
                          style={{
                            width: `${Math.min(100, Math.max(item.pct, 2))}%`,
                            backgroundColor: item.color
                          }}
                        />
                      </div>

                      <div className="model-tile-stats">
                        <span>
                          <strong>{item.calls.toLocaleString()}</strong> 次 · {item.sessions} 会话
                        </span>
                        <span>
                          <span className="model-speed-val">
                            {item.streamTps != null ? `${item.streamTps} t/s` : '-'}
                          </span>
                          {item.avgTtftSec != null ? ` · ${item.avgTtftSec}s` : ''}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            {sortedModels.length > DEFAULT_VISIBLE_MODELS && (
              <div className="expand-models-row">
                <button
                  type="button"
                  className="expand-btn"
                  onClick={() => setShowAllModels((v) => !v)}
                >
                  {showAllModels ? (
                    <>
                      <ChevronUp size={14} />
                      <span>收起低频与实验端点（仅看 Top {DEFAULT_VISIBLE_MODELS}）</span>
                    </>
                  ) : (
                    <>
                      <ChevronDown size={14} />
                      <span>展开其余 {hiddenModelCount} 个低频 / 历史端点</span>
                    </>
                  )}
                </button>
                <span className="panel-meta">
                  已按
                  {modelSortBy === 'calls'
                    ? '调用量'
                    : modelSortBy === 'recent'
                      ? '最近活跃'
                      : modelSortBy === 'speed'
                        ? '流式速率'
                        : '平均 TTFT'}
                  排序
                </span>
              </div>
            )}
          </section>
          )}

          {/* Workspace Cost Breakdown Panel */}
          {(!isCompact || compactTab === 'stats') &&
            overview?.workspaceBreakdown &&
            overview.workspaceBreakdown.length > 0 && (
              <section className="panel-card" aria-label="按项目成本分摊">
                <div className="panel-header" style={{ marginBottom: 12 }}>
                  <div className="panel-title-wrap">
                    <h2
                      className="panel-title"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                    >
                      <FolderKanban size={15} />
                      按项目（Workspace）成本分摊
                    </h2>
                    <span className="panel-meta">
                      共 {overview.workspaceBreakdown.length} 个项目 · 点击项目卡片可联动筛选全部指标与会话
                    </span>
                  </div>
                  {selectedWorkspace && (
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => setSelectedWorkspace(null)}
                    >
                      <X size={13} />
                      <span>显示全部项目</span>
                    </button>
                  )}
                </div>

                <div className="workspace-grid">
                  {overview.workspaceBreakdown.slice(0, 8).map((ws, idx) => {
                    const wsKey = ws.key || ws.uri;
                    const active = Boolean(wsKey && selectedWorkspace === wsKey);
                    const totalAllCost = overview.workspaceBreakdown!.reduce(
                      (acc, w) => acc + (w.estimatedCostUsd || 0),
                      0
                    );
                    const sharePct =
                      totalAllCost > 0 ? Math.min(100, (ws.estimatedCostUsd / totalAllCost) * 100) : 0;
                    const displayLabel = privacyMode
                      ? ws.key
                        ? `项目 #${String(idx + 1).padStart(2, '0')}`
                        : '未关联项目'
                      : ws.label;

                    return (
                      <button
                        key={ws.key || `unassigned-${idx}`}
                        type="button"
                        className={`workspace-tile ${active ? 'active' : ''}`}
                        disabled={!wsKey}
                        onClick={() => {
                          if (!wsKey) return;
                          setSelectedWorkspace((prev) => (prev === wsKey ? null : wsKey));
                        }}
                        title={privacyMode ? displayLabel : ws.key || ws.label}
                      >
                        <div className="workspace-tile-top">
                          <span className="workspace-tile-name">{displayLabel}</span>
                          <span className="mono" style={{ color: 'var(--cost)', fontWeight: 700 }}>
                            {formatUsd(ws.estimatedCostUsd)}
                          </span>
                        </div>
                        <div className="model-mini-track" aria-hidden="true">
                          <div
                            className="model-mini-fill"
                            style={{
                              width: `${Math.max(sharePct, 2)}%`,
                              backgroundColor: 'var(--accent)'
                            }}
                          />
                        </div>
                        <div className="workspace-tile-stats">
                          <span>
                            {ws.sessions} 会话 · {formatCompactTokens(ws.totalTokens)}
                          </span>
                          <span>缓存 {ws.cacheHitPct.toFixed(0)}%</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

          {/* Sessions Toolbar & Responsive Sortable Table */}
          {(!isCompact || compactTab === 'sessions') && (
          <section className="sessions-section" aria-label="会话路由明细">
            <div className="toolbar-row">
              <div className="toolbar-left">
                <div className="search-box">
                  <span className="search-icon" aria-hidden="true">
                    <Search size={15} />
                  </span>
                  <input
                    id="session-search"
                    name="q"
                    type="search"
                    className="search-input"
                    aria-label="搜索会话标题、模型名称或 Conversation ID"
                    placeholder="搜索会话标题、模型端点或 ID..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  {search && (
                    <button
                      type="button"
                      className="search-clear"
                      aria-label="清空搜索"
                      onClick={() => setSearch('')}
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>

                {selectedDate && (
                  <div className="active-filter-chip">
                    <CalendarDays size={13} />
                    <span className="mono">{selectedDate}</span>
                    <button
                      type="button"
                      className="chip-close"
                      aria-label={`清除日期 ${selectedDate} 筛选`}
                      onClick={() => setSelectedDate(null)}
                    >
                      <X size={12} />
                    </button>
                  </div>
                )}

                {selectedModel !== 'ALL' && (
                  <div className="active-filter-chip">
                    <span
                      className="model-dot"
                      style={{ backgroundColor: getModelColor(selectedModel) }}
                      aria-hidden="true"
                    />
                    <span className="mono">{selectedModel}</span>
                    <button
                      type="button"
                      className="chip-close"
                      aria-label={`清除模型 ${selectedModel} 筛选`}
                      onClick={() => setSelectedModel('ALL')}
                    >
                      <X size={12} />
                    </button>
                  </div>
                )}
              </div>

              <div className="toolbar-right">
                <div className="segmented" role="group" aria-label="会话类型筛选">
                  {[
                    { id: 'ALL', label: `全部 ${overview?.totalSessions ?? 0}` },
                    { id: 'main', label: `主会话 ${overview?.typeCounts?.main ?? 0}` },
                    { id: 'subagent', label: `子任务 ${overview?.typeCounts?.subagent ?? 0}` },
                    { id: 'side_query', label: `侧栏 ${overview?.typeCounts?.side_query ?? 0}` }
                  ].map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className={`seg-btn ${selectedType === t.id ? 'active' : ''}`}
                      onClick={() => setSelectedType(t.id)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                <span className="match-count">
                  共 <strong>{filteredSessions.length}</strong> 条
                </span>
              </div>
            </div>

            {isCompact ? (
              <div className="compact-sessions-list" role="list" aria-label="会话紧凑列表">
                {loading ? (
                  <div className="empty-cell">正在读取本地会话数据库...</div>
                ) : filteredSessions.length === 0 ? (
                  <div className="empty-cell">当前时间范围或筛选条件下无匹配会话</div>
                ) : (
                  filteredSessions.slice(0, 120).map((session) => {
                    const totalSessTokens =
                      session.totalInputTokens +
                      session.totalCacheReadTokens +
                      session.totalOutputTokens;
                    const ctxPct =
                      effectiveLimit > 0
                        ? Math.min(100, ((session.currentContextTokens || 0) / effectiveLimit) * 100)
                        : 0;
                    const ctxHealth = getContextHealthClass(ctxPct);
                    const displayTitle = privacyMode
                      ? maskSessionTitle(session.conversation_id, session.sessionType, session.agentName)
                      : session.title;
                    const isCurrentHost = hostConversationId === session.conversation_id;

                    return (
                      <div
                        key={session.conversation_id}
                        role="listitem"
                        tabIndex={0}
                        className={`compact-session-card ${isCurrentHost ? 'is-host' : ''}`}
                        onClick={() => openSession(session.conversation_id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            openSession(session.conversation_id);
                          }
                        }}
                      >
                        <div className="compact-session-top">
                          <div className="session-meta-row">
                            {renderTypeTag(session)}
                            {isCurrentHost && <span className="host-follow-pill">当前</span>}
                            {session.childCount > 0 && (
                              <span className="child-count-tag">+{session.childCount}</span>
                            )}
                          </div>
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            {canJumpConv && (
                              <button
                                type="button"
                                className="jump-conv-btn"
                                title="在 Antigravity 左侧主窗口打开此对话"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  jumpToHostConversation(session.conversation_id);
                                }}
                              >
                                <ExternalLink size={11} />
                              </button>
                            )}
                            <span className="cell-secondary" style={{ marginTop: 0 }}>
                              {formatRelativeTime(session.last_modified_time)}
                            </span>
                          </div>
                        </div>
                        <div className={`compact-session-title ${privacyMode ? 'masked' : ''}`}>
                          {displayTitle}
                        </div>
                        <div className="compact-session-metrics">
                          <span className="mono">{formatCompactTokens(totalSessTokens)}</span>
                          <span className="mono" style={{ color: 'var(--cost)' }}>
                            {formatUsd(session.estimatedCostUsd)}
                          </span>
                          <span className="mono">
                            水位 {formatCompactTokens(session.currentContextTokens)} ({Math.round(ctxPct)}%)
                          </span>
                          {session.compactionCount > 0 && (
                            <span className="cp-mini-badge">{session.compactionCount} 压</span>
                          )}
                        </div>
                        <div className="table-ctx-bar" aria-hidden="true">
                          <div
                            className={`table-ctx-fill ${ctxHealth}`}
                            style={{ width: `${Math.max(ctxPct, session.currentContextTokens > 0 ? 2 : 0)}%` }}
                          />
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            ) : (
            <div
              tabIndex={0}
              role="region"
              aria-label="会话路由、上下文水位与输出速率明细表"
              className="table-wrapper"
            >
              <table className="sessions-table">
                <thead>
                  <tr>
                    <th>会话主题</th>
                    <th>命中路由端点</th>
                    <th aria-sort={tableSort.key === 'context' ? (tableSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button
                        type="button"
                        className={`sort-btn ${tableSort.key === 'context' ? 'active' : ''}`}
                        onClick={() => toggleTableSort('context')}
                      >
                        上下文水位 / 压缩 {renderSortIcon('context')}
                      </button>
                    </th>
                    <th aria-sort={tableSort.key === 'speed' ? (tableSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button
                        type="button"
                        className={`sort-btn ${tableSort.key === 'speed' ? 'active' : ''}`}
                        onClick={() => toggleTableSort('speed')}
                      >
                        速率 / TTFT {renderSortIcon('speed')}
                      </button>
                    </th>
                    <th aria-sort={tableSort.key === 'tokens' ? (tableSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button
                        type="button"
                        className={`sort-btn ${tableSort.key === 'tokens' ? 'active' : ''}`}
                        onClick={() => toggleTableSort('tokens')}
                      >
                        Tokens / 步数 {renderSortIcon('tokens')}
                      </button>
                    </th>
                    <th aria-sort={tableSort.key === 'cost' ? (tableSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button
                        type="button"
                        className={`sort-btn ${tableSort.key === 'cost' ? 'active' : ''}`}
                        onClick={() => toggleTableSort('cost')}
                      >
                        估算费用 {renderSortIcon('cost')}
                      </button>
                    </th>
                    <th
                      style={{ textAlign: 'right' }}
                      aria-sort={tableSort.key === 'time' ? (tableSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    >
                      <button
                        type="button"
                        className={`sort-btn ${tableSort.key === 'time' ? 'active' : ''}`}
                        onClick={() => toggleTableSort('time')}
                      >
                        最后活动 {renderSortIcon('time')}
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={7} className="empty-cell">
                        正在读取本地会话数据库...
                      </td>
                    </tr>
                  ) : filteredSessions.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="empty-cell">
                        当前时间范围或筛选条件下无匹配会话
                      </td>
                    </tr>
                  ) : (
                    filteredSessions.map((session) => {
                      const totalSessTokens =
                        session.totalInputTokens +
                        session.totalCacheReadTokens +
                        session.totalOutputTokens;
                      const ctxPct =
                        effectiveLimit > 0
                          ? Math.min(100, ((session.currentContextTokens || 0) / effectiveLimit) * 100)
                          : 0;
                      const ctxHealth = getContextHealthClass(ctxPct);
                      const sortedSessModels = [...session.modelsUsed].sort(
                        (a, b) => (session.modelCounts[b] || 0) - (session.modelCounts[a] || 0)
                      );
                      const shownModels = sortedSessModels.slice(0, 2);
                      const extraModelCount = sortedSessModels.length - shownModels.length;

                      const displayTitle = privacyMode
                        ? maskSessionTitle(session.conversation_id, session.sessionType, session.agentName)
                        : session.title;
                      const displayId = privacyMode
                        ? maskSessionId(session.conversation_id)
                        : session.conversation_id.slice(0, 8);

                      return (
                        <tr
                          key={session.conversation_id}
                          tabIndex={0}
                          onClick={() => openSession(session.conversation_id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              openSession(session.conversation_id);
                            }
                          }}
                        >
                          <th scope="row" className="session-cell">
                            <div className="session-meta-row">
                              {renderTypeTag(session)}
                              <span className="session-id">{displayId}</span>
                              {session.childCount > 0 && (
                                <span className="child-count-tag">+{session.childCount} 子任务</span>
                              )}
                            </div>
                            <div
                              className={`session-title ${privacyMode ? 'masked' : ''}`}
                              title={displayTitle}
                            >
                              {displayTitle}
                            </div>
                          </th>

                          <td>
                            <div className="models-cell">
                              {shownModels.map((m) => (
                                <ModelBadge
                                  key={m}
                                  model={m}
                                  count={session.modelCounts[m]}
                                  title={`${m}: ${session.modelCounts[m] || 0} 次`}
                                />
                              ))}
                              {extraModelCount > 0 && (
                                <span
                                  className="model-badge"
                                  title={sortedSessModels
                                    .slice(2)
                                    .map((m) => `${m} (${session.modelCounts[m] || 0})`)
                                    .join(', ')}
                                >
                                  +{extraModelCount}
                                </span>
                              )}
                            </div>
                          </td>

                          <td>
                            <div className="table-ctx-cell">
                              <div className="table-ctx-top">
                                <span className="cell-primary" style={{ fontSize: 12.5 }}>
                                  {formatCompactTokens(session.currentContextTokens)}
                                </span>
                                {session.compactionCount > 0 && (
                                  <span className="cp-mini-badge">{session.compactionCount} 压</span>
                                )}
                              </div>
                              <div className="table-ctx-bar" aria-hidden="true">
                                <div
                                  className={`table-ctx-fill ${ctxHealth}`}
                                  style={{ width: `${Math.max(ctxPct, session.currentContextTokens > 0 ? 2 : 0)}%` }}
                                />
                              </div>
                            </div>
                          </td>

                          <td>
                            {session.streamTps != null || session.e2eTps != null ? (
                              <div>
                                <div className="cell-primary speed">
                                  {session.streamTps != null ? `${session.streamTps} tok/s` : '-'}
                                </div>
                                <div className="cell-secondary">
                                  E2E {session.e2eTps != null ? `${session.e2eTps}` : '-'}
                                  {session.avgTtftSec != null ? ` · TTFT ${session.avgTtftSec}s` : ''}
                                </div>
                              </div>
                            ) : (
                              <span className="cell-secondary">-</span>
                            )}
                          </td>

                          <td>
                            <div
                              className="cell-primary"
                              title={`输入 ${session.totalInputTokens.toLocaleString()} · 缓存 ${session.totalCacheReadTokens.toLocaleString()} · 输出 ${session.totalOutputTokens.toLocaleString()}`}
                            >
                              {formatCompactTokens(totalSessTokens)}
                            </div>
                            <div className="cell-secondary">
                              {session.calls} 步
                              {session.thinkingSharePct > 0 ? ` · 思考 ${session.thinkingSharePct}%` : ''}
                            </div>
                          </td>

                          <td>
                            <div className="cell-primary cost">
                              {formatUsd(session.estimatedCostUsd)}
                            </div>
                          </td>

                          <td style={{ textAlign: 'right' }}>
                            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                              {canJumpConv && (
                                <button
                                  type="button"
                                  className="jump-conv-btn"
                                  title="在 Antigravity 主窗口直接打开此对话"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    jumpToHostConversation(session.conversation_id);
                                  }}
                                >
                                  <ExternalLink size={12} />
                                </button>
                              )}
                              <span
                                className="cell-secondary"
                                style={{ marginTop: 0 }}
                                title={
                                  session.last_modified_time
                                    ? new Date(session.last_modified_time).toLocaleString('zh-CN', { hour12: false })
                                    : undefined
                                }
                              >
                                {formatRelativeTime(session.last_modified_time)}
                              </span>
                              <span className="row-chevron" aria-hidden="true">
                                <ChevronRight size={15} />
                              </span>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            )}
          </section>
          )}
        </main>
      )}
    </div>
  );
}
