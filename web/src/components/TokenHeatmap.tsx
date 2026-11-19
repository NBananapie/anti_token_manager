import React, { useMemo, useState } from 'react';
import { CalendarDays, Clock, X } from 'lucide-react';
import { HeatmapData, HeatmapDay, formatCompactTokens, formatUsd } from '../types';

type HeatmapMode = 'calendar' | 'hourly';
type HeatmapMetric = 'tokens' | 'costUsd' | 'calls';

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

// Hourly matrix geometry (matched height for zero layout shift on tab switch)
const HR_LEFT = 24;
const HR_CELL_W = 16.5;
const HR_GAP_X = 3;
const HR_PITCH_X = HR_CELL_W + HR_GAP_X; // 19.5
const HR_SVG_W = HR_LEFT + 24 * HR_PITCH_X - HR_GAP_X + 4; // 493

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function dateKeyFromDate(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
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

  const metricLabel = metric === 'tokens' ? 'Token' : metric === 'costUsd' ? '费用' : '调用';

  return (
    <section className="panel-card heatmap-card" aria-label="Token 消耗热力图">
      <div className="panel-header" style={{ marginBottom: 10 }}>
        <div className="panel-title-wrap">
          <h2 className="panel-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {mode === 'calendar' ? <CalendarDays size={15} /> : <Clock size={15} />}
            Token 消耗热力图
          </h2>
          <span className="panel-meta">
            {mode === 'calendar'
              ? `近 ${CAL_WEEKS} 周 · 活跃 ${calendarModel.activeDays} 天 · 点击日期筛选`
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
            {(
              [
                { id: 'tokens', label: 'Token' },
                { id: 'costUsd', label: '费用' },
                { id: 'calls', label: '调用' }
              ] as const
            ).map((m) => (
              <button
                key={m.id}
                type="button"
                className={`seg-btn ${metric === m.id ? 'active' : ''}`}
                onClick={() => setMetric(m.id)}
              >
                {m.label}
              </button>
            ))}
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
              className={`seg-btn ${mode === 'hourly' ? 'active' : ''}`}
              onClick={() => setMode('hourly')}
            >
              7×24h
            </button>
          </div>
        </div>
      </div>

      {/* Heatmap Canvas: Strict 1:1 Square Cells & Equal 3px Row/Col Gaps */}
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
      ) : (
        <div className="heatmap-scroll">
          <svg
            viewBox={`0 0 ${HR_SVG_W} ${CAL_SVG_H}`}
            className="heatmap-svg"
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label={`星期与 24 小时 ${metricLabel} 热力矩阵`}
          >
            {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
              <text
                key={`h-${h}`}
                x={HR_LEFT + h * HR_PITCH_X}
                y={10}
                className="hm-axis-label"
              >
                {pad2(h)}
              </text>
            ))}

            {WEEKDAY_LABELS.map((lbl, di) => (
              <text key={`wd-${di}`} x={0} y={CAL_TOP + di * CAL_PITCH + 8.5} className="hm-axis-label">
                周{lbl}
              </text>
            ))}

            {(data?.hourlyMatrix || []).map((row, dow) =>
              row.map((cell, hr) => {
                const level = computeLevel(cell[metric], hourlyThresholds);
                return (
                  <rect
                    key={`${dow}-${hr}`}
                    x={HR_LEFT + hr * HR_PITCH_X}
                    y={CAL_TOP + dow * CAL_PITCH}
                    width={HR_CELL_W}
                    height={CAL_CELL}
                    rx={2.4}
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

      {/* Telemetry Readout Footer + Scale Legend */}
      <div className="hm-footer">
        <div className="hm-readout">
          {mode === 'calendar' && hoveredDay ? (
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
                ? `全量记录范围 ${data.minDate} 至 ${data.maxDate} · 悬停查看单格明细`
                : '正在聚合本地历史记录...'}
            </span>
          )}
        </div>

        <div className="hm-legend" aria-hidden="true">
          <span>少</span>
          <span className="hm-swatch lv-0" />
          <span className="hm-swatch lv-1" />
          <span className="hm-swatch lv-2" />
          <span className="hm-swatch lv-3" />
          <span className="hm-swatch lv-4" />
          <span>多</span>
        </div>
      </div>
    </section>
  );
}
