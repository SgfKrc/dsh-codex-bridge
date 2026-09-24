# Changelog

本仓库现在的内容是 **dsh-subagent-bridge** —— 把 DSH 的 headless / ACP harness 发布为
Codex 可调用 MCP 工具的零依赖 stdio server。

> **仓库沿革**：仓库原名 `dsh-codex-bridge`，0.1.0 的内容是 Reasonix worker 桥接器的
> vendor 副本（外加一份 DSH 装配模板）。自 0.2.0 起整体替换为本桥接器，接入的 harness
> 从 Reasonix 改为 DSH 本身。Git 远端不变（`SgfKrc/dsh-codex-bridge`）。

## [0.3.0] - 2026-09-24

### Added

- **抗升级**：入口解析补充 `NPM_CONFIG_PREFIX` 与 `PATH` 上的 `dsh` / `dsh.cmd` / `dsh.ps1`，
  并支持从 shim 反解真实 `lib/bin.js`（先取同目录的 npm 布局，再从 shim 文本解析，
  识别 `%dp0%` / `%~dp0` / `$basedir` 前缀以及绝对与相对路径）—— 调用方因此**始终不需要 shell**，
  dsh 换安装形态或换版本都不会失联。
- **启动期版本门** `DSH_MIN_VERSION`（默认 `0.1.5`）：启动时读入口所属包的 `package.json`
  （只认 `name === @deepseek-ai/dsh`）取得实际版本；比较只看 `major.minor.patch`，
  因此 `0.1.5-rc.2` 这类预发布后缀不影响判定。低于下限拒绝启动，版本读不出来只警告、不阻断。
- `dsh_status.dsh` 报出 `launcher` / `source` / `version` / `versionSource` / `minVersion` / `versionCheck`。
- 8 个新离线用例（launcher 来源、版本门、放宽门限、预发布版本、同名异包、两种 shim 布局、
  无 launcher 拒绝），离线套件增至 25 个。

### Documented

- README 增「抗升级」一节，并记录升级 dsh 可能引入的 **profile provider 冲突**：0.1.7-rc.1 的
  `dsh-base` 新增官方 `llm-deepseek`（`DeepSeek Messages adapter`），与自定义网关的 `llm-pi-ai`
  争用同一个 provider id `deepseek`，会让请求落到官方端点并报识鉴权失败
  （`AUTH: Authentication Fails, Your api key: ****xxxx is invalid`，即使该 key 在自建网关上有效）。
  在用到自定义网关的 profile 的 `cordis.patch.yml` 里以 `- id: llm-deepseek` + `disabled: true` 禁用它。

## [0.2.0] - 2026-09-21

### Changed

- **本仓库改换用途**：由「Reasonix worker 桥接器的 vendor 副本」改为
  「DSH 子 agent 桥接器」。移除全部 vendor 内容（`src/` 12 个 Reasonix 模块、
  `prompts/`、`test/` 旧套件、`scripts/` 同步脚本、`VENDOR.json`、`cordis.patch.yml`），
  换成零依赖的 DSH 桥接器实现。
- **脱敏**：新增与改写的文档、脚本中不再包含任何机器专属值 ——
  本机绝对路径、私有网关主机名、账号绑定的 model ref 一律改为占位符
  （`<workspace-root>`）或由使用方显式注入（`DSH_BIN` 必填）。

### Added

- `src/server.mjs`：MCP stdio server，暴露 `dsh_run` 与 `dsh_status` 两个工具。
  `dsh_run` 以 `shell:false` 直接 spawn `node <dsh bin> --profile headless <task>`，
  任务文本作为**单个 argv 元素**传入，不经过 shell。
- `src/acp-client.mjs`：ACP 客户端（换行分隔 JSON-RPC），支持 `initialize` /
  `session/new` / `session/prompt` / `session/close`，聚合 `session/update` 里的
  `agent_message_chunk` 文本。
- **双传输**：默认 `per-call`（一次性），`transport=acp` 走持久会话并可用
  `session_id` 跨调用复用上下文 —— 与 `reasonix-codex-bridge` 的 transport 语义对齐。
- `acp-route.patch.yml`：ACP 路由覆盖模板。`dsh --profile acp` 自身把 provider 钉死为
  `deepseek-official`，会绕过 settings 层默认路由；本机若不用官方直连端点，`session/prompt`
  会鉴权失败（而 `headless` 正常），导致两边落在不同 provider 上。该 patch 用于拉平偏差。
- `scripts/acp-probe.mjs`：可复用的 ACP 端到端验收脚本（不依赖模型客户端）。
- 16 个离线用例：MCP 握手、工具面、参数闸门（空/超长任务、越界 cwd、非法超时）、
  启动器缺失 fail-closed、ACP 开关与未知 session 拒绝。

### 已知限制

- ACP 会话存活于桥接器进程内，上限 8 个；桥接器重启即失效。
- `DSH_SUBAGENT_*` 仅作状态回报，不改写 profile 的模型路由。

## [0.1.0] - 2026-09-20

### Added

- 首次发布：`cordis.patch.yml` 模板，声明两个角色互斥通道
  （`reasonix-mcp-read` / `reasonix-mcp-write`），路径与模型引用均为占位符。
- 从 `reasonix-codex-bridge@987ed9bbf999e4ba9b18d8267065fbccd58753bc` vendor：
  `src/`（12 个模块，MCP server 及其全部内部依赖）、`test/`（`node --test` 套件）、
  `scripts/check-readme-links.mjs`、`scripts/acp-acceptance.mjs`、`prompts/`、`LICENSE`（MIT）。
- `scripts/sync-vendor.mjs` 与 `VENDOR.json`：从上游同步 vendor 文件并记录上游 commit 与逐文件 sha256。
- `README.md` 增加「占位符与本机配置」一节，说明 dsh 的 patch 覆盖是整体替换 `config`。

> 0.1.0 的 vendor 内容已在本版本整体移除，仅作历史记录保留。
