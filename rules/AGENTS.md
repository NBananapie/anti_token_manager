# Antigravity Token & 上下文监控规则

- 当用户询问今日/本周/近 30 天/历史 Token 消耗、双厂商（Gemini / Claude）估算费用、模型输出速率（TTFT / `tok/s`）、单会话上下文水位与压缩历史、按项目（Workspace）分摊成本、单步 Token 暴涨归因或 `language_server` 当前上下文窗口上限时，优先直接调用 `antigravity-token-manager_telemetry` MCP 工具（`token_get_overview`、`token_get_session_audit`、`token_get_context_limit`、`token_get_daily_report`、`token_get_workspace_breakdown`、`token_find_heavy_steps`、`token_get_guard_settings`、`token_set_guard_config`），无需运行命令行脚本。
- 审计单会话成本时，始终按 `token_get_session_audit` 返回的主会话分项、各派生子智能体分项与 `combinedTotals` 合并总计三层结构汇报，避免漏计后台子任务开销。
- 当用户要求设置每日/单会话费用预算上限、高水位提醒阈值或热更新上限巡检开关时，直接调用 `token_set_guard_config` 写入插件持久化配置。
- 当用户希望实时观察当前对话上下文水位、锯齿压缩波形、单步暴涨归因或项目成本分摊，或在汇报完账单/高水位预警时，给出打开右侧辅助面板的快捷链接：`[Token & 上下文监控](sidecar://antigravity-token-manager/token-monitor/)`。
- 涉及修改本地 `language_server` 二进制上下文上限（`manage_token_limit.py`）或执行上下文窗口压测（`stress_context.py`）时，先激活 `antigravity-token-manager` Skill，向用户明确说明离线修改风险与修改后需完全重启 Antigravity 客户端，得到用户确认后再执行。
