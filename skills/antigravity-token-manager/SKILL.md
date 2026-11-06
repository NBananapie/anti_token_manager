---
name: antigravity-token-manager
description: 审计 Antigravity 会话 Token 消耗并核算 Gemini 与 Claude 模型支出。用于统计各周期 Token 用量、分析上下文压缩行为，并管理 language_server 上下文窗口限制配置。
---

# Antigravity Token & Context Manager

Unified toolset to audit Antigravity local session token consumption, calculate Google Gemini and Anthropic Claude model costs (via SQLite `gen_metadata` and `steps` ground-truth attribution), measure conversation output speed and latency (TTFT, streaming `tok/s`, end-to-end `tok/s`, and thinking vs visible response token splits), analyze context compaction (`CHECKPOINT`) behaviors, and manage context window limit binary configurations (128K, 256K, 320K, 384K).

All execution logic is self-contained in Python standard-library scripts under `scripts/`.

---

## 1. Tool Index

| Tool | Path | Primary Purpose |
| :--- | :--- | :--- |
| **Daily & Weekly Reporter** | [`scripts/report_daily_tokens.py`](scripts/report_daily_tokens.py) | Automated daily token reporter (yesterday's metrics on weekdays/weekends, past 7 days on Mondays) with Gemini + Claude attribution, output speed/TTFT metrics, subagent hierarchy, and compaction audits. |
| **Token & Cost Analyzer** | [`scripts/analyze_tokens.py`](scripts/analyze_tokens.py) | Scans all transcripts and SQLite databases to aggregate input, cache, thinking, and response tokens, output throughput (`tok/s`), TTFT latency, and Gemini + Claude API expenses across time intervals or by `--session`. |
| **Compact Analyzer** | [`scripts/analyze_compact.py`](scripts/analyze_compact.py) | Computes empirical context compaction thresholds, interaction steps, and post-compact reduction percentages by model. |
| **Token Limit Manager** | [`scripts/manage_token_limit.py`](scripts/manage_token_limit.py) | Inspects status and configures `language_server`'s context window limits (128K, 256K, 320K, 384K) across all models or by specific model (Flash/Argon). |
| **Pricing Core** | [`scripts/pricing.py`](scripts/pricing.py) | Houses official fallback Gemini & Claude rates, local cache (`gemini_pricing.json`), model enum/backend resolution, and online synchronization logic. |
| **Transcript & Formatter** | [`scripts/transcript.py`](scripts/transcript.py), [`scripts/formatter.py`](scripts/formatter.py) | Single-pass streaming transcript/SQLite parser (extracting tokens, thinking/response splits, TTFT/streaming durations, and per-step models) and East Asian character-aware terminal table renderer. |

---

## 2. Workflows & Usage

Run all commands from the skill root directory. For detailed flags and options, pass `--help` to any script.

### Workflow A: Token Usage & Cost Audits

Execute [`scripts/analyze_tokens.py`](scripts/analyze_tokens.py) to generate usage summaries and cost breakdowns:

```bash
# Query usage for a specific timeframe
python3 scripts/analyze_tokens.py --period today
python3 scripts/analyze_tokens.py --period this-week --group-by date
python3 scripts/analyze_tokens.py --period this-month --group-by week
python3 scripts/analyze_tokens.py --period all-time --group-by month

# Custom date range
python3 scripts/analyze_tokens.py --start 2026-10-01 --end 2026-10-14 --group-by date

# Synchronize latest pricing from official channels before reporting
python3 scripts/analyze_tokens.py --period today --sync-pricing

# Machine-readable JSON output
python3 scripts/analyze_tokens.py --period today --json
```

**Auditing & Subagent Association Rules**:
* **Parent-Child Unified Costing**: When auditing or reporting token consumption and costs for a specific conversation session, ALWAYS recursively inspect and aggregate both the parent main agent and all derived subagents (`parent_conversation_id == target_id`).
* **Reporting Structure**: Always present the parent main agent metrics, each subagent's role and metrics, and the grand combined total to avoid undercounting background agent tasks.

**Pricing Resolution**:
* Uses built-in official fallback rates (`gemini-3.8-flash`, `gemini-4-argon`, `gemini-3.5-flash-lite`, `gemini-3.1-pro`).
* If pricing changes, sync via `--sync-pricing`, or retrieve current rates from Google Gemini API documentation and update `scripts/gemini_pricing.json`.

---

### Workflow B: Context Compaction Threshold Analysis

Execute [`scripts/analyze_compact.py`](scripts/analyze_compact.py) to evaluate model truncation and context compaction dynamics:

```bash
# Formatted terminal report
python3 scripts/analyze_compact.py

# Raw JSON data
python3 scripts/analyze_compact.py --json
```

**Key Metrics**:
* **Context Window at Trigger**: `input_tokens + cache_read_tokens` at compaction moment (~108.8K for default 128K limit, ~217.6K under 256K patch).
* **Cumulative Flow**: Total accumulated token throughput between consecutive compaction events.
* **Reduction Percentage**: Context size reduction achieved after compaction (typically 70% to 82%).

---

### Workflow C: Manage Context Token Limits (128K / 256K / 320K / 384K / 512K)

Execute [`scripts/manage_token_limit.py`](scripts/manage_token_limit.py) to inspect and configure the language service binary:

```bash
# 1. Check current token limits and model trigger watermarks
python3 scripts/manage_token_limit.py --status

# 2. Upgrade all models (Flash and Argon) to 256K, 320K, 384K, or 512K
python3 scripts/manage_token_limit.py --set 256k
python3 scripts/manage_token_limit.py --set 384k
python3 scripts/manage_token_limit.py --set 512k

# 3. Target specific models independently (e.g. Flash 512K, Argon 384K)
python3 scripts/manage_token_limit.py --set 512k --model flash
python3 scripts/manage_token_limit.py --set 512k --model argon

# 4. Restore official defaults: Flash 128K (~108.8K trigger) & Argon 256K (~217.6K trigger)
python3 scripts/manage_token_limit.py --restore
```

> [!IMPORTANT]
> Fully quit and restart the Antigravity application after applying modifications for new context limit configurations and compaction watermarks to take effect.
