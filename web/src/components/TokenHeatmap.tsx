import React, { useMemo, useState } from 'react';
import { BarChart3, CalendarDays, Clock, X } from 'lucide-react';
import { HeatmapData, HeatmapDay, formatCompactTokens, formatUsd } from '../types';

type HeatmapMode = 'calendar' | 'hourly' | 'bar';
type HeatmapMetric = 'tokens' | 'costUsd' | 'calls';
type BarMetric = 'all' | HeatmapMetric;
type BarWindow = '14d' | '30d' | 'all';

interface Props {
  data: HeatmapData | null;
  selectedDate: string | null;
  onSelectDate: (date: string | null) => void;
}

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
const MONTHS_ZH = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

// Exact 1:1 square calendar geometry (uniform 3px horizontal & vertical gap)
const CAL_WEEKS = 34;
const CAL_CELL = 11;
const CAL_GAP = 3;
const CAL_PITCH = CAL_CELL + CAL_GAP; // 14
const CAL_LEFT = 22;
const CAL_TOP = 17;
const CAL_SVG_W = CAL_LEFT + CAL_WEEKS * CAL_PITCH - CAL_GAP + 4; // 499
const CAL_SVG_H = CAL_TOP + 7 * CAL_PITCH - CAL_GAP + 4; // 116

// Strict 1:1 square 7x24 hourly matrix geometry (uniform horizontal & vertical gap)
const HR_LEFT = 26;
const HR_TOP = 17;
const HR_CELL = 14;
const HR_GAP = 3.5;
const HR_PITCH = HR_CELL + HR_GAP; // 17.5
const HR_SVG_W = HR_LEFT + 24 * HR_PITCH - HR_GAP + 4; // 446.5
const HR_SVG_H = HR_TOP + 7 * HR_PITCH - HR_GAP + 4; // 139.5

// Daily bar chart geometry
const BAR_LEFT = 38;
const BAR_RIGHT = 8;
const BAR_TOP = 10;
const BAR_BOTTOM = 18;
const BAR_PLOT_H = 100;
const BAR_SVG_H = BAR_TOP + BAR_PLOT_H + BAR_BOTTOM; // 128
const BAR_BASE_W = CAL_SVG_W; // 499

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function dateKeyFromDate(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function computeNiceMax(rawMax: number): number {
  if (!rawMax || rawMax <= 0) return 1;
  const exp = Math.floor(Math.log10(rawMax));
  const mag = 10 ** exp;
  const norm = rawMax / mag;
  const niceNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return niceNorm * mag;
}

function formatAxisTick(value: number, metric: HeatmapMetric): string {
  if (value <= 0) return metric === 'costUsd' ? '$0' : '0';
  if (metric === 'tokens') {
    return formatCompactTokens(value).replace(/\.0+([KMB])$/, '$1');
  }
  if (metric === 'costUsd') {
    if (value < 0.1) return `$${value.toFixed(2)}`;
    if (value < 10) return `$${Number(value.toFixed(1))}`;
    return `$${Math.round(value)}`;
  }
  if (value >= 1000) return `${Number((value / 1000).toFixed(1))}K`;
  return String(Math.round(value));
}

function computeLevel(val: number, thresholds: [number, number, number]): 0 | 1 | 2 | 3 | 4 {
  if (!val || val <= 0) return 0;
  if (val <= thresholds[0]) return 1;
  if (val <= thresholds[1]) return 2;
  if (val <= thresholds[2]) return 3;
  return 4;
}

function buildThresholds(values: number[]): [number, number, number] {
  const pos = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (pos.length === 0) return [1, 2, 3];
  const q = (p: number) => pos[Math.min(pos.length - 1, Math.floor(p * (pos.length - 1)))];
  return [q(0.25), q(0.55), q(0.82)];
}

export default function TokenHeatmap({ data, selectedDate, onSelectDate }: Props) {
  const [mode, setMode] = useState<HeatmapMode>('calendar');
  const [metric, setMetric] = useState<HeatmapMetric>('tokens');
  const [barMetric, setBarMetric] = useState<BarMetric>('all');
  const [barWindow, setBarWindow] = useState<BarWindow>('30d');
  const [hoveredDay, setHoveredDay] = useState<{ date: string; rec?: HeatmapDay } | null>(null);
  const [hoveredHour, setHoveredHour] = useState<{
    dow: number;
    hour: number;
    tokens: number;
    costUsd: number;
    calls: number;
  } | null>(null);

  const dayMap = useMemo(() => {
    const m = new Map<string, HeatmapDay>();
    for (const d of data?.daily || []) {
      m.set(d.date, d);
    }
    return m;
  }, [data]);

  const calendarModel = useMemo(() => {
    const today = new Date();
    const todayNoon = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12, 0, 0);
    const todayDow = (todayNoon.getDay() + 6) % 7; // Mon=0 .. Sun=6
    const endSun = new Date(todayNoon);
    endSun.setDate(todayNoon.getDate() + (6 - todayDow));

    const startMon = new Date(endSun);
    startMon.setDate(endSun.getDate() - (CAL_WEEKS * 7 - 1));

    const weeks: { days: { date: string; future: boolean; rec?: HeatmapDay }[]; monthLabel?: string }[] = [];
    const metricVals: number[] = [];
    let lastMonth = -1;
    let lastLabelWeek = -10;

    for (let w = 0; w < CAL_WEEKS; w++) {
      const days: { date: string; future: boolean; rec?: HeatmapDay }[] = [];
      let monthLabel: string | undefined;

      for (let d = 0; d < 7; d++) {
        const cur = new Date(startMon);
        cur.setDate(startMon.getDate() + w * 7 + d);
        const key = dateKeyFromDate(cur);
        const future = cur.getTime() > todayNoon.getTime();
        const rec = dayMap.get(key);
        if (rec) {
          metricVals.push(rec[metric]);
        }
        if (d === 0) {
          const mo = cur.getMonth();
          if (mo !== lastMonth) {
            if (w - lastLabelWeek >= 3) {
              monthLabel = MONTHS_ZH[mo];
              lastLabelWeek = w;
            }
            lastMonth = mo;
          }
        }
        days.push({ date: key, future, rec });
      }
      weeks.push({ days, monthLabel });
    }

    // Drop week-0 partial month if week-1 transitions to the next month
    if (weeks.length >= 2 && weeks[0].monthLabel) {
      const w0Month = new Date(`${weeks[0].days[0].date}T12:00:00`).getMonth();
      const w1Month = new Date(`${weeks[1].days[0].date}T12:00:00`).getMonth();
      if (w0Month !== w1Month) {
        weeks[0].monthLabel = undefined;
        weeks[1].monthLabel = MONTHS_ZH[w1Month];
      }
    }

    const thresholds = buildThresholds(metricVals);
    const activeDays = (data?.daily || []).filter((d) => d.tokens > 0).length;
    return { weeks, thresholds, activeDays };
  }, [dayMap, data, metric]);

  const hourlyThresholds = useMemo(() => {
    const vals: number[] = [];
    for (const row of data?.hourlyMatrix || []) {
      for (const cell of row) {
        vals.push(cell[metric]);
      }
    }
    return buildThresholds(vals);
  }, [data, metric]);

  const barModel = useMemo(() => {
    const today = new Date();
    const todayNoon = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12, 0, 0);
    const endKey = dateKeyFromDate(todayNoon);
    const endDate =
      data?.maxDate && data.maxDate > endKey
        ? new Date(`${data.maxDate}T12:00:00`)
        : todayNoon;

    let startDate: Date;
    if (barWindow === '14d') {
      startDate = new Date(endDate);
      startDate.setDate(endDate.getDate() - 13);
    } else if (barWindow === '30d') {
      startDate = new Date(endDate);
      startDate.setDate(endDate.getDate() - 29);
    } else if (data?.minDate) {
      startDate = new Date(`${data.minDate}T12:00:00`);
    } else {
      startDate = new Date(endDate);
      startDate.setDate(endDate.getDate() - 29);
    }

    const items: {
      date: string;
      shortLabel: string;
      tokens: number;
      costUsd: number;
      calls: number;
      rec?: HeatmapDay;
    }[] = [];
    const cur = new Date(startDate);
    while (cur.getTime() <= endDate.getTime()) {
      const key = dateKeyFromDate(cur);
      const rec = dayMap.get(key);
      items.push({
        date: key,
        shortLabel: key.slice(5),
        tokens: rec?.tokens || 0,
        costUsd: rec?.costUsd || 0,
        calls: rec?.calls || 0,
        rec
      });
      cur.setDate(cur.getDate() + 1);
    }

    const peaks = {
      tokens: items.reduce((mx, it) => Math.max(mx, it.tokens), 0),
      costUsd: items.reduce((mx, it) => Math.max(mx, it.costUsd), 0),
      calls: items.reduce((mx, it) => Math.max(mx, it.calls), 0)
    };
    const totals = {
      tokens: items.reduce((s, it) => s + it.tokens, 0),
      costUsd: items.reduce((s, it) => s + it.costUsd, 0),
      calls: items.reduce((s, it) => s + it.calls, 0)
    };

    const singleMetric: HeatmapMetric = barMetric === 'all' ? 'tokens' : barMetric;
    const rawMax = peaks[singleMetric];
    const yMax = computeNiceMax(rawMax);

    const minColPitch = barMetric === 'all' ? 12 : 6.5;
    const minPlotW = Math.max(BAR_BASE_W - BAR_LEFT - BAR_RIGHT, items.length * minColPitch);
    const svgW = BAR_LEFT + minPlotW + BAR_RIGHT;
    const plotW = svgW - BAR_LEFT - BAR_RIGHT;
    const colPitch = items.length > 0 ? plotW / items.length : plotW;
    const barW = Math.max(2.5, Math.min(20, colPitch * 0.68));
    const groupW = Math.max(5.5, Math.min(26, colPitch * 0.78));
    const subGap = Math.max(0.7, Math.min(1.6, groupW * 0.08));
    const subBarW = Math.max(1.5, (groupW - 2 * subGap) / 3);

    // Pick evenly spaced non-overlapping X-axis tick indices
    const maxTicks = Math.max(2, Math.floor(plotW / 62));
    const step = Math.max(1, Math.ceil(items.length / maxTicks));
    const tickIndices: number[] = [];
    for (let i = 0; i < items.length; i += step) {
      tickIndices.push(i);
    }
    const lastIdx = items.length - 1;
    if (lastIdx > 0 && tickIndices[tickIndices.length - 1] !== lastIdx) {
      if ((lastIdx - tickIndices[tickIndices.length - 1]) * colPitch < 34) {
        tickIndices[tickIndices.length - 1] = lastIdx;
      } else {
        tickIndices.push(lastIdx);
      }
    }

    return {
      items,
      peaks,
      totals,
      singleMetric,
      yMax,
      svgW,
      plotW,
      colPitch,
      barW,
      groupW,
      subGap,
      subBarW,
      tickIndices
    };
  }, [barMetric, barWindow, data, dayMap]);

  const metricLabel = metric === 'tokens' ? 'Token' : metric === 'costUsd' ? '费用' : '调用';
  const barWindowLabel = barWindow === '14d' ? '近 14 天' : barWindow === '30d' ? '近 30 天' : '全量';
  const barSummaryText =
    barMetric === 'all'
      ? `${barWindowLabel} · 三指标同显`
      : barMetric === 'tokens'
        ? `${barWindowLabel} · 累计 ${formatCompactTokens(barModel.totals.tokens)}`
        : barMetric === 'costUsd'
          ? `${barWindowLabel} · 累计 ${formatUsd(barModel.totals.costUsd)}`
          : `${barWindowLabel} · 累计 ${barModel.totals.calls.toLocaleString()} 次`;

  return (
    <section className="panel-card heatmap-card" aria-label="Token 消耗热力图">
      <div className="panel-header" style={{ marginBottom: 10 }}>
        <div className="panel-title-wrap">
          <h2 className="panel-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {mode === 'calendar' ? (
              <CalendarDays size={15} />
            ) : mode === 'bar' ? (
              <BarChart3 size={15} />
            ) : (
              <Clock size={15} />
            )}
            Token 消耗热力图
          </h2>
          <span className="panel-meta">
            {mode === 'calendar'
              ? `近 ${CAL_WEEKS} 周 · 活跃 ${calendarModel.activeDays} 天 · 点击日期筛选`
              : mode === 'bar'
                ? barSummaryText
                : '全历史星期 × 24 小时活跃分布'}
          </span>
        </div>

        <div className="panel-controls">
          {selectedDate && (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => onSelectDate(null)}
              title="清除日期筛选"
            >
              <X size={12} />
              <span className="mono">{selectedDate}</span>
            </button>
          )}

          <div className="segmented" role="group" aria-label="热力图指标">
            {mode === 'bar' && (
              <button
                type="button"
                className={`seg-btn ${barMetric === 'all' ? 'active' : ''}`}
                onClick={() => setBarMetric('all')}
              >
                全部
              </button>
            )}
            {(
              [
                { id: 'tokens', label: 'Token' },
                { id: 'costUsd', label: '费用' },
                { id: 'calls', label: '调用' }
              ] as const
            ).map((m) => {
              const isActive = mode === 'bar' ? barMetric === m.id : metric === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  className={`seg-btn ${isActive ? 'active' : ''}`}
                  onClick={() => {
                    if (mode === 'bar') {
                      setBarMetric(m.id);
                    }
                    setMetric(m.id);
                  }}
                >
                  {m.label}
                </button>
              );
            })}
          </div>

          <div className="segmented" role="group" aria-label="热力图视图">
            <button
              type="button"
              className={`seg-btn ${mode === 'calendar' ? 'active' : ''}`}
              onClick={() => setMode('calendar')}
            >
              按天
            </button>
            <button
              type="button"
              className={`seg-btn ${mode === 'bar' ? 'active' : ''}`}
              onClick={() => setMode('bar')}
            >
              柱状图
            </button>
            <button
              type="button"
              className={`seg-btn ${mode === 'hourly' ? 'active' : ''}`}
              onClick={() => setMode('hourly')}
            >
              7×24h
            </button>
          </div>
        </div>
      </div>

      {/* Visualization Canvas */}
      {mode === 'calendar' ? (
        <div className="heatmap-scroll">
          <svg
            viewBox={`0 0 ${CAL_SVG_W} ${CAL_SVG_H}`}
            className="heatmap-svg"
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label={`按天 ${metricLabel} 消耗热力图`}
          >
            {calendarModel.weeks.map((wk, wi) =>
              wk.monthLabel ? (
                <text
                  key={`m-${wi}`}
                  x={CAL_LEFT + wi * CAL_PITCH}
                  y={10}
                  className="hm-axis-label"
                >
                  {wk.monthLabel}
                </text>
              ) : null
            )}

            {[0, 2, 4, 6].map((di) => (
              <text
                key={`d-${di}`}
                x={0}
                y={CAL_TOP + di * CAL_PITCH + 8.5}
                className="hm-axis-label"
              >
                {WEEKDAY_LABELS[di]}
              </text>
            ))}

            {calendarModel.weeks.map((wk, wi) =>
              wk.days.map((day, di) => {
                const val = day.rec ? day.rec[metric] : 0;
                const level = day.future ? 0 : computeLevel(val, calendarModel.thresholds);
                const isSelected = selectedDate === day.date;
                const x = CAL_LEFT + wi * CAL_PITCH;
                const y = CAL_TOP + di * CAL_PITCH;

                return (
                  <rect
                    key={day.date}
                    x={x}
                    y={y}
                    width={CAL_CELL}
                    height={CAL_CELL}
                    rx={2.4}
                    className={`hm-cell lv-${level} ${day.future ? 'future' : ''} ${isSelected ? 'selected' : ''}`}
                    style={{ cursor: !day.future && day.rec ? 'pointer' : 'default' }}
                    onMouseEnter={() => setHoveredDay({ date: day.date, rec: day.rec })}
                    onMouseLeave={() => setHoveredDay(null)}
                    onClick={() => {
                      if (day.future) return;
                      if (selectedDate === day.date) {
                        onSelectDate(null);
                      } else if (day.rec) {
                        onSelectDate(day.date);
                      }
                    }}
                  >
                    <title>
                      {day.rec
                        ? `${day.date} · ${formatCompactTokens(day.rec.tokens)} tokens · ${formatUsd(day.rec.costUsd)} · ${day.rec.calls} 次 (${day.rec.sessions} 会话)`
                        : `${day.date} · 无记录`}
                    </title>
                  </rect>
                );
              })
            )}
          </svg>
        </div>
      ) : mode === 'bar' ? (
        <div className="hm-bar-wrap">
          {barMetric === 'all' && (
            <div className="hm-bar-legend" aria-label="柱状图指标图例（各指标按各自窗口峰值归一化）">
              <button
                type="button"
                className="hm-bar-legend-item"
                onClick={() => {
                  setBarMetric('tokens');
                  setMetric('tokens');
                }}
                title="点击单独查看 Token 绝对值"
              >
                <span className="hm-bar-dot tokens" />
                <span>Token</span>
                <span className="hm-bar-peak mono">峰值 {formatCompactTokens(barModel.peaks.tokens)}</span>
              </button>
              <button
                type="button"
                className="hm-bar-legend-item"
                onClick={() => {
                  setBarMetric('costUsd');
                  setMetric('costUsd');
                }}
                title="点击单独查看费用绝对值"
              >
                <span className="hm-bar-dot costUsd" />
                <span>费用</span>
                <span className="hm-bar-peak mono">峰值 {formatUsd(barModel.peaks.costUsd)}</span>
              </button>
              <button
                type="button"
                className="hm-bar-legend-item"
                onClick={() => {
                  setBarMetric('calls');
                  setMetric('calls');
                }}
                title="点击单独查看调用次数绝对值"
              >
                <span className="hm-bar-dot calls" />
                <span>调用</span>
                <span className="hm-bar-peak mono">峰值 {barModel.peaks.calls.toLocaleString()}</span>
              </button>
              <span className="hm-bar-norm-hint">各指标按自身峰值归一化</span>
            </div>
          )}

          <div className="heatmap-scroll">
            <svg
              viewBox={`0 0 ${barModel.svgW} ${BAR_SVG_H}`}
              className="heatmap-svg heatmap-bar-svg"
              style={barModel.svgW > BAR_BASE_W ? { minWidth: `${barModel.svgW}px` } : undefined}
              preserveAspectRatio="xMidYMid meet"
              role="img"
              aria-label={
                barMetric === 'all'
                  ? '按天 Token、费用与调用三指标对比柱状图'
                  : `按天 ${barMetric === 'tokens' ? 'Token' : barMetric === 'costUsd' ? '费用' : '调用'} 消耗柱状图`
              }
            >
              {/* Horizontal gridlines & Y-axis labels */}
              {[0, 0.5, 1].map((ratio) => {
                const y = BAR_TOP + BAR_PLOT_H * (1 - ratio);
                const label =
                  barMetric === 'all'
                    ? `${Math.round(ratio * 100)}%`
                    : formatAxisTick(barModel.yMax * ratio, barModel.singleMetric);
                return (
                  <g key={`y-${ratio}`}>
                    <line
                      x1={BAR_LEFT}
                      y1={y}
                      x2={barModel.svgW - BAR_RIGHT}
                      y2={y}
                      className={`hm-bar-grid ${ratio === 0 ? 'baseline' : ''}`}
                    />
                    <text
                      x={BAR_LEFT - 5}
                      y={y + 3}
                      textAnchor="end"
                      className="hm-axis-label hm-bar-y-label"
                    >
                      {label}
                    </text>
                  </g>
                );
              })}

              {/* X-axis date ticks */}
              {barModel.tickIndices.map((idx) => {
                const item = barModel.items[idx];
                if (!item) return null;
                const cx = BAR_LEFT + (idx + 0.5) * barModel.colPitch;
                const anchor = idx === 0 ? 'start' : idx === barModel.items.length - 1 ? 'end' : 'middle';
                const tx =
                  idx === 0
                    ? Math.max(BAR_LEFT, cx - barModel.groupW / 2)
                    : idx === barModel.items.length - 1
                      ? Math.min(barModel.svgW - BAR_RIGHT, cx + barModel.groupW / 2)
                      : cx;
                return (
                  <text
                    key={`xt-${item.date}`}
                    x={tx}
                    y={BAR_TOP + BAR_PLOT_H + 12}
                    textAnchor={anchor}
                    className="hm-axis-label hm-bar-x-label"
                  >
                    {item.shortLabel}
                  </text>
                );
              })}

              {/* Bars + full-column hit targets */}
              {barModel.items.map((item, idx) => {
                const colX = BAR_LEFT + idx * barModel.colPitch;
                const isSelected = selectedDate === item.date;
                const isHovered = hoveredDay?.date === item.date;
                const isDimmed = Boolean(selectedDate && !isSelected && !isHovered);
                const clickable = Boolean(item.rec);
                const groupX = colX + (barModel.colPitch - barModel.groupW) / 2;

                return (
                  <g
                    key={item.date}
                    className={`hm-bar-col ${clickable ? 'clickable' : ''} ${isSelected ? 'selected' : ''} ${isHovered ? 'hovered' : ''} ${isDimmed ? 'dimmed' : ''}`}
                    onMouseEnter={() => setHoveredDay({ date: item.date, rec: item.rec })}
                    onMouseLeave={() => setHoveredDay(null)}
                    onClick={() => {
                      if (selectedDate === item.date) {
                        onSelectDate(null);
                      } else if (item.rec) {
                        onSelectDate(item.date);
                      }
                    }}
                  >
                    <title>
                      {item.rec
                        ? `${item.date} · ${formatCompactTokens(item.rec.tokens)} tokens · ${formatUsd(item.rec.costUsd)} · ${item.rec.calls} 次 (${item.rec.sessions} 会话)`
                        : `${item.date} · 无记录`}
                    </title>
                    <rect
                      x={colX}
                      y={BAR_TOP}
                      width={barModel.colPitch}
                      height={BAR_PLOT_H}
                      rx={2}
                      className="hm-bar-hit"
                    />
                    {barMetric === 'all' ? (
                      <>
                        {(['tokens', 'costUsd', 'calls'] as const).map((seriesKey, si) => {
                          const val = item[seriesKey];
                          const peak = barModel.peaks[seriesKey];
                          const rawH = peak > 0 ? (val / peak) * BAR_PLOT_H : 0;
                          const h = val > 0 ? Math.max(2, rawH) : 0;
                          const bx = groupX + si * (barModel.subBarW + barModel.subGap);
                          const by = BAR_TOP + BAR_PLOT_H - h;
                          return h > 0 ? (
                            <rect
                              key={seriesKey}
                              x={bx}
                              y={by}
                              width={barModel.subBarW}
                              height={h}
                              rx={Math.min(1.6, barModel.subBarW / 2)}
                              className={`hm-bar-rect metric-${seriesKey} ${isSelected ? 'selected' : ''}`}
                            />
                          ) : (
                            <line
                              key={seriesKey}
                              x1={bx}
                              y1={BAR_TOP + BAR_PLOT_H - 0.5}
                              x2={bx + barModel.subBarW}
                              y2={BAR_TOP + BAR_PLOT_H - 0.5}
                              className="hm-bar-zero-tick"
                            />
                          );
                        })}
                      </>
                    ) : (
                      (() => {
                        const val = item[barModel.singleMetric];
                        const rawH = barModel.yMax > 0 ? (val / barModel.yMax) * BAR_PLOT_H : 0;
                        const barH = val > 0 ? Math.max(2.5, rawH) : 0;
                        const barX = colX + (barModel.colPitch - barModel.barW) / 2;
                        const barY = BAR_TOP + BAR_PLOT_H - barH;
                        return barH > 0 ? (
                          <rect
                            x={barX}
                            y={barY}
                            width={barModel.barW}
                            height={barH}
                            rx={Math.min(2.5, barModel.barW / 2)}
                            className={`hm-bar-rect metric-${barModel.singleMetric} ${isSelected ? 'selected' : ''}`}
                          />
                        ) : (
                          <line
                            x1={barX}
                            y1={BAR_TOP + BAR_PLOT_H - 0.5}
                            x2={barX + barModel.barW}
                            y2={BAR_TOP + BAR_PLOT_H - 0.5}
                            className="hm-bar-zero-tick"
                          />
                        );
                      })()
                    )}
                  </g>
                );
              })}
            </svg>
          </div>
        </div>
      ) : (
        <div className="heatmap-scroll">
          <svg
            viewBox={`0 0 ${HR_SVG_W} ${HR_SVG_H}`}
            className="heatmap-svg hourly"
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label={`星期与 24 小时 ${metricLabel} 热力矩阵`}
          >
            {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
              <text
                key={`h-${h}`}
                x={HR_LEFT + h * HR_PITCH}
                y={10}
                className="hm-axis-label hm-hourly-label"
              >
                {pad2(h)}
              </text>
            ))}

            {WEEKDAY_LABELS.map((lbl, di) => (
              <text
                key={`wd-${di}`}
                x={0}
                y={HR_TOP + di * HR_PITCH + HR_CELL * 0.74}
                className="hm-axis-label hm-hourly-label"
              >
                周{lbl}
              </text>
            ))}

            {(data?.hourlyMatrix || []).map((row, dow) =>
              row.map((cell, hr) => {
                const level = computeLevel(cell[metric], hourlyThresholds);
                return (
                  <rect
                    key={`${dow}-${hr}`}
                    x={HR_LEFT + hr * HR_PITCH}
                    y={HR_TOP + dow * HR_PITCH}
                    width={HR_CELL}
                    height={HR_CELL}
                    rx={2.6}
                    className={`hm-cell lv-${level}`}
                    onMouseEnter={() => setHoveredHour({ dow, hour: hr, ...cell })}
                    onMouseLeave={() => setHoveredHour(null)}
                  >
                    <title>
                      {`周${WEEKDAY_LABELS[dow]} ${pad2(hr)}:00-${pad2(hr)}:59 · ${formatCompactTokens(cell.tokens)} tokens · ${formatUsd(cell.costUsd)} · ${cell.calls} 次`}
                    </title>
                  </rect>
                );
              })
            )}
          </svg>
        </div>
      )}

      {/* Telemetry Readout Footer + Scale Legend / Bar Window Switcher */}
      <div className="hm-footer">
        <div className="hm-readout">
          {(mode === 'calendar' || mode === 'bar') && hoveredDay ? (
            hoveredDay.rec ? (
              <>
                <strong className="mono">{hoveredDay.date}</strong>
                <span>{formatCompactTokens(hoveredDay.rec.tokens)} tokens</span>
                <span className="hm-cost">{formatUsd(hoveredDay.rec.costUsd)}</span>
                <span>
                  {hoveredDay.rec.calls} 次 · {hoveredDay.rec.sessions} 会话
                  {hoveredDay.rec.compactions > 0 ? ` · ${hoveredDay.rec.compactions} 压` : ''}
                </span>
              </>
            ) : (
              <>
                <strong className="mono">{hoveredDay.date}</strong>
                <span>当日无本地推理记录</span>
              </>
            )
          ) : mode === 'hourly' && hoveredHour ? (
            <>
              <strong>
                周{WEEKDAY_LABELS[hoveredHour.dow]} {pad2(hoveredHour.hour)}:00–{pad2(hoveredHour.hour)}:59
              </strong>
              <span>{formatCompactTokens(hoveredHour.tokens)} tokens</span>
              <span className="hm-cost">{formatUsd(hoveredHour.costUsd)}</span>
              <span>{hoveredHour.calls} 次调用</span>
            </>
          ) : (
            <span>
              {data?.minDate && data?.maxDate
                ? `全量记录范围 ${data.minDate} 至 ${data.maxDate} · 悬停查看${mode === 'bar' ? '单日' : '单格'}明细`
                : '正在聚合本地历史记录...'}
            </span>
          )}
        </div>

        {mode === 'bar' ? (
          <div className="segmented hm-bar-window-seg" role="group" aria-label="柱状图时间跨度">
            {(
              [
                { id: '14d', label: '14天' },
                { id: '30d', label: '30天' },
                { id: 'all', label: '全量' }
              ] as const
            ).map((w) => (
              <button
                key={w.id}
                type="button"
                className={`seg-btn ${barWindow === w.id ? 'active' : ''}`}
                onClick={() => setBarWindow(w.id)}
              >
                {w.label}
              </button>
            ))}
          </div>
        ) : (
          <div className="hm-legend" aria-hidden="true">
            <span>少</span>
            <span className="hm-swatch lv-0" />
            <span className="hm-swatch lv-1" />
            <span className="hm-swatch lv-2" />
            <span className="hm-swatch lv-3" />
            <span className="hm-swatch lv-4" />
            <span>多</span>
          </div>
        )}
      </div>
    </section>
  );
}
