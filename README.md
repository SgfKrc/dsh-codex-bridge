# dsh-codex-bridge

DSH 侧的 Reasonix DeepSeek worker 桥接器。

它把桥接器本体 **vendor 进本仓库**（`src/`，来自 `reasonix-codex-bridge`，见「vendor 与同步」），
再用一个纯 patch bundle 把这份 MCP stdio 服务通过 DSH 内置的
[`@deepseek-ai/dsh-mcp-client`](https://www.npmjs.com/package/@deepseek-ai/dsh-mcp-client)
发布为宿主原生工具。

MCP 是对称的：同一个 `server.mjs` 既能被 Codex 消费，也能被 DSH 消费。DSH 的 mcp-client
自带 stdio / Streamable-HTTP 双传输、凭据清洗（`scrubbedParentEnv`）、断线指数退避重连、
`tools/list` 变更自动重同步、命名冲突整代回滚，以及卸载即净的 effect 生命周期——因此
DSH 侧只需要声明式装配。

## 工具命名

DSH 的 mcp-client 把 MCP 工具注册为 `mcp__<serverName>__<rawName>`：

| 通道 | 子智能体档案 | 角色 | 接受的 mode |
|---|---|---|---|
| `reasonix` | `deepseek-worker` | read | `inspect` / `review` / `plan` |
| `reasonix-write` | `deepseek-worker-write` | write | `implement`（另有 `resume` / `rollback`） |

每个通道各有 7 个工具：`reasonix_run`、`reasonix_resume`、`reasonix_cancel`、
`reasonix_events`、`reasonix_rollback`、`reasonix_exec`、`reasonix_status`。

角色互斥由桥接器自身强制，双向生效（已实测）：

| | `mode=inspect` | `mode=implement` |
|---|---|---|
| `reasonix`（read） | ✅ 执行 | ⛔ `requires an explicit write-role subagent` |
| `reasonix-write`（write） | ⛔ `requires a read-role subagent; selected role is write` | ⛔ 需干净 Git 树（`cleanTreePolicy=strict`） |

## 装配

`~/.dsh/profiles/web/` 里：

- `package.json` 的 `dependencies` 加 `"dsh-codex-bridge": "link:<workspace-root>/dsh-codex-bridge"`，
  `dsh.profile.bundles` 加 `"dsh-codex-bridge"`；
- `node_modules/dsh-codex-bridge` 是指向本目录的 junction；
- 本机实际值（工作区根、CLI 路径、模型引用）在 profile 的 `cordis.patch.yml` 里按 entry id
  覆盖，见「本机配置」。

验证组装（不改动运行中的宿主）：

```powershell
node "$(npm root -g)/@deepseek-ai/dsh/lib/bin.js" --profile web --dump-config |
  Select-String -Pattern "reasonix" -Context 2,12
```

## 关键配置

**超时预算**：`mcp-client` 的 `toolCallTimeoutMs` 默认仅 60s，低于桥接器的 mode 预算
（`inspect` 600s、`review`/`plan`/`implement` 900s，硬上限 1800s），会让长任务跑到一半被客户端
切断。本 bundle 已上调到 1800000ms（1800s），让桥接器而非客户端掌握截止时间。Codex 侧是同一个
道理（`~/.codex/config.toml` 两通道各加 `tool_timeout_sec = 1800.0`）；两边独立配置，调整预算时都要同步。

**环境变量**（patch 里通过 `env` 注入，与 Codex 侧同一契约）：

| 变量 | 作用 |
|---|---|
| `REASONIX_EXE` | Reasonix CLI 路径（`v1.38.7`） |
| `REASONIX_ROOT` | 工作区根（`<workspace-root>`） |
| `REASONIX_SUBAGENT` | **决定通道角色**：`deepseek-worker`（read）/ `deepseek-worker-write`（write） |
| `REASONIX_MODEL_REF` | 模型引用，必须在 Reasonix inventory 中存在 |

**写策略**：门槛在同目录的 `bridge.config.json`（每机一份、不进仓库，用
`node src/configure.mjs use <ref>` 生成）。`implement` 需同时满足 write 档案 + `allowWrite: true`
+ `allowedPaths` 非空；越界写入与 worker 崩溃都会自动回滚。`cleanTreePolicy` 用 `snapshot`
而非 `strict`——`strict` 要求整树干净，会把写通道废掉；`snapshot` 先对 `allowedPaths` 内的脏文件
做内容快照，回滚时逐字还原，未提交的工作不会被冲掉。注意**变更检测依赖 `git status`**：被
`.gitignore` 忽略的路径即使列在 `allowedPaths` 里，`implement` 也看不到其改动（返回空 `changes`）。

## 使用

主模型调 `mcp__reasonix-write__reasonix_run`（`mode: "implement"`），桥接器返回
`qlh.reasonix.changes.v1` 变更集（每文件 sha256、`diff_stat`、增删行数）与 `rollback_id`，
**不回传 worker 原文**；是否保留由主模型决定，`mcp__reasonix-write__reasonix_rollback` 可回滚
（文件在调用后被改动过则拒绝，而非覆盖）。脏树下无需先清空工作区。

## vendor 与同步

`src/`（12 个模块）、`test/`、`scripts/check-readme-links.mjs`、`scripts/acp-acceptance.mjs`、
`prompts/`、`LICENSE` 都原样复制自
[`reasonix-codex-bridge`](https://github.com/SgfKrc/reasonix-codex-bridge)，来源与逐文件 sha256
记录在 `VENDOR.json`。**上游是唯一真源**：改了上游要重新 vendor，改了这边的副本会被 `--check`
报成 `MODIFIED` 并在更新时覆盖（本仓库自己的 `cordis.patch.yml`、`README.md`、`CHANGELOG.md`、
`package.json`、`.gitignore`、`scripts/sync-vendor.mjs` 不在 vendor 清单内）。

```powershell
node scripts/sync-vendor.mjs --check                    # 本地是否被改过 / 上游是否已漂移
node scripts/sync-vendor.mjs --update --upstream <dir>  # 从上游重新复制并更新 VENDOR.json
node --test                                             # 与上游同一套 112 个用例，零改动
```

## 本机配置

`cordis.patch.yml` 是**脱敏模板**：`args` / `env` 里的本机专属值都是占位符（`<workspace-root>`、
`<path-to-reasonix-cli.exe>`、`<reasonix-model-ref>`）。装配后在
`~/.dsh/profiles/<profile>/cordis.patch.yml` 里按 entry id 给出实际值，dsh 会在所有 bundle 层
之后应用该层。

> ⚠️ dsh 的覆盖是**整体替换 `config`**（`target[key] = value`），不是深合并：`transport` /
> `serverName` / `command` / `toolCallTimeoutMs` / `failOnStartupError` 等字段都要写全，漏写即丢
> 字段、通道不工作。直接抄本仓库 `cordis.patch.yml` 的完整结构、只替换占位符即可。

## 已知限制

- `reasonix_exec` 默认关闭（`execPolicy.configured: false`），当前无命令执行能力。
- 结构化证据以 JSON 字符串呈现，DSH 侧看到的是文本。
- `failOnStartupError: false`：Reasonix CLI 缺失时不会阻断 DSH 启动，而是重连耗尽后注销工具；
  排障看宿主日志里 `mcp-client(reasonix)` 的告警。

## 排障

不用模型就能自查：`mcp__reasonix__reasonix_status`、`mcp__reasonix-write__reasonix_status`。
它报告 `subagentRole`、`writePolicy`（`allowWrite`/`enabled`/`allowedPaths`/`cleanTreePolicy`/
`errors`）、`modelRef` 及其 `modelRefSource`（环境变量 / `bridge.config.json` / `reasonix doctor`
兜底）、`checkpoint.readyCount`。
