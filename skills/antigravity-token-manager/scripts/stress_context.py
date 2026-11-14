#!/usr/bin/env python3
"""
Antigravity Subagent Context Window Stress Test Helper CLI
Prepares deterministic read_file payloads under the 46,080-byte / 800-line tool cap,
generates subagent stress prompts, verifies empirical compaction ceilings from
transcript/SQLite ground truth, and cleans up temporary payload files.
Zero-dependency using Python standard library.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
from pathlib import Path
from typing import Any

# Ensure script directory is available in sys.path
_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from pricing import get_model_display_name
from transcript import DEFAULT_BASE_DIR, load_conversation_db_step_info

# Tier specifications: (target_tokens, default_file_count, min_pass_tokens, expected_ceiling_tokens)
TIER_SPECS: dict[str, tuple[int, int, int, int]] = {
    "128k": (128000, 14, 110000, 128000),
    "256k": (256000, 24, 230000, 256000),
    "320k": (320000, 28, 285000, 320000),
    "384k": (384000, 32, 345000, 384000),
    "512k": (512000, 42, 460000, 512000),
    "768k": (768000, 58, 690000, 768000),
    "840k": (840000, 65, 750000, 840000),
    "1m": (840000, 65, 750000, 840000),
}

_VOCAB = (
    "telemetry", "checkpoint", "scheduler", "compiler", "latency", "throughput",
    "allocator", "gradient", "pipeline", "snapshot", "protocol", "database",
    "partition", "consensus", "vectorized", "streaming", "descriptor", "threshold",
    "endpoint", "serializer", "verification", "orchestrator", "manifest", "topology",
    "heuristic", "compression", "execution", "metadata", "inference", "register",
    "alignment", "boundary", "callback", "resolver", "tokenizer", "waterfall",
    "subsystem", "analytics", "diagnostics", "middleware", "benchmark", "artifact",
    "workspace", "concurrent", "transaction", "repository", "validation", "observer",
)

_BATCH_FILE_RE = re.compile(r"^batch_\d+\.txt$")


def _default_out_dir() -> str:
    return os.path.join(os.getcwd(), ".stress_data")


def prepare_payloads(
    out_dir: str,
    target: str = "1m",
    count: int | None = None,
    lines_per_file: int = 620,
    batch_size: int = 8,
    seed: int = 20261114,
    as_json: bool = False,
) -> dict[str, Any]:
    """Generate deterministic ~43.7KB text payload files safe for single read_file calls."""
    target_key = target.lower()
    if target_key not in TIER_SPECS:
        raise ValueError(f"Unsupported target tier '{target}'. Choose from: {', '.join(TIER_SPECS)}")
    if lines_per_file < 10 or lines_per_file > 790:
        raise ValueError("lines_per_file must be between 10 and 790 (under read_file's 800-line / 46KB cap).")
    if batch_size < 1:
        raise ValueError("batch_size must be >= 1.")

    target_tokens, default_count, _, _ = TIER_SPECS[target_key]
    file_count = count if count is not None else default_count
    if file_count < 1:
        raise ValueError("count must be >= 1.")

    abs_dir = os.path.abspath(out_dir)
    os.makedirs(abs_dir, exist_ok=True)

    rng = random.Random(seed)
    total_bytes = 0
    for idx in range(1, file_count + 1):
        fpath = os.path.join(abs_dir, f"batch_{idx:02d}.txt")
        lines = [f"# Stress Test Payload File {idx:02d} (seed={seed})"]
        for line_no in range(1, lines_per_file + 1):
            words = rng.sample(_VOCAB, 5)
            val = rng.randint(1000, 999999)
            lines.append(f"[{idx:02d}:{line_no:03d}] {' '.join(words)} id={val:06d}")
        content = "\n".join(lines) + "\n"
        with open(fpath, "w", encoding="utf-8") as fp:
            fp.write(content)
        total_bytes += len(content.encode("utf-8"))

    sample_bytes = total_bytes // file_count
    # Empirical ~16K tokens per ~43.7KB file (~2.7 bytes/token for structured tokens)
    est_tokens_per_file = round(sample_bytes / 2.7)
    # Use small 1-file steps near the expected ceiling so we don't overshoot 160K reserve in 1 batch
    precision_tail = min(10, max(4, file_count // 6))
    bulk_count = max(0, file_count - precision_tail)

    if bulk_count > 0:
        schedule_step = (
            f"2. Read `batch_01.txt`..`batch_{bulk_count:02d}.txt` in sequential batches of {batch_size} files per step "
            f"(wait for the previous batch's `read_file` responses before calling the next batch).\n"
            f"3. For the remaining precision tail (`batch_{bulk_count + 1:02d}.txt`..`batch_{file_count:02d}.txt`), "
            f"read strictly ONE file per step and stop immediately if you observe a `<CONTEXT_SUMMARY>` compaction.\n"
        )
        schedule_desc = f"{bulk_count} file(s) in {batch_size}-file batches, then {precision_tail} file(s) 1-by-1"
    else:
        schedule_step = (
            f"2. Read `batch_01.txt`..`batch_{file_count:02d}.txt` strictly ONE file per step and stop immediately "
            f"if you observe a `<CONTEXT_SUMMARY>` compaction.\n"
        )
        schedule_desc = f"{file_count} file(s) 1-by-1"

    prompt = (
        f"Execute a read-only context window stress test targeting {target.upper()} ({target_tokens:,} tokens):\n\n"
        f"1. Read `batch_01.txt` through `batch_{file_count:02d}.txt` in `{abs_dir}` using `read_file`.\n"
        f"{schedule_step}"
        f"3. Do NOT modify any files or run shell commands. Keep reasoning/output minimal.\n"
        f"4. Reply concisely with: total files read, whether `<CONTEXT_SUMMARY>` compaction occurred (and after which file/batch), "
        f"and the `id=` on line 2 of `batch_01.txt`."
    ) if bulk_count == 0 else (
        f"Execute a read-only context window stress test targeting {target.upper()} ({target_tokens:,} tokens):\n\n"
        f"1. Read `batch_01.txt` through `batch_{file_count:02d}.txt` in `{abs_dir}` using `read_file`.\n"
        f"{schedule_step}"
        f"4. Do NOT modify any files or run shell commands. Keep reasoning/output minimal.\n"
        f"5. Reply concisely with: total files read, whether `<CONTEXT_SUMMARY>` compaction occurred (and after which file/batch), "
        f"and the `id=` on line 2 of `batch_01.txt`."
    )

    result = {
        "out_dir": abs_dir,
        "target": target_key,
        "target_tokens": target_tokens,
        "file_count": file_count,
        "sample_file_bytes": sample_bytes,
        "total_bytes": total_bytes,
        "estimated_tokens_per_file": est_tokens_per_file,
        "estimated_total_tokens": est_tokens_per_file * file_count,
        "bulk_count": bulk_count,
        "batch_size": batch_size,
        "precision_tail": precision_tail,
        "subagent_prompt": prompt,
    }

    if as_json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        sep = "=" * 72
        print(sep)
        print("Antigravity Subagent Context Stress Payload Ready")
        print(sep)
        print(f"Directory:               {abs_dir}")
        print(f"Files generated:         {file_count} (batch_01.txt .. batch_{file_count:02d}.txt)")
        print(f"Avg file size:           {sample_bytes:,} bytes (~{est_tokens_per_file:,} tokens/file)")
        print(f"Total payload:           {total_bytes:,} bytes (~{est_tokens_per_file * file_count:,} tokens)")
        print(f"Recommended schedule:    {schedule_desc}")
        print("\n[Subagent Prompt (invoke_subagent TypeName='self', Model='inherit')]")
        print("-" * 72)
        print(prompt)
        print(sep)
    return result


def verify_session(
    conv_id: str,
    expected: str = "1m",
    base_dir: str | None = None,
    as_json: bool = False,
) -> dict[str, Any]:
    """Verify stress-test session trajectory, CHECKPOINT events, and threshold verdict."""
    expected_key = expected.lower()
    if expected_key not in TIER_SPECS:
        raise ValueError(f"Unsupported expected tier '{expected}'. Choose from: {', '.join(TIER_SPECS)}")

    target_tokens, _, min_pass_tokens, expected_ceiling = TIER_SPECS[expected_key]
    bdir = base_dir or DEFAULT_BASE_DIR
    tf = os.path.join(bdir, "brain", conv_id, ".system_generated", "logs", "transcript.jsonl")
    if not os.path.exists(tf):
        raise FileNotFoundError(f"Transcript not found for session '{conv_id}': {tf}")

    db_step_info = load_conversation_db_step_info(conv_id, bdir)

    transcript_steps: dict[int, dict[str, Any]] = {}
    with open(tf, "r", encoding="utf-8", errors="ignore") as fp:
        for line in fp:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            idx = obj.get("step_index")
            if idx is not None:
                transcript_steps[int(idx)] = obj

    all_indices = sorted(set(db_step_info.keys()) | set(transcript_steps.keys()))
    trajectory: list[dict[str, Any]] = []
    compactions: list[dict[str, Any]] = []
    models_seen: list[str] = []

    last_planner_ctx = 0
    pending_compact_idx: int | None = None
    peak_planner_ctx = 0
    peak_checkpoint_inp = 0

    for idx in all_indices:
        t_obj = transcript_steps.get(idx, {})
        stype = str(t_obj.get("type", "PLANNER_RESPONSE"))
        db_inp, db_cache, db_out, db_model = db_step_info.get(idx, (0, 0, 0, None))

        t_inp = int(t_obj.get("input_tokens", 0) or 0)
        t_cache = int(t_obj.get("cache_read_tokens", 0) or 0)
        t_out = int(t_obj.get("output_tokens", 0) or 0)

        inp = db_inp if (db_inp or db_cache or db_out) else t_inp
        cache = db_cache if (db_inp or db_cache or db_out) else t_cache
        out = db_out if (db_inp or db_cache or db_out) else t_out
        ctx = inp + cache

        model_disp = get_model_display_name(db_model) if db_model else None
        if model_disp and model_disp not in models_seen:
            models_seen.append(model_disp)

        if stype == "PLANNER_RESPONSE" and ctx > 0:
            peak_planner_ctx = max(peak_planner_ctx, ctx)
            last_planner_ctx = ctx
            trajectory.append(
                {
                    "step_index": idx,
                    "type": stype,
                    "ctx_tokens": ctx,
                    "input_tokens": inp,
                    "cache_read_tokens": cache,
                    "output_tokens": out,
                    "model": model_disp,
                }
            )
            if pending_compact_idx is not None:
                cp = compactions[pending_compact_idx]
                cp["post_planner_ctx"] = ctx
                ref_before = cp["checkpoint_input_tokens"] or cp["pre_planner_ctx"]
                if ref_before > 0:
                    cp["reduction_pct"] = round((1.0 - ctx / ref_before) * 100.0, 2)
                pending_compact_idx = None

        elif stype == "CHECKPOINT":
            cp_inp = t_inp or inp
            cp_out = t_out or out
            peak_checkpoint_inp = max(peak_checkpoint_inp, cp_inp)
            trajectory.append(
                {
                    "step_index": idx,
                    "type": stype,
                    "ctx_tokens": cp_inp,
                    "input_tokens": cp_inp,
                    "cache_read_tokens": 0,
                    "output_tokens": cp_out,
                    "model": None,
                }
            )
            compactions.append(
                {
                    "step_index": idx,
                    "pre_planner_ctx": last_planner_ctx,
                    "checkpoint_input_tokens": cp_inp,
                    "checkpoint_output_tokens": cp_out,
                    "post_planner_ctx": None,
                    "reduction_pct": None,
                }
            )
            pending_compact_idx = len(compactions) - 1

    observed_ceiling = max(peak_planner_ctx, peak_checkpoint_inp)

    if compactions:
        first_trigger = compactions[0]["checkpoint_input_tokens"] or compactions[0]["pre_planner_ctx"]
        if expected_ceiling > 256000 and first_trigger <= 270000:
            verdict = "FAIL"
            reason = (
                f"Compacted early at {first_trigger:,} tokens (<= 270K); "
                "official 256K limit or Cloud Mendel override is still active."
            )
        elif observed_ceiling >= min_pass_tokens:
            verdict = "PASS"
            reason = (
                f"Bypassed 256K baseline and reached {observed_ceiling:,} tokens "
                f"(target={target_tokens:,}, min_pass={min_pass_tokens:,})."
            )
        else:
            verdict = "WARN"
            reason = (
                f"Compacted at {first_trigger:,} tokens, below expected pass floor "
                f"({min_pass_tokens:,}) for target {expected.upper()}."
            )
    else:
        if observed_ceiling >= min_pass_tokens:
            verdict = "PASS"
            reason = (
                f"No compaction needed yet and peak context reached {observed_ceiling:,} tokens "
                f"(>= {min_pass_tokens:,})."
            )
        else:
            verdict = "INCOMPLETE"
            reason = (
                f"No CHECKPOINT observed and peak context only reached {observed_ceiling:,} tokens "
                f"(< {min_pass_tokens:,}); increase payload count to stress further."
            )

    summary = {
        "conversation_id": conv_id,
        "expected_tier": expected_key,
        "expected_tokens": target_tokens,
        "models": models_seen,
        "peak_planner_ctx": peak_planner_ctx,
        "peak_checkpoint_input_tokens": peak_checkpoint_inp,
        "observed_ceiling_tokens": observed_ceiling,
        "compaction_count": len(compactions),
        "compactions": compactions,
        "verdict": verdict,
        "reason": reason,
        "trajectory": trajectory,
    }

    if as_json:
        print(json.dumps(summary, indent=2, ensure_ascii=False))
        return summary

    sep = "=" * 78
    print(sep)
    print(f"Subagent Context Stress Verification: {conv_id}")
    print(sep)
    print(f"Expected Tier:         {expected.upper()} ({target_tokens:,} tokens)")
    print(f"Observed Model(s):     {', '.join(models_seen) if models_seen else 'Unknown'}")
    print(f"Peak Planner Context:  {peak_planner_ctx:,} tokens")
    print(f"Peak Checkpoint Input: {peak_checkpoint_inp:,} tokens")
    print(f"Compactions Triggered: {len(compactions)}")
    print(f"Verdict:               [{verdict}] {reason}")

    if compactions:
        print("\n[CHECKPOINT Events]")
        for i, cp in enumerate(compactions, 1):
            red = f"{cp['reduction_pct']:.1f}%" if cp["reduction_pct"] is not None else "N/A"
            post = f"{cp['post_planner_ctx']:,}" if cp["post_planner_ctx"] is not None else "N/A"
            print(
                f"  #{i} Step {cp['step_index']:3d}: "
                f"pre_planner={cp['pre_planner_ctx']:,} -> ckpt_in={cp['checkpoint_input_tokens']:,} "
                f"-> post={post} (reduction: {red})"
            )

    print("\n[Step Trajectory]")
    for row in trajectory:
        print(
            f"  Step {row['step_index']:3d} | {row['type']:16s} | "
            f"ctx={row['ctx_tokens']:7,d} (inp={row['input_tokens']:7,d}, cache={row['cache_read_tokens']:7,d}, out={row['output_tokens']:5,d}) | "
            f"model={row['model']}"
        )
    print(sep)
    return summary


def cleanup_payloads(out_dir: str, as_json: bool = False) -> dict[str, Any]:
    """Safely remove only generated batch_*.txt stress files from out_dir."""
    abs_dir = os.path.abspath(out_dir)
    removed = 0
    if os.path.isdir(abs_dir):
        for name in os.listdir(abs_dir):
            if _BATCH_FILE_RE.match(name):
                os.remove(os.path.join(abs_dir, name))
                removed += 1
        try:
            if not os.listdir(abs_dir):
                os.rmdir(abs_dir)
        except OSError:
            pass

    res = {"out_dir": abs_dir, "removed_files": removed}
    if as_json:
        print(json.dumps(res, indent=2, ensure_ascii=False))
    else:
        print(f"Cleaned up {removed} stress payload file(s) from {abs_dir}.")
    return res


def main() -> None:
    """CLI entry point for subagent context stress testing."""
    parser = argparse.ArgumentParser(
        description="Antigravity Subagent Context Window Stress Test Helper CLI"
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--prepare", action="store_true", help="Generate deterministic read_file stress payloads and subagent prompt")
    mode.add_argument("--verify", metavar="SESSION_ID", help="Verify empirical compaction thresholds from a stress-test subagent session")
    mode.add_argument("--cleanup", action="store_true", help="Remove generated batch_*.txt payload files from --out-dir")

    parser.add_argument("--out-dir", default=_default_out_dir(), help="Payload directory for --prepare / --cleanup")
    parser.add_argument("--target", "--expected", dest="target", choices=list(TIER_SPECS.keys()), default="1m", help="Target/expected context tier (default: 1m)")
    parser.add_argument("--count", type=int, default=None, help="Number of payload files to generate (default: auto-sized for --target)")
    parser.add_argument("--lines", type=int, default=620, help="Lines per payload file (default: 620, ~43.7KB < 46KB read_file cap)")
    parser.add_argument("--batch-size", type=int, default=8, help="Files per step in bulk phase (default: 8)")
    parser.add_argument("--seed", type=int, default=20261114, help="PRNG seed for payload generation")
    parser.add_argument("--base-dir", help="Antigravity base data directory (default: ~/.gemini/antigravity)")
    parser.add_argument("--json", action="store_true", help="Output machine-readable JSON")

    args = parser.parse_args()

    try:
        if args.prepare:
            prepare_payloads(
                out_dir=args.out_dir,
                target=args.target,
                count=args.count,
                lines_per_file=args.lines,
                batch_size=args.batch_size,
                seed=args.seed,
                as_json=args.json,
            )
        elif args.verify:
            res = verify_session(
                conv_id=args.verify,
                expected=args.target,
                base_dir=args.base_dir,
                as_json=args.json,
            )
            if res["verdict"] == "FAIL":
                sys.exit(2)
        elif args.cleanup:
            cleanup_payloads(out_dir=args.out_dir, as_json=args.json)
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
