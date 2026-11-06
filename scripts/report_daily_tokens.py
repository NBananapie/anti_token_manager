#!/usr/bin/env python3
"""
Antigravity Daily & Weekly Token Consumption Reporter (Gemini & Claude)
Zero-dependency script using Python standard library.

Logic:
  - If executed on Monday (or --date is a Monday):
    Aggregates the past 7 days (last week Monday to Sunday).
  - If executed on Tuesday through Sunday (or --date is not a Monday):
    Aggregates yesterday's data (1 day).
  - Explicitly audits:
    1. Overall token usage, cache hit rate, and API costs across all models
    2. Provider breakdown (Google Gemini vs Anthropic Claude — always shown explicitly)
    3. Granular model breakdown (Gemini 4 Argon, Gemini 3.8 Flash, Claude Opus/Sonnet/Haiku, etc.)
    4. Parent main agents vs derived subagents consumption breakdown
    5. Context compaction (checkpoint) event counts and metrics
    6. Daily trend and Top sessions (with per-session models)
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

# Ensure script directory is available in sys.path
_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

# Ensure stdout handles UTF-8 properly on Windows consoles
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

from analyze_tokens import aggregate_metrics
from formatter import format_token_dual
from pricing import get_model_display_name, is_claude_model
from transcript import DEFAULT_BASE_DIR, DEFAULT_TZ, TranscriptScanner, compute_speed_metrics


def determine_date_range(target_date: datetime) -> tuple[bool, datetime, datetime, str]:
    """
    Determine evaluation date range based on weekday.
    Weekday 0 is Monday.
    Returns: (is_monday, start_date, end_date, period_label)
    """
    if target_date.weekday() == 0:
        start_date = (target_date - timedelta(days=7)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        end_date = (target_date - timedelta(days=1)).replace(
            hour=23, minute=59, second=59, microsecond=999999
        )
        start_str = start_date.strftime("%Y-%m-%d")
        end_str = end_date.strftime("%Y-%m-%d")
        label = f"上周七天（{start_str} 至 {end_str}）汇总报告"
        return True, start_date, end_date, label
    else:
        yesterday = target_date - timedelta(days=1)
        start_date = yesterday.replace(hour=0, minute=0, second=0, microsecond=0)
        end_date = yesterday.replace(hour=23, minute=59, second=59, microsecond=999999)
        y_str = yesterday.strftime("%Y-%m-%d")
        label = f"昨日（{y_str}）消耗报告"
        return False, start_date, end_date, label


def analyze_daily_tokens(
    target_date: datetime | None = None,
    base_dir: str | None = None,
    top_n: int = 10,
) -> dict[str, Any]:
    """Run full daily/weekly audit across Gemini and Claude models in a single pass."""
    if target_date is None:
        target_date = datetime.now(DEFAULT_TZ)
    elif target_date.tzinfo is None:
        target_date = target_date.replace(tzinfo=DEFAULT_TZ)

    is_monday, start_dt, end_dt, period_label = determine_date_range(target_date)
    start_str = start_dt.strftime("%Y-%m-%d")
    end_str = end_dt.strftime("%Y-%m-%d")

    scanner = TranscriptScanner(base_dirs=base_dir)
    convs, steps = scanner.scan(start_dt, end_dt)

    total_metrics = aggregate_metrics(steps, convs)

    # 1. Provider (Google Gemini vs Anthropic Claude) & Granular Model breakdown
    providers_stat: dict[str, dict[str, Any]] = {
        "gemini": {
            "label": "Google Gemini 系列",
            "steps": 0,
            "inp": 0,
            "cache": 0,
            "out": 0,
            "thinking": 0,
            "response": 0,
            "cost": 0.0,
            "convs": set(),
            "_steps": [],
        },
        "claude": {
            "label": "Anthropic Claude 系列",
            "steps": 0,
            "inp": 0,
            "cache": 0,
            "out": 0,
            "thinking": 0,
            "response": 0,
            "cost": 0.0,
            "convs": set(),
            "_steps": [],
        },
    }
    models_stat: dict[str, dict[str, Any]] = defaultdict(
        lambda: {
            "provider": "gemini",
            "steps": 0,
            "inp": 0,
            "cache": 0,
            "out": 0,
            "thinking": 0,
            "response": 0,
            "cost": 0.0,
            "convs": set(),
            "_steps": [],
        }
    )
    conv_models_used: dict[str, list[str]] = defaultdict(list)

    for s in steps:
        if s["has_tokens"]:
            m_disp = get_model_display_name(s["model"])
            prov_key = "claude" if is_claude_model(m_disp) else "gemini"

            providers_stat[prov_key]["steps"] += 1
            providers_stat[prov_key]["inp"] += s["input_tokens"]
            providers_stat[prov_key]["cache"] += s["cache_read_tokens"]
            providers_stat[prov_key]["out"] += s["output_tokens"]
            providers_stat[prov_key]["thinking"] += s.get("thinking_tokens", 0)
            providers_stat[prov_key]["response"] += s.get("response_tokens", 0)
            providers_stat[prov_key]["cost"] += s["cost_total"]
            providers_stat[prov_key]["convs"].add(s["conv_id"])
            providers_stat[prov_key]["_steps"].append(s)

            models_stat[m_disp]["provider"] = prov_key
            models_stat[m_disp]["steps"] += 1
            models_stat[m_disp]["inp"] += s["input_tokens"]
            models_stat[m_disp]["cache"] += s["cache_read_tokens"]
            models_stat[m_disp]["out"] += s["output_tokens"]
            models_stat[m_disp]["thinking"] += s.get("thinking_tokens", 0)
            models_stat[m_disp]["response"] += s.get("response_tokens", 0)
            models_stat[m_disp]["cost"] += s["cost_total"]
            models_stat[m_disp]["convs"].add(s["conv_id"])
            models_stat[m_disp]["_steps"].append(s)

            if m_disp not in conv_models_used[s["conv_id"]]:
                conv_models_used[s["conv_id"]].append(m_disp)

    # Serialize sets to counts for JSON compatibility
    providers_out = {}
    for pk, pdata in providers_stat.items():
        p_speed = compute_speed_metrics(pdata["_steps"])
        providers_out[pk] = {
            "label": pdata["label"],
            "session_count": len(pdata["convs"]),
            "steps": pdata["steps"],
            "input_tokens": pdata["inp"],
            "cache_read_tokens": pdata["cache"],
            "output_tokens": pdata["out"],
            "thinking_tokens": pdata["thinking"],
            "response_tokens": pdata["response"],
            "total_tokens": pdata["inp"] + pdata["cache"] + pdata["out"],
            "avg_ttft_s": p_speed["avg_ttft_s"],
            "stream_tps": p_speed["stream_tps"],
            "e2e_tps": p_speed["e2e_tps"],
            "cost_total": pdata["cost"],
        }

    models_out = {}
    for m_name, mdata in sorted(models_stat.items(), key=lambda x: -x[1]["cost"]):
        m_speed = compute_speed_metrics(mdata["_steps"])
        models_out[m_name] = {
            "provider": mdata["provider"],
            "session_count": len(mdata["convs"]),
            "steps": mdata["steps"],
            "inp": mdata["inp"],
            "cache": mdata["cache"],
            "out": mdata["out"],
            "thinking": mdata["thinking"],
            "response": mdata["response"],
            "avg_ttft_s": m_speed["avg_ttft_s"],
            "stream_tps": m_speed["stream_tps"],
            "e2e_tps": m_speed["e2e_tps"],
            "cost": mdata["cost"],
        }

    # 2. Parent Main vs Subagents breakdown
    main_convs = [c for c in convs if not c.get("is_subagent")]
    sub_convs = [c for c in convs if c.get("is_subagent")]

    def sum_conv_metrics(conv_list: list[dict[str, Any]]) -> dict[str, Any]:
        c_ids = {c["conv_id"] for c in conv_list}
        c_steps = [s for s in steps if s.get("conv_id") in c_ids and s.get("has_tokens")]
        inp = sum(s["input_tokens"] for s in c_steps)
        cache = sum(s["cache_read_tokens"] for s in c_steps)
        out = sum(s["output_tokens"] for s in c_steps)
        tot = inp + cache + out
        cost = sum(s["cost_total"] for s in c_steps)
        c_speed = compute_speed_metrics(c_steps)
        return {
            "session_count": len(conv_list),
            "step_count": len(c_steps),
            "input_tokens": inp,
            "cache_read_tokens": cache,
            "output_tokens": out,
            "total_tokens": tot,
            "avg_ttft_s": c_speed["avg_ttft_s"],
            "stream_tps": c_speed["stream_tps"],
            "e2e_tps": c_speed["e2e_tps"],
            "cost_total": cost,
        }

    main_metrics = sum_conv_metrics(main_convs)
    sub_metrics = sum_conv_metrics(sub_convs)

    # 3. Daily breakdown
    time_groups: dict[str, dict[str, Any]] = defaultdict(lambda: {"steps": [], "convs": set()})
    for s in steps:
        if not s["dt"]:
            continue
        tkey = s["dt"].strftime("%Y-%m-%d")
        time_groups[tkey]["steps"].append(s)
        time_groups[tkey]["convs"].add(s["conv_id"])

    conv_map = {c["conv_id"]: c for c in convs}
    daily_stat = {}
    for tkey, d in time_groups.items():
        c_list = []
        for cid in d["convs"]:
            if cid in conv_map:
                c_item = dict(conv_map[cid])
                c_item["compact_events"] = [
                    ce
                    for ce in conv_map[cid]["compact_events"]
                    if ce.get("dt") and ce["dt"].strftime("%Y-%m-%d") == tkey
                ]
                c_list.append(c_item)
        daily_stat[tkey] = aggregate_metrics(d["steps"], c_list)

    # 4. Top sessions with model list & agent hierarchy type
    top_convs = sorted(convs, key=lambda x: -x["cost_total"])[:top_n]
    enriched_top = []
    for c in top_convs:
        cid = c["conv_id"]
        enriched_top.append(
            {
                "conv_id": cid,
                "title": c["title"],
                "is_subagent": bool(c.get("is_subagent")),
                "agent_name": c.get("agent_name") or ("Subagent" if c.get("is_subagent") else "Main"),
                "parent_id": c.get("parent_id") or "",
                "models": conv_models_used.get(cid, []),
                "step_count": c.get("token_step_count", c.get("step_count", 0)),
                "input_tokens": c.get("input_tokens", 0),
                "cache_read_tokens": c.get("cache_read_tokens", 0),
                "output_tokens": c.get("output_tokens", 0),
                "thinking_tokens": c.get("thinking_tokens", 0),
                "response_tokens": c.get("response_tokens", 0),
                "total_tokens": c.get("input_tokens", 0) + c.get("cache_read_tokens", 0) + c.get("output_tokens", 0),
                "avg_ttft_s": c.get("avg_ttft_s", 0.0),
                "stream_tps": c.get("stream_tps", 0.0),
                "e2e_tps": c.get("e2e_tps", 0.0),
                "cost_total": c.get("cost_total", 0.0),
            }
        )

    return {
        "execution_date": target_date.strftime("%Y-%m-%d %H:%M:%S"),
        "is_monday": is_monday,
        "start_date": start_str,
        "end_date": end_str,
        "period_label": period_label,
        "total": total_metrics,
        "providers": providers_out,
        "hierarchy": {
            "main": main_metrics,
            "subagent": sub_metrics,
        },
        "models": models_out,
        "daily_breakdown": daily_stat,
        "top_sessions": enriched_top,
    }


def generate_markdown_report(data: dict[str, Any]) -> str:
    """Generate clean GitHub Flavored Markdown report covering both Gemini and Claude."""
    t = data["total"]
    h = data["hierarchy"]
    provs = data["providers"]
    is_mon = data["is_monday"]
    start_d = data["start_date"]
    end_d = data["end_date"]

    lines = []
    lines.append(f"# Antigravity 全模型 Token 消耗审计报告（{data['period_label']}）\n")
    lines.append(f"- 审计执行时间：`{data['execution_date']}`")
    lines.append(
        f"- 统计周期规则：{'周一汇总（统计上周七天：' + start_d + ' 至 ' + end_d + '）' if is_mon else '常规每日统计（统计昨日：' + start_d + '）'}"
    )
    lines.append("- 审计覆盖范围：Google Gemini 全系模型 + Anthropic Claude 全系模型（含主会话与全部子代理）\n")

    lines.append("## 1. 核心指标总览\n")
    lines.append("| 指标项 | 统计数值 | 占比 / 说明 |")
    lines.append("| :--- | ---: | :--- |")
    lines.append(f"| 总消耗 Token | {format_token_dual(t['grand_total_tokens'])} | 100.0% |")
    lines.append(
        f"| 输入 Token (Input) | {format_token_dual(t['input_tokens'])} | {t['input_tokens'] / max(1, t['grand_total_tokens']) * 100:.2f}% |"
    )
    lines.append(
        f"| 缓存读取 Token (Cache Read) | {format_token_dual(t['cache_read_tokens'])} | {t['cache_read_tokens'] / max(1, t['grand_total_tokens']) * 100:.2f}% |"
    )
    lines.append(
        f"| 输出 Token (Output) | {format_token_dual(t['output_tokens'])} | {t['output_tokens'] / max(1, t['grand_total_tokens']) * 100:.2f}% |"
    )
    lines.append(
        f"| 思考推理 Token (Thinking) | {format_token_dual(t['thinking_tokens'])} | 占总输出 {t['thinking_ratio']:.2f}% |"
    )
    vis_pct = (100.0 - t["thinking_ratio"]) if t["output_tokens"] > 0 else 0.0
    lines.append(
        f"| 可见正文 Token (Response) | {format_token_dual(t['response_tokens'])} | 占总输出 {vis_pct:.2f}% |"
    )
    lines.append(f"| Prompt 缓存命中率 | {t['cache_hit_rate']:.2f}% | 缓存命中降低重复上下文成本 |")
    lines.append(f"| 平均首字等待 (Avg TTFT) | {t['avg_ttft_s']:.2f} s | 含输入预填充与思考推理耗时 |")
    lines.append(f"| 流式输出速率 (Stream TPS) | {t['stream_tps']:.1f} tok/s | 首字返回后可见内容吐字速度 |")
    lines.append(f"| 端到端速率 (E2E TPS) | {t['e2e_tps']:.1f} tok/s | 总输出 Token / 单步总耗时 |")
    lines.append(f"| 上下文压缩触发次数 | {t['compact_count']} 次 | 触发即执行上下文截断压缩 |")
    lines.append(
        f"| 估算总支出 (USD) | ${t['cost_total']:.4f} | 输入 ${t['cost_input']:.2f} + 缓存 ${t['cost_cache']:.2f} + 输出 ${t['cost_output']:.2f} |"
    )
    lines.append(f"| 缓存节省费用 (USD) | ${t['cost_savings']:.2f} | 相比全量非缓存计费节省 |")
    lines.append(f"| 涉及会话总数 | {t['conv_count']} 个 | 包含主会话与子代理会话 |")
    lines.append(f"| 计费模型调用步数 | {t['token_steps']} 步 | 会话总交互步数 {t['total_steps']} 步 |\n")

    lines.append("## 2. 厂商与模型消耗明细（Gemini + Claude）\n")
    lines.append("### 2.1 厂商分类汇总\n")
    lines.append("| 模型厂商 | 涉及会话 | 计费步数 | 输入 Token | 缓存 Token | 输出 Token | 总 Token | 流式速率 | 平均 TTFT | 支出 (USD) | 支出占比 |")
    lines.append("| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    tot_cost = max(0.0001, t["cost_total"])
    for pkey in ("gemini", "claude"):
        p = provs[pkey]
        pct = (p["cost_total"] / tot_cost * 100.0) if t["cost_total"] > 0 else 0.0
        p_stps = f"{p['stream_tps']:.1f} tok/s" if p.get("stream_tps", 0.0) > 0 else "-"
        p_ttft = f"{p['avg_ttft_s']:.2f}s" if p.get("avg_ttft_s", 0.0) > 0 else "-"
        lines.append(
            f"| {p['label']} | {p['session_count']} | {p['steps']} | "
            f"{format_token_dual(p['input_tokens'])} | {format_token_dual(p['cache_read_tokens'])} | "
            f"{format_token_dual(p['output_tokens'])} | {format_token_dual(p['total_tokens'])} | "
            f"{p_stps} | {p_ttft} | ${p['cost_total']:.4f} | {pct:.1f}% |"
        )
    lines.append("")

    lines.append("### 2.2 具体模型分布\n")
    if data["models"]:
        lines.append("| 模型名称 | 厂商 | 涉及会话 | 计费步数 | 输入 Token | 缓存 Token | 输出 Token | 思考占比 | 流式速率 | 端到端速率 | 平均 TTFT | 支出 (USD) |")
        lines.append("| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
        for m_name, m_data in data["models"].items():
            prov_tag = "Claude" if m_data["provider"] == "claude" else "Gemini"
            think_pct = (m_data["thinking"] / m_data["out"] * 100.0) if m_data["out"] > 0 else 0.0
            m_stps = f"{m_data['stream_tps']:.1f} tok/s" if m_data.get("stream_tps", 0.0) > 0 else "-"
            m_etps = f"{m_data['e2e_tps']:.1f} tok/s" if m_data.get("e2e_tps", 0.0) > 0 else "-"
            m_ttft = f"{m_data['avg_ttft_s']:.2f}s" if m_data.get("avg_ttft_s", 0.0) > 0 else "-"
            lines.append(
                f"| {m_name} | {prov_tag} | {m_data['session_count']} | {m_data['steps']} | "
                f"{format_token_dual(m_data['inp'])} | {format_token_dual(m_data['cache'])} | "
                f"{format_token_dual(m_data['out'])} | {think_pct:.1f}% | {m_stps} | {m_etps} | {m_ttft} | "
                f"${m_data['cost']:.4f} |"
            )
    else:
        lines.append("- 该统计周期内无模型 Token 消耗记录。")
    lines.append("")

    lines.append("## 3. 会话层级分布（主会话 vs 子代理）\n")
    lines.append("| 会话层级 | 会话数 | 计费步数 | 输入 Token | 缓存 Token | 输出 Token | 总 Token | 流式速率 | 平均 TTFT | 支出 (USD) | 支出占比 |")
    lines.append("| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")

    m = h["main"]
    s = h["subagent"]
    m_pct = (m["cost_total"] / tot_cost * 100.0) if t["cost_total"] > 0 else 0.0
    s_pct = (s["cost_total"] / tot_cost * 100.0) if t["cost_total"] > 0 else 0.0
    m_stps = f"{m['stream_tps']:.1f} tok/s" if m.get("stream_tps", 0.0) > 0 else "-"
    m_ttft = f"{m['avg_ttft_s']:.2f}s" if m.get("avg_ttft_s", 0.0) > 0 else "-"
    s_stps = f"{s['stream_tps']:.1f} tok/s" if s.get("stream_tps", 0.0) > 0 else "-"
    s_ttft = f"{s['avg_ttft_s']:.2f}s" if s.get("avg_ttft_s", 0.0) > 0 else "-"
    t_stps = f"{t['stream_tps']:.1f} tok/s" if t.get("stream_tps", 0.0) > 0 else "-"
    t_ttft = f"{t['avg_ttft_s']:.2f}s" if t.get("avg_ttft_s", 0.0) > 0 else "-"
    lines.append(
        f"| 主会话 (Main Agents) | {m['session_count']} | {m['step_count']} | "
        f"{format_token_dual(m['input_tokens'])} | {format_token_dual(m['cache_read_tokens'])} | "
        f"{format_token_dual(m['output_tokens'])} | {format_token_dual(m['total_tokens'])} | "
        f"{m_stps} | {m_ttft} | ${m['cost_total']:.4f} | {m_pct:.1f}% |"
    )
    lines.append(
        f"| 子代理 (Subagents) | {s['session_count']} | {s['step_count']} | "
        f"{format_token_dual(s['input_tokens'])} | {format_token_dual(s['cache_read_tokens'])} | "
        f"{format_token_dual(s['output_tokens'])} | {format_token_dual(s['total_tokens'])} | "
        f"{s_stps} | {s_ttft} | ${s['cost_total']:.4f} | {s_pct:.1f}% |"
    )
    lines.append(
        f"| **合计** | **{m['session_count'] + s['session_count']}** | **{m['step_count'] + s['step_count']}** | "
        f"**{format_token_dual(t['input_tokens'])}** | **{format_token_dual(t['cache_read_tokens'])}** | "
        f"**{format_token_dual(t['output_tokens'])}** | **{format_token_dual(t['grand_total_tokens'])}** | "
        f"**{t_stps}** | **{t_ttft}** | **${t['cost_total']:.4f}** | **{'100.0%' if t['cost_total'] > 0 else '0.0%'}** |\n"
    )

    lines.append("## 4. 上下文压缩指标\n")
    lines.append(f"- 压缩触发次数：`{t['compact_count']}` 次")
    if t["compact_count"] > 0:
        lines.append(f"- 触发压缩瞬间平均上下文大小：`{format_token_dual(t['avg_ctx_at_compact'])}` tokens")
        lines.append(f"- 连续压缩事件间平均累积流转 Token：`{format_token_dual(t['avg_tokens_between_compact'])}` tokens")
        lines.append(f"- 连续压缩事件间平均交互步数：`{t['avg_steps_between_compact']:.1f}` 步")
    else:
        lines.append("- 该统计周期内无上下文压缩截断事件发生。")
    lines.append("")

    if is_mon or len(data["daily_breakdown"]) > 1:
        lines.append("## 5. 每日消耗趋势\n")
        lines.append("| 日期 | 会话数 | 计费步数 | 输入 Token | 缓存 Token | 缓存命中率 | 输出 Token | 流式速率 | 平均 TTFT | 支出 (USD) | 压缩次数 |")
        lines.append("| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
        for date_key in sorted(data["daily_breakdown"].keys()):
            d_m = data["daily_breakdown"][date_key]
            d_stps = f"{d_m['stream_tps']:.1f} tok/s" if d_m.get("stream_tps", 0.0) > 0 else "-"
            d_ttft = f"{d_m['avg_ttft_s']:.2f}s" if d_m.get("avg_ttft_s", 0.0) > 0 else "-"
            lines.append(
                f"| {date_key} | {d_m['conv_count']} | {d_m['token_steps']} | "
                f"{format_token_dual(d_m['input_tokens'])} | {format_token_dual(d_m['cache_read_tokens'])} | "
                f"{d_m['cache_hit_rate']:.1f}% | {format_token_dual(d_m['output_tokens'])} | "
                f"{d_stps} | {d_ttft} | ${d_m['cost_total']:.4f} | "
                f"{d_m['compact_count']} |"
            )
        lines.append("")

    top_header = "## 6. 消耗最高会话 Top 10" if (is_mon or len(data["daily_breakdown"]) > 1) else "## 5. 消耗最高会话 Top 10"
    lines.append(f"{top_header}\n")
    if data["top_sessions"]:
        lines.append("| 会话 ID | 会话标题 | 类型 | 调用模型 | 计费步数 | 总 Token | 流式速率 | 平均 TTFT | 支出 (USD) |")
        lines.append("| :--- | :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: |")
        for s_info in data["top_sessions"]:
            stype = "子代理" if s_info["is_subagent"] else "主会话"
            safe_title = s_info["title"].replace("|", "/")
            m_str = ", ".join(s_info["models"]) if s_info["models"] else "-"
            s_stps = f"{s_info['stream_tps']:.1f} tok/s" if s_info.get("stream_tps", 0.0) > 0 else "-"
            s_ttft = f"{s_info['avg_ttft_s']:.2f}s" if s_info.get("avg_ttft_s", 0.0) > 0 else "-"
            lines.append(
                f"| `{s_info['conv_id'][:8]}` | {safe_title} | {stype} | {m_str} | {s_info['step_count']} | "
                f"{format_token_dual(s_info['total_tokens'])} | {s_stps} | {s_ttft} | ${s_info['cost_total']:.4f} |"
            )
    else:
        lines.append("- 该统计周期内无会话记录。")
    lines.append("")

    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Antigravity Daily & Weekly Token Consumption Reporter (Gemini & Claude)"
    )
    parser.add_argument(
        "--date",
        help="Specify target evaluation date YYYY-MM-DD (default: current date). If date is Monday, aggregates past 7 days; otherwise yesterday.",
    )
    parser.add_argument(
        "--base-dir",
        default=DEFAULT_BASE_DIR,
        help=f"Antigravity base directory (default: {DEFAULT_BASE_DIR})",
    )
    parser.add_argument(
        "--top",
        type=int,
        default=10,
        help="Number of top sessions to display (default: 10)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output raw JSON format instead of Markdown report",
    )

    args = parser.parse_args()

    target_dt = None
    if args.date:
        try:
            target_dt = datetime.strptime(args.date, "%Y-%m-%d").replace(tzinfo=DEFAULT_TZ)
        except ValueError:
            print(f"Error: Invalid date format '{args.date}'. Expected YYYY-MM-DD.", file=sys.stderr)
            sys.exit(1)

    data = analyze_daily_tokens(
        target_date=target_dt,
        base_dir=args.base_dir,
        top_n=args.top,
    )

    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print(generate_markdown_report(data))


if __name__ == "__main__":
    main()
