import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Activity,
  RefreshCw,
  Cpu,
  Search,
  Database,
  Sparkles,
  X,
  ChevronRight,
  Bot,
  MessageSquare,
  Compass,
  ShieldCheck,
  Zap
} from 'lucide-react';

interface SpeedMetrics {
  avgTtftSec: number | null;
  streamTps: number | null;
  e2eTps: number | null;
  thinkingSharePct: number;
}

interface GlobalOverview {
  totalSessions: number;
  totalCalls: number;
  totalTokens: number;
  totalCacheReadTokens: number;
  globalSpeed: SpeedMetrics;
  typeCounts: {
    main: number;
    subagent: number;
    side_query: number;
  };
  modelTotals: Record<string, number>;
  modelSessionCount: Record<string, number>;
  modelSpeed: Record<string, SpeedMetrics>;
  updatedAt: string;
}

interface SessionItem {
  conversation_id: string;
  title: string;
  sessionType: 'main' | 'subagent' | 'side_query';
  agentName: string;
  parentId: string;
  preview: string;
  step_count: number;
  last_modified_time: string;
  calls: number;
  modelsUsed: string[];
  modelCounts: Record<string, number>;
  totalInputTokens: number;
  totalCacheReadTokens: number;
  totalOutputTokens: number;
  totalThinkingTokens: number;
  totalResponseTokens: number;
  avgTtftSec: number | null;
  streamTps: number | null;
  e2eTps: number | null;
  thinkingSharePct: number;
}

interface GenerationTurn {
  idx: number;
  model: string;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  responseTokens: number;
  ttftSec: number | null;
  streamSec: number | null;
  totalSec: number | null;
  streamTps: number | null;
  e2eTps: number | null;
  metadata: Record<string, string>;
}

interface SessionDetail extends SessionItem {
  generations: GenerationTurn[];
}

export default function App() {
  const [overview, setOverview] = useState<GlobalOverview | null>(null);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sseConnected, setSseConnected] = useState(false);

  // Filters
  const [search, setSearch] = useState('');
  const [selectedModel, setSelectedModel] = useState<string>('ALL');
  const [selectedType, setSelectedType] = useState<string>('ALL');

  // Selected session for detail modal
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const activeSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const fetchSessionDetail = async (id: string, silent = false) => {
    if (!silent) setDetailLoading(true);
    try {
      const res = await fetch(`/api/sessions/${id}`);
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
  };

  // Fetch overview & sessions
  const fetchData = async () => {
    try {
      setRefreshing(true);
      const [ovRes, sessRes] = await Promise.all([
        fetch('/api/overview'),
        fetch('/api/sessions?pageSize=300')
      ]);

      if (ovRes.ok) {
        const ovData = await ovRes.json();
        setOverview(ovData);
      }
      if (sessRes.ok) {
        const sessData = await sessRes.json();
        setSessions(sessData.sessions || []);
      }
    } catch (err) {
      console.error('Fetch error:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  // Initial load + SSE connection
  useEffect(() => {
    fetchData();

    const es = new EventSource('/api/events');
    es.onopen = () => setSseConnected(true);
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'update') {
          fetchData();
          if (activeSessionIdRef.current) {
            fetchSessionDetail(activeSessionIdRef.current, true);
          }
        }
      } catch (err) {}
    };
    es.onerror = () => setSseConnected(false);

    return () => es.close();
  }, []);

  // Fetch session detail & support Escape key dismiss
  useEffect(() => {
    if (!activeSessionId) {
      setSessionDetail(null);
      return;
    }
    fetchSessionDetail(activeSessionId, false);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setActiveSessionId(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeSessionId]);

  // Model badge styling
  const getModelBadgeClass = (model: string) => {
    const m = model.toLowerCase();
    if (m.includes('claude')) return 'badge-claude';
    if (m.includes('argon')) return 'badge-argon';
    if (m.includes('flash-n')) return 'badge-flash-n';
    if (m.includes('flash-exp-a')) return 'badge-flash-exp-a';
    if (m.includes('flash-exp-b')) return 'badge-flash-exp-b';
    if (m.includes('flash')) return 'badge-flash';
    return 'badge-unknown';
  };

  // Session type badge styling
  const renderTypeBadge = (session: SessionItem) => {
    if (session.sessionType === 'subagent') {
      return (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '2px 8px',
            borderRadius: 6,
            fontSize: 11,
            fontWeight: 700,
            background: '#faf5ff',
            color: '#7e22ce',
            border: '1px solid #e9d5ff'
          }}
        >
          <Bot size={12} />
          {session.agentName ? `子任务 · ${session.agentName}` : '子智能体'}
        </span>
      );
    }
    if (session.sessionType === 'side_query') {
      return (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '2px 8px',
            borderRadius: 6,
            fontSize: 11,
            fontWeight: 700,
            background: '#fff7ed',
            color: '#c2410c',
            border: '1px solid #ffedd5'
          }}
        >
          <Compass size={12} />
          侧栏/临时问答
        </span>
      );
    }
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '2px 8px',
          borderRadius: 6,
          fontSize: 11,
          fontWeight: 700,
          background: '#eff6ff',
          color: '#1d4ed8',
          border: '1px solid #dbeafe'
        }}
      >
        <MessageSquare size={12} />
        主会话
      </span>
    );
  };

  // Filtered sessions
  const filteredSessions = useMemo(() => {
    return sessions.filter((s) => {
      const matchSearch =
        !search ||
        s.title.toLowerCase().includes(search.toLowerCase()) ||
        s.conversation_id.toLowerCase().includes(search.toLowerCase());

      const matchModel =
        selectedModel === 'ALL' ||
        (s.modelsUsed && s.modelsUsed.includes(selectedModel));

      const matchType =
        selectedType === 'ALL' || s.sessionType === selectedType;

      return matchSearch && matchModel && matchType;
    });
  }, [sessions, search, selectedModel, selectedType]);

  // Metrics calculation
  const metrics = useMemo(() => {
    if (!overview) return null;
    const totals = overview.modelTotals || {};
    let dominant = 'none';
    let maxCalls = 0;
    let expCalls = 0;

    for (const [m, c] of Object.entries(totals)) {
      if (c > maxCalls) {
        maxCalls = c;
        dominant = m;
      }
      if (m.includes('-n') || m.includes('-exp-')) {
        expCalls += c;
      }
    }

    return {
      dominant,
      dominantPct: overview.totalCalls > 0 ? ((maxCalls / overview.totalCalls) * 100).toFixed(1) : '0',
      expCalls,
      expPct: overview.totalCalls > 0 ? ((expCalls / overview.totalCalls) * 100).toFixed(1) : '0'
    };
  }, [overview]);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Astryx TopNav / Header */}
      <header
        style={{
          borderBottom: '1px solid var(--app-border)',
          background: 'var(--app-card-bg)',
          padding: '12px 28px',
          position: 'sticky',
          top: 0,
          zIndex: 50
        }}
      >
        <div style={{ maxWidth: 1400, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: 10,
                background: 'linear-gradient(135deg, #2563eb, #7c3aed)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                boxShadow: '0 4px 12px rgba(37,99,235,0.25)'
              }}
            >
              <Cpu size={22} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, letterSpacing: '-0.02em' }}>
                  Antigravity 会话模型路由监测后台
                </h1>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    padding: '2px 8px',
                    borderRadius: 999,
                    background: '#f1f5f9',
                    color: '#475569',
                    border: '1px solid #e2e8f0'
                  }}
                >
                  Astryx Design
                </span>
              </div>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--app-text-muted)' }}>
                多级解析会话主题、子任务指令与底层真实物理端点
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                borderRadius: 999,
                background: sseConnected ? '#ecfdf5' : '#fef2f2',
                border: `1px solid ${sseConnected ? '#a7f3d0' : '#fecaca'}`,
                fontSize: 12,
                color: sseConnected ? '#065f46' : '#991b1b',
                fontWeight: 500
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  backgroundColor: sseConnected ? '#10b981' : '#ef4444'
                }}
              />
              {sseConnected ? 'SSE 实时同步中' : '未连接'}
            </div>

            <button
              onClick={fetchData}
              disabled={refreshing}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 14px',
                borderRadius: 8,
                border: '1px solid var(--app-border)',
                background: 'var(--app-card-bg)',
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--app-text)'
              }}
            >
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
              刷新数据
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main style={{ flex: 1, padding: '24px 28px', maxWidth: 1400, width: '100%', margin: '0 auto', boxSizing: 'border-box' }}>
        {/* Metric Cards Grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 16,
            marginBottom: 24
          }}
        >
          {/* Card 1: Total Sessions & Breakdown */}
          <div
            style={{
              background: 'var(--app-card-bg)',
              borderRadius: 14,
              padding: '20px 22px',
              border: '1px solid var(--app-border)',
              boxShadow: '0 1px 3px rgba(0,0,0,0.02)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--app-text-muted)' }}>历史监测会话总数</span>
              <div style={{ padding: 6, borderRadius: 8, background: '#eff6ff', color: '#2563eb' }}>
                <Database size={18} />
              </div>
            </div>
            <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--app-text)' }}>
              {overview?.totalSessions.toLocaleString() ?? '-'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--app-text-muted)', marginTop: 4, display: 'flex', gap: 8 }}>
              <span>主会话: {overview?.typeCounts?.main ?? 0}</span>
              <span>·</span>
              <span>子智能体: {overview?.typeCounts?.subagent ?? 0}</span>
              <span>·</span>
              <span>侧栏: {overview?.typeCounts?.side_query ?? 0}</span>
            </div>
          </div>

          {/* Card 2: Total Inferences */}
          <div
            style={{
              background: 'var(--app-card-bg)',
              borderRadius: 14,
              padding: '20px 22px',
              border: '1px solid var(--app-border)',
              boxShadow: '0 1px 3px rgba(0,0,0,0.02)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--app-text-muted)' }}>后端物理推理调用总数</span>
              <div style={{ padding: 6, borderRadius: 8, background: '#f5f3ff', color: '#7c3aed' }}>
                <Zap size={18} />
              </div>
            </div>
            <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--app-text)' }}>
              {overview?.totalCalls.toLocaleString() ?? '-'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--app-text-muted)', marginTop: 4 }}>
              总流转 {((overview?.totalTokens ?? 0) / 1000000).toFixed(2)}M（缓存 {((overview?.totalCacheReadTokens ?? 0) / 1000000).toFixed(2)}M）
            </div>
          </div>

          {/* Card 3: Output Speed & TTFT */}
          <div
            style={{
              background: 'var(--app-card-bg)',
              borderRadius: 14,
              padding: '20px 22px',
              border: '1px solid var(--app-border)',
              boxShadow: '0 1px 3px rgba(0,0,0,0.02)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--app-text-muted)' }}>全局流式输出速率</span>
              <div style={{ padding: 6, borderRadius: 8, background: '#ecfeff', color: '#0891b2' }}>
                <Activity size={18} />
              </div>
            </div>
            <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.02em', color: '#0891b2' }}>
              {overview?.globalSpeed?.streamTps != null ? `${overview.globalSpeed.streamTps} tok/s` : '-'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--app-text-muted)', marginTop: 4 }}>
              端到端 {overview?.globalSpeed?.e2eTps ?? '-'} tok/s · TTFT {overview?.globalSpeed?.avgTtftSec ?? '-'}s
            </div>
          </div>

          {/* Card 4: Dominant Model */}
          <div
            style={{
              background: 'var(--app-card-bg)',
              borderRadius: 14,
              padding: '20px 22px',
              border: '1px solid var(--app-border)',
              boxShadow: '0 1px 3px rgba(0,0,0,0.02)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--app-text-muted)' }}>主力路由端点</span>
              <div style={{ padding: 6, borderRadius: 8, background: '#ecfdf5', color: '#059669' }}>
                <ShieldCheck size={18} />
              </div>
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--app-text)', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
              {metrics?.dominant ?? '-'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--app-text-muted)', marginTop: 4 }}>
              占总调用 {metrics?.dominantPct}% · 思考占比 {overview?.globalSpeed?.thinkingSharePct ?? 0}%
            </div>
          </div>

          {/* Card 5: Canary / Exp Hits */}
          <div
            style={{
              background: 'var(--app-card-bg)',
              borderRadius: 14,
              padding: '20px 22px',
              border: '1px solid var(--app-border)',
              boxShadow: '0 1px 3px rgba(0,0,0,0.02)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--app-text-muted)' }}>灰度 / 实验端点命中</span>
              <div style={{ padding: 6, borderRadius: 8, background: '#fffbeb', color: '#d97706' }}>
                <Sparkles size={18} />
              </div>
            </div>
            <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.02em', color: '#d97706' }}>
              {metrics?.expCalls.toLocaleString() ?? '-'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--app-text-muted)', marginTop: 4 }}>
              命中率 {metrics?.expPct}%（含 -n、-exp-a、-exp-b 分支）
            </div>
          </div>
        </div>

        {/* Model Breakdown Bar & Distribution */}
        <div
          style={{
            background: 'var(--app-card-bg)',
            borderRadius: 14,
            padding: '20px 24px',
            border: '1px solid var(--app-border)',
            marginBottom: 24
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>模型物理端点调用与速率分布</h2>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--app-text-muted)', marginTop: 2 }}>
                点击下方任意模型标签可筛选关联会话，右侧展示对应端点的加权流式吐字速度与平均首字等待时间
              </p>
            </div>
            <div style={{ fontSize: 12, color: 'var(--app-text-muted)' }}>
              共检测到 {overview ? Object.keys(overview.modelTotals).length : 0} 个物理端点
            </div>
          </div>

          {/* Horizontal Ratio Bar */}
          {overview && overview.totalCalls > 0 && (
            <div
              style={{
                height: 12,
                borderRadius: 999,
                overflow: 'hidden',
                display: 'flex',
                background: '#e2e8f0',
                marginBottom: 16
              }}
            >
              {Object.entries(overview.modelTotals).map(([model, count]) => {
                const pct = (count / overview.totalCalls) * 100;
                const mLow = model.toLowerCase();
                let bg = '#3b82f6';
                if (mLow.includes('claude')) bg = '#e11d48';
                else if (mLow.includes('argon')) bg = '#4f46e5';
                else if (mLow.includes('-n')) bg = '#10b981';
                else if (mLow.includes('-exp-a')) bg = '#8b5cf6';
                else if (mLow.includes('-exp-b')) bg = '#f59e0b';
                else if (model === 'unknown') bg = '#94a3b8';

                return (
                  <div
                    key={model}
                    style={{
                      width: `${pct}%`,
                      backgroundColor: bg,
                      transition: 'width 0.3s'
                    }}
                    title={`${model}: ${count} 次 (${pct.toFixed(2)}%)`}
                  />
                );
              })}
            </div>
          )}

          {/* Model Pill Buttons */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            <button
              onClick={() => setSelectedModel('ALL')}
              style={{
                padding: '6px 14px',
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
                border: selectedModel === 'ALL' ? '2px solid #2563eb' : '1px solid var(--app-border)',
                background: selectedModel === 'ALL' ? '#eff6ff' : 'var(--app-card-bg)',
                color: selectedModel === 'ALL' ? '#1d4ed8' : 'var(--app-text)'
              }}
            >
              全部模型 ({overview?.totalCalls.toLocaleString()})
            </button>
            {overview &&
              Object.entries(overview.modelTotals).map(([model, count]) => {
                const active = selectedModel === model;
                const sessionsWithModel = overview.modelSessionCount[model] || 0;
                const mSpeed = overview.modelSpeed?.[model];
                return (
                  <button
                    key={model}
                    onClick={() => setSelectedModel(model)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 14px',
                      borderRadius: 8,
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: 'pointer',
                      border: active ? '2px solid #2563eb' : '1px solid var(--app-border)',
                      background: active ? '#eff6ff' : 'var(--app-card-bg)',
                      color: 'var(--app-text)'
                    }}
                  >
                    <span className={getModelBadgeClass(model)} style={{ padding: '2px 8px', borderRadius: 6, fontSize: 11 }}>
                      {model}
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--app-text-muted)' }}>
                      {count.toLocaleString()} 次 ({sessionsWithModel} 会话)
                      {mSpeed?.streamTps != null ? ` · ${mSpeed.streamTps} tok/s` : ''}
                      {mSpeed?.avgTtftSec != null ? ` · TTFT ${mSpeed.avgTtftSec}s` : ''}
                    </span>
                  </button>
                );
              })}
          </div>
        </div>

        {/* Toolbar & Filters */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            marginBottom: 16,
            flexWrap: 'wrap'
          }}
        >
          {/* Search Input */}
          <div style={{ position: 'relative', minWidth: 320, flex: 1, maxWidth: 460 }}>
            <Search size={16} style={{ position: 'absolute', left: 12, top: 12, color: 'var(--app-text-muted)' }} />
            <input
              type="text"
              placeholder="搜索会话标题、指令内容或 Conversation ID..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{
                width: '100%',
                padding: '9px 12px 9px 36px',
                borderRadius: 8,
                border: '1px solid var(--app-border)',
                background: 'var(--app-card-bg)',
                fontSize: 13,
                color: 'var(--app-text)',
                outline: 'none',
                boxSizing: 'border-box'
              }}
            />
          </div>

          {/* Session Type Segmented Filter */}
          <div style={{ display: 'flex', gap: 6, background: '#e2e8f0', padding: 3, borderRadius: 8 }}>
            {[
              { id: 'ALL', label: `全部 (${overview?.totalSessions ?? 0})` },
              { id: 'main', label: `主会话 (${overview?.typeCounts?.main ?? 0})` },
              { id: 'subagent', label: `子任务 (${overview?.typeCounts?.subagent ?? 0})` },
              { id: 'side_query', label: `侧栏提问 (${overview?.typeCounts?.side_query ?? 0})` }
            ].map((t) => (
              <button
                key={t.id}
                onClick={() => setSelectedType(t.id)}
                style={{
                  padding: '6px 12px',
                  borderRadius: 6,
                  border: 'none',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  background: selectedType === t.id ? '#fff' : 'transparent',
                  color: selectedType === t.id ? '#0f172a' : '#64748b',
                  boxShadow: selectedType === t.id ? '0 1px 3px rgba(0,0,0,0.1)' : 'none'
                }}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div style={{ fontSize: 13, color: 'var(--app-text-muted)', fontWeight: 500 }}>
            匹配到 <strong style={{ color: 'var(--app-text)' }}>{filteredSessions.length}</strong> 条记录
          </div>
        </div>

        {/* Sessions Table */}
        <div
          tabIndex={0}
          role="region"
          aria-label="会话路由与输出速率明细表"
          className="table-wrapper"
        >
          <table className="sessions-table">
            <thead>
              <tr>
                <th>会话类型与标题</th>
                <th>命中路由端点</th>
                <th>推理次数</th>
                <th>输出速率 / TTFT</th>
                <th>Tokens 消耗</th>
                <th>最后活动时间</th>
                <th style={{ textAlign: 'right' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} style={{ padding: '40px 0', textAlign: 'center', color: 'var(--app-text-muted)' }}>
                    正在读取本地会话数据库...
                  </td>
                </tr>
              ) : filteredSessions.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ padding: '40px 0', textAlign: 'center', color: 'var(--app-text-muted)' }}>
                    未匹配到符合条件的会话记录
                  </td>
                </tr>
              ) : (
                filteredSessions.map((session) => (
                  <tr key={session.conversation_id}>
                    <th scope="row" style={{ maxWidth: 400 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                        {renderTypeBadge(session)}
                        <span
                          style={{
                            fontSize: 11,
                            fontFamily: 'monospace',
                            color: 'var(--app-text-muted)'
                          }}
                        >
                          {session.conversation_id.slice(0, 8)}
                        </span>
                      </div>
                      <div
                        style={{
                          fontWeight: 700,
                          color: 'var(--app-text)',
                          lineHeight: 1.4,
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden'
                        }}
                        title={session.title}
                      >
                        {session.title}
                      </div>
                    </th>

                    <td>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {session.modelsUsed.map((m) => (
                          <span
                            key={m}
                            className={getModelBadgeClass(m)}
                            style={{
                              padding: '2px 8px',
                              borderRadius: 6,
                              fontSize: 11,
                              fontWeight: 600
                            }}
                          >
                            {m} {session.modelCounts[m] ? `(${session.modelCounts[m]})` : ''}
                          </span>
                        ))}
                      </div>
                    </td>

                    <td style={{ fontWeight: 600, color: 'var(--app-text)', whiteSpace: 'nowrap' }}>
                      {session.calls} 次
                    </td>

                    <td style={{ whiteSpace: 'nowrap' }}>
                      {session.streamTps != null || session.e2eTps != null ? (
                        <div>
                          <div style={{ fontWeight: 700, color: '#0891b2' }}>
                            流式 {session.streamTps != null ? `${session.streamTps} tok/s` : '-'}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--app-text-muted)', marginTop: 2 }}>
                            端到端 {session.e2eTps != null ? `${session.e2eTps} tok/s` : '-'}
                            {session.avgTtftSec != null ? ` · TTFT ${session.avgTtftSec}s` : ''}
                          </div>
                        </div>
                      ) : (
                        <span style={{ color: 'var(--app-text-muted)' }}>-</span>
                      )}
                    </td>

                    <td style={{ color: 'var(--app-text-muted)', fontSize: 12, whiteSpace: 'nowrap' }}>
                      <div>
                        In: {session.totalInputTokens.toLocaleString()}
                        {session.totalCacheReadTokens > 0
                          ? ` · Cache: ${session.totalCacheReadTokens.toLocaleString()}`
                          : ''}
                      </div>
                      <div>
                        Out: {session.totalOutputTokens.toLocaleString()}
                        {session.thinkingSharePct > 0 ? `（思考 ${session.thinkingSharePct}%）` : ''}
                      </div>
                    </td>

                    <td style={{ color: 'var(--app-text-muted)', fontSize: 12, whiteSpace: 'nowrap' }}>
                      {session.last_modified_time
                        ? new Date(session.last_modified_time).toLocaleString('zh-CN', { hour12: false })
                        : '-'}
                    </td>

                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button
                        onClick={() => setActiveSessionId(session.conversation_id)}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          padding: '6px 12px',
                          borderRadius: 6,
                          border: '1px solid var(--app-border)',
                          background: 'var(--app-card-bg)',
                          cursor: 'pointer',
                          fontSize: 12,
                          fontWeight: 600,
                          color: '#2563eb'
                        }}
                      >
                        查看时序 <ChevronRight size={14} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </main>

      {/* Session Turns Inspector Modal */}
      {activeSessionId && (
        <div className="modal-backdrop" onClick={() => setActiveSessionId(null)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="session-modal-title"
            style={{
              background: 'var(--app-card-bg)',
              borderRadius: 16,
              width: '100%',
              maxWidth: 960,
              maxHeight: '86vh',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 20px 40px rgba(0,0,0,0.2)',
              overflow: 'hidden'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div
              style={{
                padding: '16px 24px',
                borderBottom: '1px solid var(--app-border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between'
              }}
            >
              <div>
                <h3 id="session-modal-title" style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
                  会话逐轮调用时序与输出速率钻取
                </h3>
                <div style={{ fontSize: 12, color: 'var(--app-text-muted)', marginTop: 2 }}>
                  {sessionDetail?.title} · ID: {activeSessionId}
                </div>
              </div>
              <button
                onClick={() => setActiveSessionId(null)}
                aria-label="关闭弹窗"
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 6,
                  color: 'var(--app-text-muted)'
                }}
              >
                <X size={20} />
              </button>
            </div>

            {/* Modal Body */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
              {detailLoading ? (
                <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--app-text-muted)' }}>
                  正在解算会话的 gen_metadata 时序与速率数据...
                </div>
              ) : sessionDetail ? (
                <div>
                  <div
                    style={{
                      background: '#f8fafc',
                      borderRadius: 10,
                      padding: '12px 16px',
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: '10px 20px',
                      marginBottom: 18,
                      fontSize: 12,
                      border: '1px solid var(--app-border)'
                    }}
                  >
                    <div>
                      <span style={{ color: 'var(--app-text-muted)' }}>总推理调用: </span>
                      <strong>{sessionDetail.totalCalls} 次</strong>
                    </div>
                    <div>
                      <span style={{ color: 'var(--app-text-muted)' }}>流式速率: </span>
                      <strong style={{ color: '#0891b2' }}>
                        {sessionDetail.streamTps != null ? `${sessionDetail.streamTps} tok/s` : '-'}
                      </strong>
                    </div>
                    <div>
                      <span style={{ color: 'var(--app-text-muted)' }}>端到端速率: </span>
                      <strong>
                        {sessionDetail.e2eTps != null ? `${sessionDetail.e2eTps} tok/s` : '-'}
                      </strong>
                    </div>
                    <div>
                      <span style={{ color: 'var(--app-text-muted)' }}>平均 TTFT: </span>
                      <strong>
                        {sessionDetail.avgTtftSec != null ? `${sessionDetail.avgTtftSec}s` : '-'}
                      </strong>
                    </div>
                    <div>
                      <span style={{ color: 'var(--app-text-muted)' }}>输入 / 缓存 Tokens: </span>
                      <strong>
                        {sessionDetail.totalInputTokens.toLocaleString()} / {(sessionDetail.totalCacheReadTokens || 0).toLocaleString()}
                      </strong>
                    </div>
                    <div>
                      <span style={{ color: 'var(--app-text-muted)' }}>输出 Tokens (思考 / 正文): </span>
                      <strong>
                        {sessionDetail.totalOutputTokens.toLocaleString()}（{(sessionDetail.totalThinkingTokens || 0).toLocaleString()} / {(sessionDetail.totalResponseTokens || 0).toLocaleString()}）
                      </strong>
                    </div>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {sessionDetail.generations.map((turn) => (
                      <div
                        key={turn.idx}
                        style={{
                          border: '1px solid var(--app-border)',
                          borderRadius: 10,
                          padding: '14px 16px',
                          background: '#fff'
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            flexWrap: 'wrap',
                            gap: 8,
                            marginBottom: 8
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                            <span
                              style={{
                                padding: '2px 8px',
                                borderRadius: 4,
                                background: '#e2e8f0',
                                fontSize: 11,
                                fontWeight: 700
                              }}
                            >
                              Turn #{turn.idx}
                            </span>
                            <span
                              className={getModelBadgeClass(turn.model)}
                              style={{
                                padding: '3px 10px',
                                borderRadius: 6,
                                fontSize: 12,
                                fontWeight: 700
                              }}
                            >
                              {turn.model}
                            </span>
                            {turn.streamTps != null ? (
                              <span
                                style={{
                                  padding: '2px 8px',
                                  borderRadius: 6,
                                  background: '#ecfeff',
                                  border: '1px solid #a5f3fc',
                                  color: '#0e7490',
                                  fontSize: 11,
                                  fontWeight: 700
                                }}
                              >
                                流式 {turn.streamTps} tok/s
                              </span>
                            ) : turn.streamSec != null && turn.streamSec < 0.5 && turn.responseTokens > 0 ? (
                              <span
                                style={{
                                  padding: '2px 8px',
                                  borderRadius: 6,
                                  background: '#f1f5f9',
                                  border: '1px solid #cbd5e1',
                                  color: '#475569',
                                  fontSize: 11,
                                  fontWeight: 600
                                }}
                              >
                                单包输出 ({turn.responseTokens} tok)
                              </span>
                            ) : null}
                            {turn.e2eTps != null && (
                              <span
                                style={{
                                  padding: '2px 8px',
                                  borderRadius: 6,
                                  background: '#f8fafc',
                                  border: '1px solid #e2e8f0',
                                  color: '#334155',
                                  fontSize: 11,
                                  fontWeight: 600
                                }}
                              >
                                端到端 {turn.e2eTps} tok/s
                              </span>
                            )}
                          </div>

                          <div style={{ fontSize: 12, color: 'var(--app-text-muted)' }}>
                            {turn.totalSec != null ? (
                              <span>
                                TTFT <strong>{turn.ttftSec?.toFixed(2)}s</strong> · 流式 <strong>{turn.streamSec?.toFixed(2)}s</strong> · 总耗时 <strong>{turn.totalSec.toFixed(2)}s</strong>
                              </span>
                            ) : (
                              <span>无耗时记录</span>
                            )}
                          </div>
                        </div>

                        {/* Token Split Row */}
                        <div
                          style={{
                            fontSize: 12,
                            color: '#334155',
                            marginBottom: 8,
                            display: 'flex',
                            flexWrap: 'wrap',
                            gap: '4px 16px'
                          }}
                        >
                          <span>输入: <strong>{turn.inputTokens.toLocaleString()}</strong></span>
                          <span>缓存读取: <strong>{(turn.cacheReadTokens || 0).toLocaleString()}</strong></span>
                          <span>
                            总输出: <strong>{turn.outputTokens.toLocaleString()}</strong>
                            {' '}（思考: <strong>{(turn.thinkingTokens || 0).toLocaleString()}</strong> / 正文: <strong>{(turn.responseTokens || 0).toLocaleString()}</strong>）
                          </span>
                        </div>

                        {/* Metadata Details */}
                        <div
                          style={{
                            fontSize: 11,
                            fontFamily: 'monospace',
                            background: '#f8fafc',
                            padding: '8px 12px',
                            borderRadius: 6,
                            color: '#475569',
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                            gap: 6
                          }}
                        >
                          <div>model_enum: {turn.metadata.model_enum || '-'}</div>
                          <div>last_step_index: {turn.metadata.last_step_index || '-'}</div>
                          <div>used_claude: {turn.metadata.used_claude || 'false'}</div>
                          <div>request_id: {turn.metadata.request_id || '-'}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
