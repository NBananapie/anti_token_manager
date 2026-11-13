---
name: antigravity-token-manager
description: 审计 Antigravity 会话 Token 消耗并核算 Gemini 与 Claude 模型支出。用于统计各周期 Token 用量、分析上下文压缩行为，并管理 language_server 上下文窗口限制配置。
---

# Antigravity Token & Context Manager

Unified toolset to audit Antigravity local session token consumption, calculate Google Gemini and Anthropic Claude model costs (via SQLite `gen_metadata` and `steps` ground-truth attribution), measure conversation output speed and latency (TTFT, streaming `tok/s`, end-to-end `tok/s`, and thinking vs visible response token splits), analyze context compaction (`CHECKPOINT`) behaviors, and manage context window limit binary configurations (`128K`, `256K`, `320K`, `384K`, `512K`, `768K`, `1M`).

All execution logic is self-contained in Python standard-library scripts under `scripts/`.

---

## 1. Tool Index

| Tool | Path | Primary Purpose |
| :--- | :--- | :--- |
| **Daily & Weekly Reporter** | [`scripts/report_daily_tokens.py`](scripts/report_daily_tokens.py) | Automated daily token reporter (yesterday's metrics on weekdays/weekends, past 7 days on Mondays) with Gemini + Claude attribution, output speed/TTFT metrics, subagent hierarchy, and compaction audits. |
| **Token & Cost Analyzer** | [`scripts/analyze_tokens.py`](scripts/analyze_tokens.py) | Scans all transcripts and SQLite databases to aggregate input, cache, thinking, and response tokens, output throughput (`tok/s`), TTFT latency, and Gemini + Claude API expenses across time intervals or by `--session`. |
| **Compact Analyzer** | [`scripts/analyze_compact.py`](scripts/analyze_compact.py) | Computes empirical context compaction thresholds, interaction steps, post-compact reduction percentages by model, or step-by-step trajectory via `--session`. |
| **Token Limit Manager** | [`scripts/manage_token_limit.py`](scripts/manage_token_limit.py) | Inspects status and configures `language_server`'s context window limits (`128K`, `256K`, `320K`, `384K`, `512K`, `768K`, `1M`) across `.rdata` JSON slots and 5 x86_64 machine-code clamp/override points. |
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
* Uses built-in official fallback rates (`gemini-4-carbon`, `gemini-4-argon`, `gemini-4-hydrogen`, `gemini-pro-orchestrator`, `gemini-pro-orchestrator-argon`, `gemini-3.8-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-pro`, `claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-oss-120b`).
* `Orchestrator (Carbon)` and `Orchestrator (Argon)` sessions dynamically switch per step between planner models (`Carbon` / `Argon`: $2.00 / $0.10 cache / $10.00 output per 1M tokens) and execution models (`Gemini 4 Hydrogen`: $1.50 / $0.075 cache / $7.50 output per 1M tokens); SQLite `gen_metadata` attributes each step to the exact underlying model executed.
* If pricing changes, sync via `--sync-pricing`, or retrieve current rates from Google Gemini API documentation and update `scripts/gemini_pricing.json`.

---

### Workflow B: Context Compaction Threshold Analysis

Execute [`scripts/analyze_compact.py`](scripts/analyze_compact.py) to evaluate model truncation and context compaction dynamics:

```bash
# Formatted terminal report across all sessions
python3 scripts/analyze_compact.py

# Step-by-step context trajectory and CHECKPOINT audit for a specific session
python3 scripts/analyze_compact.py --session <conversation-id>

# Raw JSON data
python3 scripts/analyze_compact.py --json
```

**Key Metrics**:
* **Context Window at Trigger**: `input_tokens + cache_read_tokens` at compaction moment (`CHECKPOINT` triggers immediately after crossing `100%` of `max_token_limit` across `Gemini 3.8 Flash`, `Gemini 4 Hydrogen`, `Gemini 4 Argon`, `Gemini 4 Carbon`, and `Orchestrator` modes, e.g., `> 256,000` for `256K`, `> 512,000` for `512K`, and `> 840,000` for `1M (840K)`).
* **Cumulative Flow**: Total accumulated token throughput between consecutive compaction events.
* **Reduction Percentage**: Context size reduction achieved after compaction (typically 70% to 97%).

---

### Workflow C: Manage Context Token Limits (128K / 256K / 320K / 384K / 512K / 768K / 1M)

Execute [`scripts/manage_token_limit.py`](scripts/manage_token_limit.py) to inspect and configure the language service binary:

```bash
# 1. Check current token limits, dynamic model baseline, machine-code clamps, and Mendel override status
python3 scripts/manage_token_limit.py --status

# 2. Upgrade all models (Flash, Hydrogen, Argon, Carbon, Orchestrator, Claude) to 256K..1M
python3 scripts/manage_token_limit.py --set 256k
python3 scripts/manage_token_limit.py --set 512k
python3 scripts/manage_token_limit.py --set 768k
python3 scripts/manage_token_limit.py --set 1m

# 3. Target specific model scopes (machine-code clamp auto-protects higher configured models)
python3 scripts/manage_token_limit.py --set 512k --model flash
python3 scripts/manage_token_limit.py --set 1m --model argon
python3 scripts/manage_token_limit.py --set 1m --model hydrogen
python3 scripts/manage_token_limit.py --set 1m --model orchestrator

# 4. Restore official defaults (build-matched backup check or safe in-place restore)
python3 scripts/manage_token_limit.py --restore
```

**Binary Patch Architecture (x86_64)**:
* **`.rdata` `snapshotmendelfp` 12-Byte JSON Slots**: Updates the static `M124` (`Gemini 3.8 Flash`), `M400` (`Claude 5.5`), `M408` (`Gemini 4 Argon / Carbon`), and legacy `FLASH_PREFIX` `max_token_limit` slots in-place without shifting binary offsets. For `--set 1m` (or `840k`), `max_token_limit` is set to `840000` (`840K`, matching Google's built-in `claude-1m_840k` profile) so it passes `ValidateCheckpointConfigForModelInfo` (`MaxTokenLimit <= MaxTokens - MaxOutputTokens`, i.e. `840,000 <= 1,000,000 - 65,536 = 934,464`) and reserves `160K` tokens for single-turn tool output growth and checkpoint summarization.
* **Pattern 1 & 2 (`utils.GetCheckpointConfig` + `ClampCheckpointConfigForModelInfo`)**: Raises the 3 hardcoded `uint32` baseline/clamp constants (`0x3e800 -> target`) and replaces `cmovb` (`0f 42 f2`) with `nop` (`90 90 90`) when `limit > 256K`. Cloud-pushed dynamic models not listed in static `snapshotmendelfp["models"]` — including `Gemini 4 Hydrogen (Low/Medium/High/XHigh)`, `Orchestrator (Carbon / Argon)`, and `Gemini 4 Carbon (M427)` — inherit this `Pattern 1` baseline directly while `ClampCheckpointConfigForModelInfo` automatically caps to `min(limit, modelInfo.MaxTokens - reserve)`.
* **Pattern 3 (`(*overlayFeatureProvider).GetProto`)**: Patches `74 29 -> eb 29` so `CASCADE_USE_EXPERIMENT_CHECKPOINTER` Protobuf lookups always read from local `p.base` (`snapshotmendelfp`) instead of cloud `MendelStateCache`.
* **Pattern 4 (`(*snapshotFallbackFactory).NewProvider`)**: Patches `74 57 -> 90 90` after `HasNoCCPAAccess()` so authenticated sessions always construct `overlayFeatureProvider(base=snapshotmendelfp, overlay=liveMendelStateCache)` rather than short-circuiting to pure cloud `*MendelAdapter`.

> [!IMPORTANT]
> Fully quit and restart the Antigravity application after applying modifications for new context limit configurations and compaction watermarks to take effect.
