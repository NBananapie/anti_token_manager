#!/usr/bin/env python3
"""
Antigravity Context Compact Threshold & Interval Analyzer CLI
Analyzes:
  - Phase 1: Context size threshold and cumulative tokens before the 1st compact event
  - Phase 2: Context size threshold and cumulative tokens between subsequent compact events
  - Context reduction percentage after compaction
  - Model-specific threshold breakdown for Gemini models
Zero-dependency using Python standard library.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

# Ensure script directory is available in sys.path
_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from pricing import get_model_display_name
from transcript import DEFAULT_BASE_DIR, extract_model_change, load_conversation_db_step_info


def analyze_compact_thresholds(base_dir: str | None = None) -> dict[str, dict[str, list[Any]]]:
    """Analyze context compaction thresholds and reduction metrics across all sessions in a single streaming pass."""
    bdir = base_dir or DEFAULT_BASE_DIR
    brain_dir = os.path.join(bdir, "brain")
    if not os.path.exists(brain_dir):
        return {}

    stats: dict[str, dict[str, list[Any]]] = defaultdict(
        lambda: {
            "first_ctx": [],
            "first_steps": [],
            "first_cum_tokens": [],
            "sub_ctx": [],
            "sub_steps": [],
            "sub_cum_tokens": [],
            "after_ctx": [],
            "reduction_pct": [],
        }
    )

    db_cache: dict[str, dict[int, tuple[int, int, int, str | None]]] = {}

    for entry in os.listdir(brain_dir):
        tf = os.path.join(brain_dir, entry, ".system_generated", "logs", "transcript.jsonl")
        if not os.path.exists(tf):
            continue

        db_step_info = db_cache.get(entry)
        if db_step_info is None:
            db_step_info = load_conversation_db_step_info(entry, bdir)
            db_cache[entry] = db_step_info

        current_model = "Gemini 3.8 Flash (High)"
        for _, (_, _, _, db_m) in sorted(db_step_info.items()):
            if db_m:
                current_model = db_m
                break

        cum_tokens = 0
        step_count = 0
        cp_count = 0
        last_planner_ctx = 0
        pending_compact: tuple[str, int] | None = None

        with open(tf, "r", encoding="utf-8", errors="ignore") as fp:
            for line in fp:
                line = line.strip()
                if not line:
                    continue
                try:
                    s = json.loads(line)
                except Exception:
                    continue

                st_type = s.get("type", "UNKNOWN")
                content = s.get("content", "")

                if st_type == "USER_INPUT":
                    changed_model = extract_model_change(content)
                    if changed_model:
                        current_model = changed_model

                st_index = s.get("step_index", 0)
                inp = int(s.get("input_tokens", 0) or 0)
                cache = int(s.get("cache_read_tokens", 0) or 0)
                out = int(s.get("output_tokens", 0) or 0)
                has_tokens = "input_tokens" in s or "cache_read_tokens" in s or "output_tokens" in s

                if st_index in db_step_info:
                    db_inp, db_cache_tok, db_out, db_model = db_step_info[st_index]
                    if db_model:
                        current_model = db_model
                    if not has_tokens and st_type == "PLANNER_RESPONSE" and (db_inp or db_cache_tok or db_out):
                        inp, cache, out = db_inp, db_cache_tok, db_out
                        has_tokens = True

                curr_ctx = inp + cache

                step_count += 1
                cum_tokens += (inp + cache + out)

                if st_type == "PLANNER_RESPONSE" and has_tokens:
                    last_planner_ctx = curr_ctx
                    if pending_compact is not None:
                        p_model, b_ctx = pending_compact
                        if b_ctx > 0 and curr_ctx > 0:
                            stats[p_model]["after_ctx"].append(curr_ctx)
                            stats[p_model]["reduction_pct"].append((1.0 - curr_ctx / b_ctx) * 100.0)
                        pending_compact = None

                elif st_type == "CHECKPOINT":
                    cp_count += 1
                    b_ctx = last_planner_ctx
                    m_key = get_model_display_name(current_model)
                    d = stats[m_key]

                    if b_ctx > 0:
                        if cp_count == 1:
                            d["first_ctx"].append(b_ctx)
                            d["first_steps"].append(step_count)
                            d["first_cum_tokens"].append(cum_tokens)
                        else:
                            d["sub_ctx"].append(b_ctx)
                            d["sub_steps"].append(step_count)
                            d["sub_cum_tokens"].append(cum_tokens)

                        pending_compact = (m_key, b_ctx)

                    cum_tokens = 0
                    step_count = 0

    return stats


def print_report(stats: dict[str, dict[str, list[Any]]]) -> None:
    """Print readable compaction metrics and engineering rules."""
    if not stats:
        print("No sessions with CHECKPOINT (compaction) events detected.")
        return

    line_sep = "=" * 86
    print(line_sep)
    print("Antigravity Session Context Compaction (CHECKPOINT) Threshold Analysis")
    print(line_sep)

    for m, d in stats.items():
        print(f"\n[Model: {m}]")
        for stage, ctx_k, stp_k, cum_k in [
            ("Phase 1 (Initial turn to first compaction)", "first_ctx", "first_steps", "first_cum_tokens"),
            ("Phase 2 (Between subsequent compactions)", "sub_ctx", "sub_steps", "sub_cum_tokens"),
        ]:
            ctx = d[ctx_k]
            stp = d[stp_k]
            cum = d[cum_k]
            if ctx:
                print(f"  - {stage} [Sample Count: {len(ctx)}]")
                print(
                    f"    * Instant Context Window at Trigger: Mean: {sum(ctx)/len(ctx):,.0f} tokens | Median: {sorted(ctx)[len(ctx)//2]:,} tokens | Range: [{min(ctx):,}, {max(ctx):,}]"
                )
                print(
                    f"    * Interaction Steps (Step Count):    Mean: {sum(stp)/len(stp):.1f} steps | Median: {sorted(stp)[len(stp)//2]} steps | Range: [{min(stp)}, {max(stp)}]"
                )
                print(
                    f"    * Cumulative Flow Between Events:    Mean: {sum(cum)/len(cum):,.0f} tokens | Median: {sorted(cum)[len(cum)//2]:,} tokens | Range: [{min(cum):,}, {max(cum):,}]"
                )
            else:
                print(f"  - {stage}: No samples available.")

        red = d["reduction_pct"]
        if red:
            after_ctx = d["after_ctx"]
            print(f"  - Post-Compaction Reduction [Valid Samples: {len(red)}]")
            print(
                f"    * Post-compaction context reduced to: Mean: {sum(after_ctx)/len(after_ctx):,.0f} tokens | Median: {sorted(after_ctx)[len(after_ctx)//2]:,} tokens"
            )
            print(
                f"    * Context reduction percentage:       Median reduction: {sorted(red)[len(red)//2]:.1f}% (Mean reduction: {sum(red)/len(red):.1f}%)"
            )

    print("\n" + line_sep)
    print("[Engineering Insights & Threshold Rules]")
    print("1. Compaction triggers immediately after instant context window (input_tokens + cache_read_tokens) crosses 100% of max_token_limit.")
    print("2. Static JSON models (Gemini 3.8 Flash M124, Argon M408, Claude 5.5 M400) and dynamic cloud models (Gemini 4 Hydrogen, Orchestrator, Carbon M427) all evaluate against max_token_limit at step completion.")
    print("3. For 1M context models (--set 1m / 840k), max_token_limit is 840,000 tokens (reserving 160K for MaxOutputTokens=65,536 and in-step tool growth).")
    print("4. Supported binary patch tiers via manage_token_limit.py: 128K, 256K, 320K, 384K, 512K, 768K, and 1M (840K safe cap).")
    print(line_sep + "\n")


def inspect_session_trajectory(conv_id: str, base_dir: str | None = None, as_json: bool = False) -> None:
    """Print step-by-step context window progression and CHECKPOINT events for a single conversation."""
    bdir = base_dir or DEFAULT_BASE_DIR
    tf = os.path.join(bdir, "brain", conv_id, ".system_generated", "logs", "transcript.jsonl")
    db_step_info = load_conversation_db_step_info(conv_id, bdir)

    step_types: dict[int, str] = {}
    if os.path.exists(tf):
        with open(tf, "r", encoding="utf-8", errors="ignore") as fp:
            for line in fp:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                    idx = obj.get("step_index")
                    if idx is not None:
                        step_types[int(idx)] = obj.get("type", "STEP")
                except Exception:
                    continue

    all_indices = sorted(set(db_step_info.keys()) | {k for k, v in step_types.items() if v == "CHECKPOINT"})
    rows: list[dict[str, Any]] = []
    for idx in all_indices:
        inp, cache, out, model = db_step_info.get(idx, (0, 0, 0, None))
        ctx = inp + cache
        stype = step_types.get(idx, "PLANNER_RESPONSE")
        if ctx > 0 or stype == "CHECKPOINT":
            rows.append(
                {
                    "step_index": idx,
                    "type": stype,
                    "ctx_tokens": ctx,
                    "input_tokens": inp,
                    "cache_read_tokens": cache,
                    "output_tokens": out,
                    "model": model,
                }
            )

    if as_json:
        print(json.dumps({"conversation_id": conv_id, "steps": rows}, indent=2, ensure_ascii=False))
        return

    print(f"Conversation: {conv_id}")
    for r in rows:
        print(
            f"  Step {r['step_index']:3d} | {r['type']:16s} | "
            f"ctx={r['ctx_tokens']:7,d} (inp={r['input_tokens']:7,d}, cache={r['cache_read_tokens']:7,d}, out={r['output_tokens']:5,d}) | "
            f"model={r['model']}"
        )


def main() -> None:
    """CLI entry point for compact threshold analyzer."""
    parser = argparse.ArgumentParser(description="Antigravity Compact Threshold Analyzer CLI")
    parser.add_argument("--base-dir", help="Antigravity base data directory (default: ~/.gemini/antigravity)")
    parser.add_argument("--session", help="Inspect step-by-step context trajectory and CHECKPOINT events for a specific conversation ID")
    parser.add_argument("--json", action="store_true", help="Output full JSON report")

    args = parser.parse_args()
    if args.session:
        inspect_session_trajectory(args.session, base_dir=args.base_dir, as_json=args.json)
        return

    stats = analyze_compact_thresholds(base_dir=args.base_dir)

    if args.json:
        out = {m: {k: list(v) for k, v in d.items()} for m, d in stats.items()}
        print(json.dumps(out, indent=2, ensure_ascii=False))
    else:
        print_report(stats)


if __name__ == "__main__":
    main()
