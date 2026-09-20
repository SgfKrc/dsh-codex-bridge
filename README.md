# dsh-codex-bridge

DSH 侧的 Reasonix DeepSeek worker 桥接器。

它**不含任何运行时代码**——是一个纯 patch bundle，把已经跑通的
`reasonix-codex-bridge/src/server.mjs`（MCP stdio 服务）通过 DSH 内置的
[`@deepseek-ai/dsh-mcp-client`](https://www.npmjs.com/package/@deepseek-ai/dsh-mcp-client)
发布为宿主原生工具。

## 为什么能这么做

`reasonix-codex-bridge` 实现的是 **MCP 协议服务端**，而 MCP 是对称的：
同一个 `server.mjs` 既能被 Codex 消费，也能被 DSH 消费。DSH 已内置生产级 MCP
客户端（791 行），自带：

- stdio / Streamable-HTTP 双传输
- 凭据清洗（`scrubbedParentEnv`，剔除凭据形状与陈旧 `DSH_*` 变量）
- 断线指数退避重连（默认 10 次，上限 30s）
- `tools/list` 变更通知自动重同步
- 命名冲突时整代回滚
- effect 作用域生命周期（卸载即净、HMR 热替换）

因此**桥接器本体 100% 复用，DSH 侧只需声明式装配**。

## 工具命名

DSH 的 mcp-client 把 MCP 工具注册为 `mcp__<serverName>__<rawName>`：

| 通道 | 子智能体档案 | 角色 | 接受的 mode | 工具名示例 |
|---|---|---|---|---|
| `reasonix` | `deepseek-worker` | read | `inspect` / `review` / `plan` | `mcp__reasonix__reasonix_run` |
| `reasonix-write` | `deepseek-worker-write` | write | `implement`（另有 `resume` / `rollback`） | `mcp__reasonix-write__reasonix_run` |

每个通道各有 7 个工具：`reasonix_run`、`reasonix_resume`、`reasonix_cancel`、
`reasonix_events`、`reasonix_rollback`、`reasonix_exec`、`reasonix_status`。

**角色互斥由桥接器自身强制，双向生效**（已实测）：

| | `mode=inspect` | `mode=implement` |
|---|---|---|
| `reasonix`（read） | ✅ 执行 | ⛔ `requires an explicit write-role subagent` |
| `reasonix-write`（write） | ⛔ `requires a read-role subagent; selected role is write` | ⛔ 需干净 Git 树（`cleanTreePolicy=strict`） |

## 装配

已在 `~/.dsh/profiles/web/` 注册：

- `package.json` → `dependencies` 加 `"dsh-codex-bridge": "link:<workspace-root>/dsh-codex-bridge"`
- `package.json` → `dsh.profile.bundles` 加 `"dsh-codex-bridge"`
- `node_modules/dsh-codex-bridge` → 指向本目录的 junction

验证组装（不改动运行中的宿主）：

```powershell
node "$(npm root -g)/@deepseek-ai/dsh/lib/bin.js" `
  --profile web --dump-config | Select-String -Pattern "reasonix" -Context 2,12
```

## 关键配置

### 超时预算（易踩坑）

`mcp-client` 的 `toolCallTimeoutMs` **默认仅 60s**，而桥接器各 mode 的预算是
`inspect` 600s、`review`/`plan`/`implement` 900s（硬上限 1800s）。本 bundle 已把它
上调到 **1800000ms（1800s）**，让**桥接器而非 MCP 客户端**掌握截止时间。若沿用默认值，
长任务会在跑到一半时被客户端切断。

**Codex 侧有完全同类的问题，且同样已修**：Codex 的 MCP 工具超时回落到常量
`DEFAULT_TOOL_TIMEOUT = 300s`（`codex-rs/codex-mcp/src/rmcp_client.rs`），低于桥接器的
600s/900s。`~/.codex/config.toml` 的两个通道已各加 `tool_timeout_sec = 1800.0`。

两边是**独立配置、同一个道理**：宿主侧的调用超时必须 ≥ 桥接器的 mode 预算，否则
worker 还在跑就被宿主掐断，表现为没有 checkpoint、没有结构化证据的"无故中断"。
调整桥接器预算时，这两处都要同步。

### 环境变量

patch 里通过 `env` 注入，与 Codex 侧完全一致的契约：

| 变量 | 作用 |
|---|---|
| `REASONIX_EXE` | Reasonix CLI 路径（`v1.38.7`） |
| `REASONIX_ROOT` | 工作区根（`<workspace-root>`） |
| `REASONIX_SUBAGENT` | **决定通道角色**：`deepseek-worker`（read）/ `deepseek-worker-write`（write） |
| `REASONIX_MODEL_REF` | 模型引用，必须在 Reasonix inventory 中存在 |

### 写策略

写门槛在 `reasonix-codex-bridge/bridge.config.json`（每机一份）：

```json
{
  "allowWrite": true,
  "allowedPaths": ["packages", "apps", "scripts", "tests", "docs", "tools"],
  "cleanTreePolicy": "snapshot"
}
```

`implement` 需**三条件同时成立**：write 档案 + `allowWrite: true` + `allowedPaths`
非空。写入越界（落在 `allowedPaths` 之外）会**自动回滚**并报 `write_rejected`；
worker 崩溃同样回滚，不留半成品。

**`cleanTreePolicy` 为什么是 `snapshot` 而不是 `strict`**：agent 工作区几乎总是脏的，
`strict`（要求整树干净）会把写通道实际废掉。`snapshot` 在调用前对 `allowedPaths` 内
既有脏文件做**内容快照**，回滚时逐字还原用户改动，而不是 `git restore` 回 HEAD——
所以未提交的工作不会被冲掉。容量上限：单文件 8MB、合计 32MB、最多 64 个既有脏文件，
超限 fail-closed 拒绝并提示先 commit/stash。

**变更检测依赖 `git status`**：被 `.gitignore` 忽略的路径（本仓库的 `tools/`、
`docs_wiki/`、`local_docs/`、`release/`）即使列在 `allowedPaths` 里，`implement` 也
**看不到**其改动，会返回空 `changes` 与 `rollback_id: null`。这是已实测的坑。

## 使用

主模型调 `mcp__reasonix-write__reasonix_run`，`mode: "implement"`；桥接器返回
`qlh.reasonix.changes.v1` 变更集（含每文件 sha256、`diff_stat`、增删行数）与
`rollback_id`，**不回传 worker 原文**。是否保留由主模型决定，可用
`mcp__reasonix-write__reasonix_rollback` 回滚——若文件在调用后被改动过，回滚会被
**拒绝**而非覆盖。

无需先清空工作区：`snapshot` 模式已实测可在脏树下正常写入并精确回滚。

## 占位符与本机配置

本仓库的 `cordis.patch.yml` 是**脱敏模板**——`args` / `env` 里的本机专属值都是占位符
（`<workspace-root>`、`<path-to-reasonix-cli.exe>`、`<reasonix-model-ref>`），仓库因此不含
任何一台机器的绝对路径。装配后请在 **profile 的 patch 层**给出实际值；dsh 会在所有 bundle 层
之后应用它，并按 entry id 定位：

`~/.dsh/profiles/web/cordis.patch.yml`

```yaml
- id: reasonix-mcp-read
  config:
    transport: stdio
    serverName: reasonix
    command: node
    args:
      - '<workspace-root>/reasonix-codex-bridge/src/server.mjs'
    env:
      REASONIX_EXE: '<path-to-reasonix-cli.exe>'
      REASONIX_ROOT: '<workspace-root>'
      REASONIX_SUBAGENT: deepseek-worker
      REASONIX_MODEL_REF: '<reasonix-model-ref>'
    toolCallTimeoutMs: 1800000
    failOnStartupError: false
```

write 通道同形，只改两处：`serverName: reasonix-write`、`REASONIX_SUBAGENT: deepseek-worker-write`。

> ⚠️ dsh 的覆盖是**整体替换 `config`**（`target[key] = value`），不是深合并。覆盖时必须把要保留
> 的字段写全（`transport` / `serverName` / `command` / `toolCallTimeoutMs` / `failOnStartupError`），
> 漏写的字段会丢失，通道随即不工作。

改完用同一份配置自检（不改动运行中的宿主）：

```powershell
node "$(npm root -g)/@deepseek-ai/dsh/lib/bin.js" --profile web --dump-config |
  Select-String -Pattern "reasonix" -Context 2,12
```

## 已知限制

- **`reasonix_exec` 默认关闭**（`execPolicy.configured: false`），当前无命令执行能力。
- **gitignore 路径写不进去**：见上文变更检测说明。
- **结构化证据以 JSON 字符串呈现**：DSH 侧看到的是文本，渲染体验不如 Codex 原生。
- **仓库里的 patch 是脱敏模板**：`args` / `env` 的值是占位符，本机实际值放在 profile 的
  `cordis.patch.yml`（见下文「占位符与本机配置」）。
- **`failOnStartupError: false`**：Reasonix CLI 缺失时桥接器不会阻断 DSH 启动，
  而是重连耗尽后注销工具。排障时看宿主日志中 `mcp-client(reasonix)` 的告警。

## 排障

```powershell
# 桥接器配置与角色（无需模型）
mcp__reasonix__reasonix_status
mcp__reasonix-write__reasonix_status
```

`reasonix_status` 报告 `subagentRole`、`writePolicy`（`allowWrite`/`enabled`/
`allowedPaths`/`cleanTreePolicy`/`errors`）、`modelRef` 及其来源、`checkpoint.readyCount`。

`modelRefSource` 会显示模型引用的解析来源（环境变量 / `bridge.config.json` /
`reasonix doctor` 兜底）。
