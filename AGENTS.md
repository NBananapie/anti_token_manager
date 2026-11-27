# AGENTS.md

本仓库包含 Antigravity 原生插件 `antigravity-token-manager`（Sidecar UI、MCP Server、生命周期 Hooks、Skill 与 Rules）、独立 Web 遥测服务以及零依赖 Python CLI 审计与上下文上限运维套件。

> 注意：根目录 `AGENTS.md` 面向本仓库研发维护；`rules/AGENTS.md` 是随插件打包分发的宿主运行时规则文件（受 `scripts/verify_plugin.mjs` 校验），非调整插件规则时请勿修改。

## 1. 环境要求

- **Node.js `>= 22.5.0`**：根目录、`core/`、`mcp/`、`hooks/` 与 `web/server.js` 零第三方 NPM 依赖，直接使用内置 `node:sqlite`、`node:http`、`node:fs` 等模块（根目录无 `node_modules`）。
- **Python `>= 3.10`**：`scripts/` 下全部工具仅使用标准库，无需执行 `pip install`。
- **前端构建环境**：依赖位于 `web/`（React 19、TypeScript `~6.0.2`、Vite `^8.1.1`、`lucide-react`）。

## 2. 构建、运行与打包命令

```bash
# 安装前端构建依赖（.gitignore 已忽略 web/package-lock.json）
npm --prefix web install

# 启动本地 Web 遥测服务（默认 http://127.0.0.1:3820，可通过 PORT 与 ANTIGRAVITY_DATA_DIR 覆盖）
npm start

# 前端热更新开发（Vite 监听 5173 并代理 /api -> http://127.0.0.1:3820，需同时运行 npm start）
npm run dev

# 构建前端生产静态产物至 web/dist/（修改 web/src/ 或 web/index.html 后必须执行）
npm run build

# 安装或更新精简插件产物至 ~/.gemini/config/plugins/antigravity-token-manager
# Windows 下请使用默认复制模式，勿用 plugin:install-link（宿主扫描插件目录会跳过 Junction）
npm run plugin:install
npm run plugin:uninstall

# Python CLI 审计与运维入口
npm run report                                    # 等价于 python scripts/report_daily_tokens.py
npm run analyze                                   # 等价于 python scripts/analyze_tokens.py
python scripts/analyze_compact.py                 # 上下文压缩水位与缩减率统计
python scripts/manage_token_limit.py --status     # 只读查看本机 language_server 上下文上限状态
```

## 3. 测试与静态检查

仓库未配置 Jest、Vitest、Pytest、ESLint、Prettier 或 Ruff。提交前通过以下命令验证：

```bash
# 1. 原生插件全链路集成测试（基于 node:assert/strict）
# 依次校验：Manifest 与构建产物 -> Sidecar HTTP/SSE -> MCP Stdio 8 个工具 -> 4 个隔离生命周期 Hook
npm run plugin:verify

# 2. 前端 TypeScript 类型检查（vite build 不执行类型阻断，修改 web/src/ 后需单独运行）
npx --prefix web tsc -p web/tsconfig.json --noEmit

# 3. Python 语法编译检查（纯内存编译，跨 Shell 通用且不产生 __pycache__）
python -B -c "import pathlib; [compile(p.read_text('utf-8'), str(p), 'exec') for p in pathlib.Path('scripts').glob('*.py')]"
```

PowerShell 执行含中文输出的 Node.js 或 Python 命令前，先设置：
```powershell
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
```

## 4. 代码风格与架构规范

### 4.1 Node.js ESM（`core/`、`mcp/`、`hooks/`、`scripts/*.mjs`、`web/server.js`）
- 根 `package.json` 与 `web/package.json` 均声明 `"type": "module"`；Node.js 内置模块统一带 `node:` 前缀（如 `import fs from 'node:fs';`）。
- 使用 2 空格缩进、单引号字符串、保留语句分号；函数与变量采用 `camelCase`，模块级常量采用 `UPPER_SNAKE_CASE`。
- **协议流隔离**：`mcp/server.mjs` 与 `hooks/*.mjs` 通过 `process.stdout` 输出单行 JSON 协议报文，调试与异常日志只能写入 `console.error`（`stderr`），严禁向 `stdout` 打印非协议文本。

### 4.2 前端 React + TypeScript（`web/`）
- `web/tsconfig.json` 配置为 `target: "ES2022"`、`moduleResolution: "bundler"`、`jsx: "react-jsx"`、`noEmit: true`、`strict: false`。
- 使用 2 空格缩进、单引号、保留分号；组件与接口采用 `PascalCase`，辅助函数采用 `camelCase`。
- **样式与图标**：尽管 `web/package.json` 与 `web/vite.config.ts` 包含 `@stylexjs/stylex` 和 `@astryxdesign/core` 插件配置，现有组件全部使用 `web/src/index.css` 中的语义类名与 CSS 自定义属性（`--bg-*`、`--text-*`、`--border*` 明暗双模变量）编写样式，图标按需从 `lucide-react` 导入。
- **Sidecar 兼容**：API 请求统一调用 `web/src/sidecarBridge.ts` 中的 `apiFetch`，以兼容独立浏览器与 Antigravity Sidecar Webview；`web/vite.config.ts` 输出单 bundle `iife` 格式，`web/server.js` 会在响应根 HTML 时将 CSS、`preload.js` 与 JS 内联进页面。

### 4.3 Python 标准库脚本（`scripts/`）
- 文件头保留 `#!/usr/bin/env python3`、模块文档字符串与 `from __future__ import annotations`。
- 使用 4 空格缩进、双引号字符串、`snake_case` 命名与原生类型注解（如 `int | float`、`list[dict[str, Any]]`）；Windows 控制台入口通过 `sys.stdout.reconfigure(encoding="utf-8")` 保证 UTF-8 输出。
- 禁止引入第三方 `pip` 依赖。

### 4.4 多处同源同步与数据安全边界
- **双目录脚本同步**：`scripts/` 下的全部 `.py` 文件及 `gemini_pricing.json` 在 `skills/antigravity-token-manager/scripts/` 中存有完整物理副本（非符号链接）。修改 `scripts/` 中任一文件后，必须同步复制到 `skills/antigravity-token-manager/scripts/`。
- **模型枚举与费率同步**：新增或修改模型枚举、思考档位或定价时，需同步核查 `core/telemetry.mjs`（`MODEL_ENUM_INFO`、`FALLBACK_PRICING`）、`scripts/pricing.py`、`scripts/gemini_pricing.json` 与 `web/src/types.ts`。
- **数据只读与状态持久化**：对 `~/.gemini/antigravity` 下的 `conversation_summaries.db`、`conversations/*.db` 与 `transcript.jsonl` 严格保持只读访问；插件配置与运行态缓存统一经 `core/plugin-store.mjs` 读写 `$PLUGIN_DATA`（默认 `~/.gemini/antigravity/plugin_data/antigravity-token-manager`）。执行 `manage_token_limit.py` 修改 `language_server` 二进制前必须先向用户说明风险并取得确认。
- **提交信息格式**：遵循 Conventional Commits，例如 `feat(plugin): ...`、`fix(ui): ...`、`perf(sidecar): ...`、`feat(models): ...`。
