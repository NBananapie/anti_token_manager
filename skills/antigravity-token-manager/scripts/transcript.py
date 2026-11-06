#!/usr/bin/env python3
"""
Antigravity conversation transcript and SQLite metadata parser.
Provides single-pass streaming parsing for token usage, compaction events,
and authoritative per-step model attribution (Gemini & Claude) via SQLite gen_metadata.
Zero-dependency using Python standard library.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any

from pricing import compute_step_cost, resolve_db_model_name

# Default Timezone: UTC+8
DEFAULT_TZ = timezone(timedelta(hours=8))
DEFAULT_BASE_DIR = os.path.expanduser("~/.gemini/antigravity")

_MODEL_CHANGE_RE = re.compile(
    r"<USER_SETTINGS_CHANGE>\s*The user changed setting `Model Selection`\s+from\s+[^\n]+?\s+to\s+([^\n]+?)\.(?:\s+No need|\s*</USER_SETTINGS_CHANGE>|\s*$)"
)


def parse_datetime(dt_str: str | None) -> datetime | None:
    """Parse ISO datetime string and convert to UTC+8."""
    if not dt_str:
        return None
    clean = dt_str.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(clean)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(DEFAULT_TZ)
    except Exception:
        return None


def extract_model_change(content: str | None) -> str | None:
    """Extract updated model selection strictly from <USER_SETTINGS_CHANGE> block."""
    if not content or "<USER_SETTINGS_CHANGE>" not in content:
        return None
    m = _MODEL_CHANGE_RE.search(content)
    if m:
        to_m = m.group(1).strip()
        if to_m and len(to_m) <= 64 and "comment" not in to_m.lower():
            return to_m
    return None


def decode_varint(data: bytes, offset: int) -> tuple[int, int]:
    """Decode a variable-length integer from protobuf bytes."""
    res = 0
    shift = 0
    l = len(data)
    while offset < l:
        b = data[offset]
        offset += 1
        res |= (b & 0x7F) << shift
        if not (b & 0x80):
            break
        shift += 7
    return res, offset


def parse_proto(data: bytes) -> list[tuple[int, int, Any]]:
    """Parse minimal protobuf wire format."""
    fields = []
    offset = 0
    l = len(data)
    while offset < l:
        tag, offset = decode_varint(data, offset)
        wire_type = tag & 0x07
        field_num = tag >> 3
        if wire_type == 0:
            val, offset = decode_varint(data, offset)
            fields.append((field_num, wire_type, val))
        elif wire_type == 1:
            offset += 8
            if offset > l:
                break
            fields.append((field_num, wire_type, None))
        elif wire_type == 2:
            length, offset = decode_varint(data, offset)
            if offset + length > l:
                break
            val = data[offset : offset + length]
            offset += length
            fields.append((field_num, wire_type, val))
        elif wire_type == 5:
            offset += 4
            if offset > l:
                break
            fields.append((field_num, wire_type, None))
        else:
            break
    return fields


def extract_tokens_from_meta(meta: bytes | None) -> tuple[int, int, int]:
    """Extract (input_tokens, cache_read_tokens, output_tokens) from protobuf metadata BLOB."""
    if not meta:
        return 0, 0, 0
    try:
        top_fields = parse_proto(meta)
        for fn, wt, val in top_fields:
            if fn == 9 and wt == 2 and isinstance(val, (bytes, bytearray)):
                sub = dict((s[0], s[2]) for s in parse_proto(val) if s[1] == 0)
                return sub.get(2, 0), sub.get(5, 0), sub.get(3, 0)
    except Exception:
        pass
    return 0, 0, 0


def _to_signed64(val: int) -> int:
    """Convert unsigned 64-bit varint value to signed 64-bit integer."""
    return val - (1 << 64) if val >= (1 << 63) else val


def _parse_proto_seconds(blob: bytes | None) -> float | None:
    """Decode google.protobuf.Duration or google.protobuf.Timestamp bytes into seconds."""
    if not blob:
        return None
    sec = 0
    nanos = 0
    has_field = False
    for fn, wt, val in parse_proto(blob):
        if wt == 0:
            if fn == 1:
                sec = _to_signed64(val)
                has_field = True
            elif fn == 2:
                nanos = _to_signed64(val)
                has_field = True
    if not has_field:
        return None
    total = sec + nanos / 1_000_000_000.0
    return total if total >= 0.0 else 0.0


def compute_speed_metrics(steps: list[dict[str, Any]]) -> dict[str, Any]:
    """
    Compute aggregated latency and throughput metrics across a collection of step dicts.
    Uses duration-weighted ratios to prevent single-chunk burst distortion.
    """
    timed_steps = [
        s
        for s in steps
        if s.get("has_tokens")
        and s.get("total_duration_s") is not None
        and s["total_duration_s"] > 0
    ]
    ttft_vals = [s["ttft_s"] for s in timed_steps if s.get("ttft_s") is not None]
    avg_ttft_s = (sum(ttft_vals) / len(ttft_vals)) if ttft_vals else 0.0

    stream_steps = [
        s
        for s in timed_steps
        if s.get("stream_s") is not None
        and s["stream_s"] >= 0.5
        and s.get("response_tokens", 0) > 0
    ]
    sum_stream_tokens = sum(s["response_tokens"] for s in stream_steps)
    sum_stream_sec = sum(s["stream_s"] for s in stream_steps)
    stream_tps = (sum_stream_tokens / sum_stream_sec) if sum_stream_sec > 0 else 0.0

    e2e_steps = [s for s in timed_steps if s.get("output_tokens", 0) > 0]
    sum_e2e_tokens = sum(s["output_tokens"] for s in e2e_steps)
    sum_e2e_sec = sum(s["total_duration_s"] for s in e2e_steps)
    e2e_tps = (sum_e2e_tokens / sum_e2e_sec) if sum_e2e_sec > 0 else 0.0

    return {
        "timed_steps": len(timed_steps),
        "avg_ttft_s": avg_ttft_s,
        "stream_duration_s": sum_stream_sec,
        "total_duration_s": sum_e2e_sec,
        "stream_tps": stream_tps,
        "e2e_tps": e2e_tps,
    }


def _parse_gen_metadata_detail(blob: bytes | None) -> dict[str, Any] | None:
    """
    Parse a row from gen_metadata table including model, token split, and timing durations.
    """
    if not blob:
        return None
    try:
        for fn, wt, val in parse_proto(blob):
            if fn == 1 and wt == 2 and isinstance(val, (bytes, bytearray)):
                bot_id: str | None = None
                backend_model: str | None = None
                model_enum: int | None = None
                thinking_tokens = 0
                response_tokens = 0
                ttft_s: float | None = None
                stream_s: float | None = None

                for sfn, swt, sval in parse_proto(val):
                    if sfn == 3 and swt == 0:
                        model_enum = sval
                    elif sfn == 4 and swt == 2 and isinstance(sval, (bytes, bytearray)):
                        for f4n, f4wt, f4val in parse_proto(sval):
                            if f4n == 1 and f4wt == 0 and model_enum is None:
                                model_enum = f4val
                            elif f4n == 7 and f4wt == 2 and isinstance(f4val, (bytes, bytearray)):
                                bot_id = f4val.decode("utf-8", errors="ignore")
                            elif f4n == 9 and f4wt == 0:
                                thinking_tokens = f4val
                            elif f4n == 10 and f4wt == 0:
                                response_tokens = f4val
                    elif sfn == 11 and swt == 2 and isinstance(sval, (bytes, bytearray)):
                        ttft_s = _parse_proto_seconds(sval)
                    elif sfn == 12 and swt == 2 and isinstance(sval, (bytes, bytearray)):
                        stream_s = _parse_proto_seconds(sval)
                    elif sfn == 19 and swt == 2 and isinstance(sval, (bytes, bytearray)):
                        backend_model = sval.decode("utf-8", errors="ignore")

                return {
                    "bot_id": bot_id,
                    "backend_model": backend_model,
                    "model_enum": model_enum,
                    "thinking_tokens": thinking_tokens,
                    "response_tokens": response_tokens,
                    "ttft_s": ttft_s,
                    "stream_s": stream_s,
                }
    except Exception:
        pass
    return None


def _parse_gen_metadata_row(blob: bytes | None) -> tuple[str | None, str | None, int | None]:
    """
    Parse a row from gen_metadata table.
    Returns: (bot_id, backend_model_str, model_enum_int)
    """
    detail = _parse_gen_metadata_detail(blob)
    if not detail:
        return None, None, None
    return detail["bot_id"], detail["backend_model"], detail["model_enum"]


def load_conversation_db_step_details(
    conv_id: str, base_dirs: list[str] | str | None = None
) -> dict[int, dict[str, Any]]:
    """
    Query conversations/<conv_id>.db to retrieve authoritative per-step token counts,
    thinking vs response token split, TTFT/streaming durations, and exact model attribution.
    """
    if not base_dirs:
        dirs = [DEFAULT_BASE_DIR]
    elif isinstance(base_dirs, str):
        dirs = [base_dirs]
    else:
        dirs = list(base_dirs)

    for bdir in dirs:
        db_path = os.path.join(bdir, "conversations", f"{conv_id}.db")
        if not os.path.exists(db_path):
            continue
        try:
            conn = sqlite3.connect(db_path)
            cur = conn.cursor()

            # 1. Map bot_id -> parsed gen_metadata details
            bot_to_gen: dict[str, dict[str, Any]] = {}
            fallback_gen_model: str | None = None
            try:
                for (blob,) in cur.execute("SELECT data FROM gen_metadata WHERE data IS NOT NULL"):
                    g = _parse_gen_metadata_detail(blob)
                    if not g:
                        continue
                    backend_m = g["backend_model"]
                    gen_enum = g["model_enum"]
                    if backend_m and fallback_gen_model is None:
                        fallback_gen_model = resolve_db_model_name(backend_m, gen_enum)
                    if g["bot_id"]:
                        bot_to_gen[g["bot_id"]] = g
            except Exception:
                pass

            # 2. Parse step_type = 15 (PLANNER_RESPONSE) rows in steps table
            result: dict[int, dict[str, Any]] = {}
            cur.execute("SELECT idx, metadata FROM steps WHERE step_type = 15 AND metadata IS NOT NULL;")
            for idx, meta in cur.fetchall():
                if not meta:
                    continue
                inp, cache, out = 0, 0, 0
                thinking, response = 0, 0
                step_enum: int | None = None
                bot_id: str | None = None
                ts_created: float | None = None
                ts_first: float | None = None
                ts_done: float | None = None

                for fn, wt, val in parse_proto(meta):
                    if fn == 11 and wt == 0:
                        step_enum = val
                    elif fn == 1 and wt == 2 and isinstance(val, (bytes, bytearray)):
                        ts_created = _parse_proto_seconds(val)
                    elif fn == 6 and wt == 2 and isinstance(val, (bytes, bytearray)):
                        ts_first = _parse_proto_seconds(val)
                    elif fn == 7 and wt == 2 and isinstance(val, (bytes, bytearray)):
                        ts_done = _parse_proto_seconds(val)
                    elif fn == 9 and wt == 2 and isinstance(val, (bytes, bytearray)):
                        for sfn, swt, sval in parse_proto(val):
                            if swt == 0:
                                if sfn == 1 and step_enum is None:
                                    step_enum = sval
                                elif sfn == 2:
                                    inp = sval
                                elif sfn == 5:
                                    cache = sval
                                elif sfn == 3:
                                    out = sval
                                elif sfn == 9:
                                    thinking = sval
                                elif sfn == 10:
                                    response = sval
                            elif sfn == 7 and swt == 2 and isinstance(sval, (bytes, bytearray)):
                                bot_id = sval.decode("utf-8", errors="ignore")

                g = bot_to_gen.get(bot_id) if bot_id else None
                backend_m = g["backend_model"] if g else None
                gen_enum = g["model_enum"] if g else None
                resolved_model = (
                    resolve_db_model_name(backend_m, step_enum if step_enum is not None else gen_enum)
                    or fallback_gen_model
                )

                if thinking == 0 and response == 0 and g:
                    thinking = g["thinking_tokens"]
                    response = g["response_tokens"]

                ttft_s = g["ttft_s"] if (g and g["ttft_s"] is not None) else None
                stream_s = g["stream_s"] if (g and g["stream_s"] is not None) else None

                if ttft_s is None and ts_created and ts_first and ts_first >= ts_created:
                    ttft_s = ts_first - ts_created
                if stream_s is None and ts_first and ts_done and ts_done >= ts_first:
                    stream_s = ts_done - ts_first

                result[idx] = {
                    "input_tokens": inp,
                    "cache_read_tokens": cache,
                    "output_tokens": out,
                    "thinking_tokens": thinking,
                    "response_tokens": response,
                    "ttft_s": ttft_s,
                    "stream_s": stream_s,
                    "model": resolved_model,
                }

            conn.close()
            return result
        except Exception:
            pass
    return {}


def load_conversation_db_step_info(
    conv_id: str, base_dirs: list[str] | str | None = None
) -> dict[int, tuple[int, int, int, str | None]]:
    """
    Query conversations/<conv_id>.db to retrieve authoritative per-step token counts
    and exact model attribution (combining gen_metadata backend model ID and steps enum ID).
    Returns: dict mapping step_index -> (input_tokens, cache_read_tokens, output_tokens, model_display_name)
    """
    details = load_conversation_db_step_details(conv_id, base_dirs)
    return {
        idx: (
            d["input_tokens"],
            d["cache_read_tokens"],
            d["output_tokens"],
            d["model"],
        )
        for idx, d in details.items()
    }


def load_conversation_db_tokens(
    conv_id: str, base_dirs: list[str] | str | None = None
) -> dict[int, tuple[int, int, int]]:
    """Backward-compatible helper returning step_index -> (input_tokens, cache_read_tokens, output_tokens)."""
    step_info = load_conversation_db_step_info(conv_id, base_dirs)
    return {
        idx: (inp, cache, out)
        for idx, (inp, cache, out, _) in step_info.items()
        if inp or cache or out
    }


class TranscriptScanner:
    """Scans and parses Antigravity session metadata, SQLite generation records, and JSONL transcripts."""

    def __init__(self, base_dirs: list[str] | str | None = None):
        if not base_dirs:
            self.base_dirs = [DEFAULT_BASE_DIR]
        elif isinstance(base_dirs, str):
            self.base_dirs = [base_dirs]
        else:
            self.base_dirs = list(base_dirs)

        self.conv_meta: dict[str, dict[str, Any]] = {}
        self.db_step_detail_cache: dict[str, dict[int, dict[str, Any]]] = {}
        self.db_step_cache: dict[str, dict[int, tuple[int, int, int, str | None]]] = {}
        self.load_metadata()

    def load_metadata(self) -> None:
        """Read conversation metadata from conversation_summaries.db."""
        for bdir in self.base_dirs:
            db_path = os.path.join(bdir, "conversation_summaries.db")
            if not os.path.exists(db_path):
                continue
            try:
                conn = sqlite3.connect(db_path)
                cur = conn.cursor()
                cur.execute(
                    """
                    SELECT conversation_id, title, preview, parent_conversation_id,
                           nesting_depth, agent_name, killed, project_id,
                           workspace_uris, last_modified_time
                    FROM conversation_summaries
                    """
                )
                for row in cur.fetchall():
                    (
                        cid,
                        title,
                        prev,
                        parent_id,
                        depth,
                        agent_name,
                        killed,
                        proj_id,
                        wuris,
                        lmt,
                    ) = row
                    ws_clean = "outside-workspace"
                    if wuris:
                        ws_clean = os.path.basename(wuris.strip("[]\"'").split(",")[-1]) or "outside-workspace"
                    self.conv_meta[cid] = {
                        "title": title or "(Untitled Session)",
                        "preview": prev or "",
                        "parent_id": parent_id or "",
                        "is_subagent": bool(parent_id) or (depth > 0) or bool(agent_name),
                        "depth": depth,
                        "agent_name": agent_name or "main",
                        "killed": bool(killed),
                        "project_id": proj_id or "outside-of-project",
                        "workspace": ws_clean,
                        "in_db": True,
                    }
                conn.close()
            except Exception:
                pass

    def _get_db_step_details(self, conv_id: str) -> dict[int, dict[str, Any]]:
        if conv_id not in self.db_step_detail_cache:
            self.db_step_detail_cache[conv_id] = load_conversation_db_step_details(conv_id, self.base_dirs)
        return self.db_step_detail_cache[conv_id]

    def _get_db_step_info(self, conv_id: str) -> dict[int, tuple[int, int, int, str | None]]:
        if conv_id not in self.db_step_cache:
            details = self._get_db_step_details(conv_id)
            self.db_step_cache[conv_id] = {
                idx: (
                    d["input_tokens"],
                    d["cache_read_tokens"],
                    d["output_tokens"],
                    d["model"],
                )
                for idx, d in details.items()
            }
        return self.db_step_cache[conv_id]

    def scan(
        self,
        start_dt: datetime | None = None,
        end_dt: datetime | None = None,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """
        Scan conversation transcripts and resolve authoritative per-step models & tokens.
        Returns: (all_conversations_summary, all_filtered_steps)
        """
        all_convs: list[dict[str, Any]] = []
        all_steps: list[dict[str, Any]] = []

        # Fast file mtime lower-bound cutoff (with 1-hour safety buffer) when start_dt is specified
        min_mtime = (start_dt.timestamp() - 3600.0) if start_dt else None

        for bdir in self.base_dirs:
            brain_dir = os.path.join(bdir, "brain")
            if not os.path.exists(brain_dir):
                continue

            for entry in os.listdir(brain_dir):
                conv_path = os.path.join(brain_dir, entry)
                if not os.path.isdir(conv_path):
                    continue
                tf = os.path.join(conv_path, ".system_generated", "logs", "transcript.jsonl")
                if not os.path.exists(tf):
                    continue

                if min_mtime is not None:
                    try:
                        if os.path.getmtime(tf) < min_mtime:
                            continue
                    except OSError:
                        pass

                meta = self.conv_meta.get(
                    entry,
                    {
                        "title": "(Untitled Session)",
                        "preview": "",
                        "parent_id": "",
                        "is_subagent": False,
                        "depth": 0,
                        "agent_name": "main",
                        "killed": False,
                        "project_id": "outside-of-project",
                        "workspace": "outside-workspace",
                        "in_db": False,
                    },
                )

                # Load authoritative SQLite step models, token split & timing for this candidate conversation
                db_step_details = self._get_db_step_details(entry)

                # Determine initial fallback model if step 0 precedes any planner step
                init_m = "Gemini 3.8 Flash (High)"
                for _, detail_row in sorted(db_step_details.items()):
                    if detail_row["model"]:
                        init_m = detail_row["model"]
                        break

                conv_steps: list[dict[str, Any]] = []
                current_model = init_m
                first_dt: datetime | None = None
                last_dt: datetime | None = None

                compact_events: list[dict[str, Any]] = []
                cum_in = 0
                cum_cache = 0
                cum_out = 0
                interval_steps = 0
                last_planner_ctx = 0

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
                            changed_m = extract_model_change(content)
                            if changed_m:
                                current_model = changed_m

                        dt = parse_datetime(s.get("created_at"))
                        if dt:
                            if first_dt is None or dt < first_dt:
                                first_dt = dt
                            if last_dt is None or dt > last_dt:
                                last_dt = dt

                        st_index = s.get("step_index", 0)
                        inp = int(s.get("input_tokens", 0) or 0)
                        cache = int(s.get("cache_read_tokens", 0) or 0)
                        out = int(s.get("output_tokens", 0) or 0)
                        has_tokens = "input_tokens" in s or "output_tokens" in s or "cache_read_tokens" in s

                        thinking_tok = 0
                        response_tok = 0
                        ttft_s: float | None = None
                        stream_s: float | None = None

                        # Resolve authoritative model, missing tokens, thinking/response split & timing from SQLite DB
                        if st_index in db_step_details:
                            d = db_step_details[st_index]
                            if d["model"]:
                                current_model = d["model"]
                            if not has_tokens and st_type == "PLANNER_RESPONSE" and (
                                d["input_tokens"] or d["cache_read_tokens"] or d["output_tokens"]
                            ):
                                inp, cache, out = d["input_tokens"], d["cache_read_tokens"], d["output_tokens"]
                                has_tokens = True
                            if st_type == "PLANNER_RESPONSE" or has_tokens:
                                thinking_tok = d["thinking_tokens"]
                                response_tok = d["response_tokens"]
                                ttft_s = d["ttft_s"]
                                stream_s = d["stream_s"]

                        if has_tokens and out > 0 and thinking_tok == 0 and response_tok == 0:
                            response_tok = out

                        total_duration_s = (
                            (ttft_s + stream_s)
                            if (ttft_s is not None and stream_s is not None)
                            else None
                        )
                        stream_tps = (
                            (response_tok / stream_s)
                            if (stream_s is not None and stream_s >= 0.5 and response_tok > 0)
                            else None
                        )
                        e2e_tps = (
                            (out / total_duration_s)
                            if (total_duration_s is not None and total_duration_s > 0 and out > 0)
                            else None
                        )

                        cin, cca, cout, ctot = (
                            compute_step_cost(inp, cache, out, current_model)
                            if has_tokens
                            else (0.0, 0.0, 0.0, 0.0)
                        )

                        tool_calls = [
                            tc.get("name", "unknown")
                            for tc in (s.get("tool_calls", []) or [])
                            if isinstance(tc, dict)
                        ]

                        step_item = {
                            "conv_id": entry,
                            "step_index": st_index,
                            "type": st_type,
                            "dt": dt,
                            "model": current_model,
                            "input_tokens": inp,
                            "cache_read_tokens": cache,
                            "output_tokens": out,
                            "thinking_tokens": thinking_tok,
                            "response_tokens": response_tok,
                            "ttft_s": ttft_s,
                            "stream_s": stream_s,
                            "total_duration_s": total_duration_s,
                            "stream_tps": stream_tps,
                            "e2e_tps": e2e_tps,
                            "has_tokens": has_tokens,
                            "cost_input": cin,
                            "cost_cache": cca,
                            "cost_output": cout,
                            "cost_total": ctot,
                            "tool_calls": tool_calls,
                            "status": s.get("status", "DONE"),
                        }
                        conv_steps.append(step_item)

                        interval_steps += 1
                        cum_in += inp
                        cum_cache += cache
                        cum_out += out

                        if st_type == "PLANNER_RESPONSE" and has_tokens:
                            last_planner_ctx = inp + cache
                        elif st_type == "CHECKPOINT":
                            compact_events.append(
                                {
                                    "step_index": st_index,
                                    "dt": dt,
                                    "model": current_model,
                                    "steps_since_last": interval_steps,
                                    "tokens_since_last": cum_in + cum_cache + cum_out,
                                    "context_size_at_checkpoint": last_planner_ctx,
                                }
                            )
                            cum_in = 0
                            cum_cache = 0
                            cum_out = 0
                            interval_steps = 0

                filtered_steps: list[dict[str, Any]] = []
                for st in conv_steps:
                    st_dt = st["dt"]
                    if start_dt and (st_dt is None or st_dt < start_dt):
                        continue
                    if end_dt and (st_dt is None or st_dt > end_dt):
                        continue
                    filtered_steps.append(st)

                if not filtered_steps:
                    continue

                all_steps.extend(filtered_steps)
                speed_info = compute_speed_metrics(filtered_steps)

                conv_summary = {
                    "conv_id": entry,
                    "title": meta["title"],
                    "is_subagent": meta["is_subagent"],
                    "parent_id": meta.get("parent_id", ""),
                    "agent_name": meta.get("agent_name", ""),
                    "killed": meta["killed"],
                    "in_db": meta["in_db"],
                    "workspace": meta["workspace"],
                    "first_dt": first_dt,
                    "last_dt": last_dt,
                    "step_count": len(filtered_steps),
                    "token_step_count": sum(1 for s in filtered_steps if s["has_tokens"]),
                    "input_tokens": sum(s["input_tokens"] for s in filtered_steps),
                    "cache_read_tokens": sum(s["cache_read_tokens"] for s in filtered_steps),
                    "output_tokens": sum(s["output_tokens"] for s in filtered_steps),
                    "thinking_tokens": sum(s["thinking_tokens"] for s in filtered_steps),
                    "response_tokens": sum(s["response_tokens"] for s in filtered_steps),
                    "avg_ttft_s": speed_info["avg_ttft_s"],
                    "stream_tps": speed_info["stream_tps"],
                    "e2e_tps": speed_info["e2e_tps"],
                    "cost_total": sum(s["cost_total"] for s in filtered_steps),
                    "compact_events": [
                        ce
                        for ce in compact_events
                        if (not start_dt or (ce["dt"] and ce["dt"] >= start_dt))
                        and (not end_dt or (ce["dt"] and ce["dt"] <= end_dt))
                    ],
                }
                all_convs.append(conv_summary)

        return all_convs, all_steps
