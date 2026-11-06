#!/usr/bin/env python3
"""
Antigravity Token & Cost Analysis CLI
Analyzes token usage, cache savings, and multi-model expenses for Google Gemini models.
Zero-dependency using Python standard library.
"""

from __future__ import annotations

import argparse
import json
import os
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

from formatter import (
    format_table,
    format_token_dual,
    format_token_unit,
)
from pricing import (
    DEFAULT_MODEL_KEY,
    FALLBACK_GEMINI_PRICING,
    fetch_online_gemini_pricing,
    get_model_display_name,
    load_pricing,
    map_model_name_to_key,
    save_pricing_cache,
)
from transcript import (
    DEFAULT_TZ,
    TranscriptScanner,
    compute_speed_metrics,
)


def aggregate_metrics(steps: list[dict[str, Any]], convs: list[dict[str, Any]]) -> dict[str, Any]:
    """Aggregate token totals, cache hit rate, speed/latency, and expenses for a group of steps and sessions."""
    pricing = load_pricing()
    token_steps = [s for s in steps if s["has_tokens"]]
    inp = sum(s["input_tokens"] for s in token_steps)
    cache = sum(s["cache_read_tokens"] for s in token_steps)
    out = sum(s["output_tokens"] for s in token_steps)
    thinking_tok = sum(s.get("thinking_tokens", 0) for s in token_steps)
    response_tok = sum(s.get("response_tokens", 0) for s in token_steps)
    thinking_ratio = (thinking_tok / out * 100.0) if out > 0 else 0.0
    tot_in = inp + cache
    grand_tot = tot_in + out
    hit_rate = (cache / tot_in * 100.0) if tot_in > 0 else 0.0
    speed = compute_speed_metrics(token_steps)

    cin = sum(s["cost_input"] for s in token_steps)
    cca = sum(s["cost_cache"] for s in token_steps)
    cout = sum(s["cost_output"] for s in token_steps)
    ctot = cin + cca + cout

    cost_no_cache = sum(
        ((s["input_tokens"] + s["cache_read_tokens"]) / 1_000_000)
        * pricing.get(map_model_name_to_key(s["model"]), FALLBACK_GEMINI_PRICING[DEFAULT_MODEL_KEY])["input"]
        + s["cost_output"]
        for s in token_steps
    )
    savings = cost_no_cache - ctot

    all_compacts = [ce for c in convs for ce in c["compact_events"]]
    avg_tokens_between_compact = (
        (sum(ce["tokens_since_last"] for ce in all_compacts) / len(all_compacts)) if all_compacts else 0.0
    )
    avg_steps_between_compact = (
        (sum(ce["steps_since_last"] for ce in all_compacts) / len(all_compacts)) if all_compacts else 0.0
    )
    avg_ctx_at_compact = (
        (sum(ce["context_size_at_checkpoint"] for ce in all_compacts) / len(all_compacts))
        if all_compacts
        else 0.0
    )

    return {
        "conv_count": len(convs),
        "total_steps": len(steps),
        "token_steps": len(token_steps),
        "input_tokens": inp,
        "cache_read_tokens": cache,
        "total_input_tokens": tot_in,
        "cache_hit_rate": hit_rate,
        "output_tokens": out,
        "thinking_tokens": thinking_tok,
        "response_tokens": response_tok,
        "thinking_ratio": thinking_ratio,
        "grand_total_tokens": grand_tot,
        "timed_steps": speed["timed_steps"],
        "avg_ttft_s": speed["avg_ttft_s"],
        "stream_tps": speed["stream_tps"],
        "e2e_tps": speed["e2e_tps"],
        "cost_input": cin,
        "cost_cache": cca,
        "cost_output": cout,
        "cost_total": ctot,
        "cost_savings": savings,
        "compact_count": len(all_compacts),
        "avg_tokens_between_compact": avg_tokens_between_compact,
        "avg_steps_between_compact": avg_steps_between_compact,
        "avg_ctx_at_compact": avg_ctx_at_compact,
    }


def run_analysis(
    group_by: str = "date",
    period: str = "all-time",
    start: str | None = None,
    end: str | None = None,
    top_n: int = 10,
    base_dir: str | None = None,
) -> dict[str, Any]:
    """Execute complete token analysis across selected timeframe."""
    now = datetime.now(DEFAULT_TZ)
    if start and end:
        start_dt = datetime.strptime(start, "%Y-%m-%d").replace(tzinfo=DEFAULT_TZ)
        end_dt = datetime.strptime(end, "%Y-%m-%d").replace(
            hour=23, minute=59, second=59, microsecond=999999, tzinfo=DEFAULT_TZ
        )
        period_label = f"Custom Range ({start} to {end})"
    elif period == "today":
        start_dt = now.replace(hour=0, minute=0, second=0, microsecond=0)
        end_dt = now
        period_label = "Today"
    elif period == "this-week":
        start_dt = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
        end_dt = now
        period_label = "This Week (from Monday)"
    elif period == "this-month":
        start_dt = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        end_dt = now
        period_label = "This Month"
    else:
        start_dt = None
        end_dt = None
        period_label = "All Time"

    scanner = TranscriptScanner(base_dirs=base_dir)
    convs, steps = scanner.scan(start_dt, end_dt)

    total_metrics = aggregate_metrics(steps, convs)

    # 1. Models breakdown
    models_stat: dict[str, dict[str, Any]] = defaultdict(
        lambda: {
            "steps": 0,
            "inp": 0,
            "cache": 0,
            "out": 0,
            "thinking": 0,
            "response": 0,
            "cost": 0.0,
            "convs": set(),
            "_step_list": [],
        }
    )
    for s in steps:
        if s["has_tokens"]:
            m_disp = get_model_display_name(s["model"])
            models_stat[m_disp]["steps"] += 1
            models_stat[m_disp]["inp"] += s["input_tokens"]
            models_stat[m_disp]["cache"] += s["cache_read_tokens"]
            models_stat[m_disp]["out"] += s["output_tokens"]
            models_stat[m_disp]["thinking"] += s.get("thinking_tokens", 0)
            models_stat[m_disp]["response"] += s.get("response_tokens", 0)
            models_stat[m_disp]["cost"] += s["cost_total"]
            models_stat[m_disp]["convs"].add(s["conv_id"])
            models_stat[m_disp]["_step_list"].append(s)

    for m_disp, mdata in models_stat.items():
        m_speed = compute_speed_metrics(mdata.pop("_step_list"))
        mdata["avg_ttft_s"] = m_speed["avg_ttft_s"]
        mdata["stream_tps"] = m_speed["stream_tps"]
        mdata["e2e_tps"] = m_speed["e2e_tps"]

    # 2. Time breakdown
    time_groups: dict[str, dict[str, Any]] = defaultdict(lambda: {"steps": [], "convs": set()})
    for s in steps:
        if not s["dt"]:
            continue
        if group_by == "month":
            tkey = s["dt"].strftime("%Y-%m")
        elif group_by == "week":
            tkey = s["dt"].strftime("%Y-W%W")
        elif group_by == "date":
            tkey = s["dt"].strftime("%Y-%m-%d")
        else:
            tkey = "All Periods"

        time_groups[tkey]["steps"].append(s)
        time_groups[tkey]["convs"].add(s["conv_id"])

    conv_map = {c["conv_id"]: c for c in convs}
    time_stat = {}
    for tkey, d in time_groups.items():
        c_list = []
        for cid in d["convs"]:
            if cid in conv_map:
                c_item = dict(conv_map[cid])
                c_item["compact_events"] = [
                    ce
                    for ce in conv_map[cid]["compact_events"]
                    if ce.get("dt")
                    and (
                        (group_by == "month" and ce["dt"].strftime("%Y-%m") == tkey)
                        or (group_by == "week" and ce["dt"].strftime("%Y-W%W") == tkey)
                        or (group_by == "date" and ce["dt"].strftime("%Y-%m-%d") == tkey)
                        or (group_by not in ("month", "week", "date"))
                    )
                ]
                c_list.append(c_item)
        time_stat[tkey] = aggregate_metrics(d["steps"], c_list)

    # Top conversations by cost
    top_convs = sorted(convs, key=lambda x: -x["cost_total"])[:top_n]

    return {
        "period_label": period_label,
        "group_by": group_by,
        "total": total_metrics,
        "models": dict(models_stat),
        "time_breakdown": time_stat,
        "top_conversations": top_convs,
    }


def run_session_analysis(
    session_id: str,
    base_dir: str | None = None,
) -> dict[str, Any]:
    """Audit a specific conversation session and all its derived subagents recursively."""
    scanner = TranscriptScanner(base_dirs=base_dir)
    convs, steps = scanner.scan()

    # Match target session by prefix or exact ID
    target_id = None
    target_conv = None
    for c in convs:
        if c["conv_id"] == session_id or c["conv_id"].startswith(session_id):
            target_id = c["conv_id"]
            target_conv = c
            break

    if not target_conv or not target_id:
        return {"error": f"Session with ID '{session_id}' not found."}

    # Find all subagents whose parent_id is target_id
    subagent_convs = [c for c in convs if c.get("parent_id") == target_id]
    all_related_ids = set([target_id] + [c["conv_id"] for c in subagent_convs])
    related_steps = [s for s in steps if s["conv_id"] in all_related_ids]

    combined_metrics = aggregate_metrics(related_steps, [target_conv] + subagent_convs)

    return {
        "target_session": target_conv,
        "subagents": subagent_convs,
        "all_sessions": [target_conv] + subagent_convs,
        "combined_metrics": combined_metrics,
        "steps": related_steps,
    }


def print_session_report(res: dict[str, Any]) -> None:
    """Print readable report for a specific session and its subagents."""
    if "error" in res:
        print(f"Error: {res['error']}")
        return

    tgt = res["target_session"]
    subs = res["subagents"]
    comb = res["combined_metrics"]

    line_sep = "=" * 86
    print(line_sep)
    print(f"Antigravity Session Audit Report: {tgt['title']} [{tgt['conv_id'][:8]}...]")
    print(line_sep)

    print("\n[1. Grand Combined Total (Parent + Subagents)]")
    print(f"  - Total Sessions Involved: {len(subs) + 1} (1 Parent Main + {len(subs)} Subagents)")
    print(f"  - Total Interactive Steps: {comb['total_steps']:,} (with tokens: {comb['token_steps']:,})")
    print(f"  - Grand Total Tokens:     {format_token_dual(comb['grand_total_tokens'])} tokens")
    print(f"    * Input Tokens:         {format_token_dual(comb['input_tokens'])}")
    print(f"    * Cache Read Tokens:    {format_token_dual(comb['cache_read_tokens'])} (Cache Hit: {comb['cache_hit_rate']:.2f}%)")
    print(f"    * Output Tokens:        {format_token_dual(comb['output_tokens'])}")
    print(
        f"      - Thinking / Visible: {format_token_dual(comb['thinking_tokens'])} ({comb['thinking_ratio']:.1f}% CoT) / {format_token_dual(comb['response_tokens'])}"
    )
    print(
        f"  - Output Speed & Latency: Stream {comb['stream_tps']:.1f} tok/s | E2E {comb['e2e_tps']:.1f} tok/s | Avg TTFT {comb['avg_ttft_s']:.2f}s"
    )
    print(f"  - Combined Estimated Cost: ${comb['cost_total']:.4f} USD")
    print(f"  - Compactions Triggered:   {comb['compact_count']}")

    print("\n" + line_sep)
    print("[2. Session Hierarchy Breakdown]")
    rows = []
    # Parent Main row
    rows.append(
        [
            f"{tgt['conv_id'][:8]} (Main)",
            "Parent Main Agent",
            f"{tgt['step_count']:,}",
            format_token_dual(tgt["input_tokens"]),
            format_token_dual(tgt["cache_read_tokens"]),
            format_token_dual(tgt["output_tokens"]),
            f"{tgt.get('stream_tps', 0.0):.1f} tok/s" if tgt.get("stream_tps", 0.0) > 0 else "-",
            f"{tgt.get('avg_ttft_s', 0.0):.2f}s" if tgt.get("avg_ttft_s", 0.0) > 0 else "-",
            f"${tgt['cost_total']:.4f}",
        ]
    )
    # Subagents rows
    for s in subs:
        role_label = s.get("agent_name") or "Subagent"
        rows.append(
            [
                f"{s['conv_id'][:8]} (Sub)",
                role_label,
                f"{s['step_count']:,}",
                format_token_dual(s["input_tokens"]),
                format_token_dual(s["cache_read_tokens"]),
                format_token_dual(s["output_tokens"]),
                f"{s.get('stream_tps', 0.0):.1f} tok/s" if s.get("stream_tps", 0.0) > 0 else "-",
                f"{s.get('avg_ttft_s', 0.0):.2f}s" if s.get("avg_ttft_s", 0.0) > 0 else "-",
                f"${s['cost_total']:.4f}",
            ]
        )
    # Total row
    rows.append(
        [
            "COMBINED TOTAL",
            f"All {len(subs) + 1} Agents",
            f"{comb['total_steps']:,}",
            format_token_dual(comb["input_tokens"]),
            format_token_dual(comb["cache_read_tokens"]),
            format_token_dual(comb["output_tokens"]),
            f"{comb['stream_tps']:.1f} tok/s" if comb["stream_tps"] > 0 else "-",
            f"{comb['avg_ttft_s']:.2f}s" if comb["avg_ttft_s"] > 0 else "-",
            f"${comb['cost_total']:.4f}",
        ]
    )
    headers = [
        "Session ID",
        "Agent Role",
        "Steps",
        "Input Tokens",
        "Cache Tokens",
        "Output Tokens",
        "Stream TPS",
        "Avg TTFT",
        "Cost (USD)",
    ]
    print(format_table(headers, rows))
    print(line_sep + "\n")


def print_report(res: dict[str, Any]) -> None:
    """Print readable analysis report to terminal."""
    t = res["total"]
    line_sep = "=" * 86
    print(line_sep)
    print(f"Antigravity Token & Cost Overview Report [Period: {res['period_label']}]")
    print(line_sep)

    print("\n[1. Overview Metrics]")
    print(f"  - Total Sessions:        {t['conv_count']:,} (active, deleted/killed, and subagent sessions)")
    print(f"  - Steps with Tokens:     {t['token_steps']:,} (total interactive steps: {t['total_steps']:,})")
    print(f"  - Total Tokens Consumed: {format_token_dual(t['grand_total_tokens'])} tokens")
    print(
        f"    * Input Tokens:        {format_token_dual(t['input_tokens'])} ({t['input_tokens'] / max(1, t['grand_total_tokens']) * 100:.1f}%)"
    )
    print(
        f"    * Cache Read Tokens:   {format_token_dual(t['cache_read_tokens'])} ({t['cache_read_tokens'] / max(1, t['grand_total_tokens']) * 100:.1f}%)"
    )
    print(
        f"    * Output Tokens:       {format_token_dual(t['output_tokens'])} ({t['output_tokens'] / max(1, t['grand_total_tokens']) * 100:.1f}%)"
    )
    print(
        f"      - Thinking / Visible: {format_token_dual(t['thinking_tokens'])} ({t['thinking_ratio']:.1f}% CoT) / {format_token_dual(t['response_tokens'])}"
    )
    print(f"  - Prompt Cache Hit Rate: {t['cache_hit_rate']:.2f}% (proportion of cached prompt tokens)")
    print(
        f"  - Output Speed & Latency: Stream {t['stream_tps']:.1f} tok/s | E2E {t['e2e_tps']:.1f} tok/s | Avg TTFT {t['avg_ttft_s']:.2f}s"
    )
    print(f"  - Estimated Total Cost:  ${t['cost_total']:.2f} USD")
    print(f"    * Input cost:          ${t['cost_input']:.2f}")
    print(f"    * Cache read cost:     ${t['cost_cache']:.2f}")
    print(f"    * Output cost:         ${t['cost_output']:.2f}")
    print(f"    * Cache savings:       ${t['cost_savings']:.2f} USD (compared to non-cached)")

    print("\n" + line_sep)
    print("[2. Context Compaction & Checkpoint Metrics]")
    print(f"  - Total Compactions Triggered: {t['compact_count']:,}")
    if t["compact_count"] > 0:
        print(f"  - Avg cumulative flow:         {format_token_dual(t['avg_tokens_between_compact'])} tokens (multi-turn accumulation)")
        print(f"  - Avg steps between events:    {t['avg_steps_between_compact']:.1f} interactive steps")
        print(f"  - Context window at trigger:   {format_token_dual(t['avg_ctx_at_compact'])} tokens (instant size triggering truncation)")
    else:
        print("  - No compaction events observed in selected timeframe.")

    print("\n" + line_sep)
    print("[3. Model Breakdown]")
    m_rows = []
    for m_name, d in sorted(res["models"].items(), key=lambda x: -x[1]["cost"]):
        tot_tok = d["inp"] + d["cache"] + d["out"]
        m_rows.append(
            [
                m_name,
                f"{len(d['convs']):,}",
                f"{d['steps']:,}",
                format_token_dual(d['inp']),
                format_token_dual(d['cache']),
                format_token_dual(d['out']),
                format_token_dual(tot_tok),
                f"{d.get('stream_tps', 0.0):.1f} tok/s" if d.get("stream_tps", 0.0) > 0 else "-",
                f"{d.get('e2e_tps', 0.0):.1f} tok/s" if d.get("e2e_tps", 0.0) > 0 else "-",
                f"{d.get('avg_ttft_s', 0.0):.2f}s" if d.get("avg_ttft_s", 0.0) > 0 else "-",
                f"${d['cost']:.2f}",
            ]
        )
    headers = [
        "Model",
        "Sessions",
        "Steps",
        "Input Tokens",
        "Cache Tokens",
        "Output Tokens",
        "Total Tokens",
        "Stream TPS",
        "E2E TPS",
        "Avg TTFT",
        "Cost (USD)",
    ]
    print(format_table(headers, m_rows))

    tb = res["time_breakdown"]
    if len(tb) > 1 or res["group_by"] in ("month", "week", "date"):
        time_label_map = {
            "month": "Monthly",
            "week": "Weekly",
            "date": "Daily",
            "all": "All Time",
        }
        print("\n" + line_sep)
        print(f"[4. Time Series Trend: {time_label_map.get(res['group_by'], 'Timeline')}]")
        time_rows = []
        for tkey in sorted(tb.keys()):
            d = tb[tkey]
            time_rows.append(
                [
                    tkey,
                    f"{d['conv_count']:,}",
                    f"{d['token_steps']:,}",
                    format_token_dual(d['input_tokens']),
                    format_token_dual(d['cache_read_tokens']),
                    f"{d['cache_hit_rate']:.1f}%",
                    format_token_dual(d['output_tokens']),
                    format_token_dual(d['grand_total_tokens']),
                    f"${d['cost_total']:.2f}",
                    f"{d['compact_count']:,}",
                ]
            )
        headers = [
            "Time Window",
            "Sessions",
            "Steps",
            "Input Tokens",
            "Cache Tokens",
            "Cache Hit",
            "Output Tokens",
            "Total Tokens",
            "Cost (USD)",
            "Compactions",
        ]
        print(format_table(headers, time_rows))

    print("\n" + line_sep)
    print("[5. Top 10 Sessions by Cost]")
    top_rows = []
    for c in res["top_conversations"][:10]:
        title_snippet = (c["title"][:26] + "..") if len(c["title"]) > 26 else c["title"]
        st_desc = "Deleted" if (c["killed"] or not c["in_db"]) else "Active"
        top_rows.append(
            [
                c["conv_id"][:8],
                title_snippet,
                st_desc,
                f"{c['step_count']:,}",
                format_token_dual(c['input_tokens']),
                format_token_dual(c['cache_read_tokens']),
                format_token_dual(c['output_tokens']),
                f"{c.get('stream_tps', 0.0):.1f} tok/s" if c.get("stream_tps", 0.0) > 0 else "-",
                f"{c.get('avg_ttft_s', 0.0):.2f}s" if c.get("avg_ttft_s", 0.0) > 0 else "-",
                f"${c['cost_total']:.2f}",
            ]
        )
    headers = [
        "Session ID",
        "Title",
        "Status",
        "Steps",
        "Input Tokens",
        "Cache Tokens",
        "Output Tokens",
        "Stream TPS",
        "Avg TTFT",
        "Cost (USD)",
    ]
    print(format_table(headers, top_rows))
    print(line_sep + "\n")


def main() -> None:
    """CLI entry point for token and cost analysis."""
    parser = argparse.ArgumentParser(description="Antigravity Token & Cost Analysis CLI")
    parser.add_argument(
        "--period",
        choices=["all-time", "this-month", "this-week", "today"],
        default="all-time",
        help="Timeframe filter: all-time, this-month, this-week, today (default: all-time)",
    )
    parser.add_argument(
        "--group-by",
        choices=["all", "month", "week", "date"],
        default="date",
        help="Aggregation grouping dimension: all, month, week, date (default: date)",
    )
    parser.add_argument("--start", help="Custom start date YYYY-MM-DD")
    parser.add_argument("--end", help="Custom end date YYYY-MM-DD")
    parser.add_argument("--session", help="Audit a specific session ID and its derived subagents")
    parser.add_argument("--top", type=int, default=10, help="Top N sessions by cost (default: 10)")
    parser.add_argument("--base-dir", help="Antigravity base data directory (default: ~/.gemini/antigravity)")
    parser.add_argument("--sync-pricing", action="store_true", help="Attempt to synchronize latest official Google Gemini pricing online")
    parser.add_argument("--json", action="store_true", help="Output full JSON report")

    args = parser.parse_args()

    if args.sync_pricing:
        print("Attempting to synchronize latest pricing from official Google Gemini sources...")
        online_data = fetch_online_gemini_pricing()
        if online_data:
            save_pricing_cache(online_data)
            print("Pricing synchronized successfully and cached locally.")
        else:
            print("Unable to reach online pricing service; fallback rates will be used.")

    if args.session:
        res = run_session_analysis(session_id=args.session, base_dir=args.base_dir)
        if args.json:
            def serialize_default(obj: Any) -> Any:
                if isinstance(obj, set):
                    return list(obj)
                return str(obj)

            print(json.dumps(res, indent=2, default=serialize_default, ensure_ascii=False))
        else:
            print_session_report(res)
        return

    res = run_analysis(
        group_by=args.group_by,
        period=args.period,
        start=args.start,
        end=args.end,
        top_n=args.top,
        base_dir=args.base_dir,
    )

    if args.json:

        def serialize_default(obj: Any) -> Any:
            if isinstance(obj, set):
                return list(obj)
            return str(obj)

        print(json.dumps(res, indent=2, default=serialize_default, ensure_ascii=False))
    else:
        print_report(res)


if __name__ == "__main__":
    main()
