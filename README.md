# dsh-subagent-bridge

把 **DSH headless / ACP harness 发布成 Codex 可调用的 MCP 工具** —— 零依赖的 stdio MCP server。

> **仓库沿革**：本仓库原名 `dsh-codex-bridge`，早期内容是 Reasonix worker 桥接器的
> vendor 副本（含 DSH 装配模板）。自 **v0.2.0** 起改为本桥接器：不再 vendor 任何
> Reasonix 代码，接入的 harness 也从 Reasonix 换成了 DSH 本身。旧的 vendor 内容与
> `VENDOR.json` 已移除。Git 远端仍为 `SgfKrc/dsh-codex-bridge`。

## 为什么要它

它补上了对比实验里缺的那一环。Reasonix 通道让 Codex 能通过 MCP 调用 Reasonix 子智能体；
但 DSH 侧只有一个 **CLI**（`dsh --profile headless`），Codex 无法直接调用。本桥接器把那个
CLI 包成 MCP 工具，于是 Codex 可以这样对比：

```
GPT（Codex，主控）
   ├─ 子 agent harness = DSH       → mcp__dsh_subagent__dsh_run
   └─ 子 agent harness = Reasonix  → reasonix_local / reasonix_write
```

两条链路的模型可对齐到同一个 deepseek 模型，因此**产出的差异可归因于 harness 本身**，
而不是模型。

## 工具面

刻意只有两个工具 —— 这一层的职责是"跑一个任务并拿回结果"，不是复刻 Reasonix 通道的
全套编排能力：

| 工具 | 作用 |
|---|---|
| `dsh_run` | 跑一个任务，返回子 agent 的**最终答复**；支持 `per-call`（默认）与 `acp` 两种传输 |
| `dsh_status` | 报告配置与限额，**不调用模型** |

`dsh_run` 返回结构化结果：

```json
{
  "schema": "qlh.dsh.subagent.result.v1",
  "result": "ok",
  "elapsedMs": 4597,
  "truncated": false,
  "answer": "..."
}
```

## 两种传输：per-call 与 ACP

与 Reasonix 通道的 `transport` 语义**对齐**：默认 `per-call`，ACP 需逐次显式 opt-in。

| | `per-call`（默认） | `acp` |
|---|---|---|
| 实现 | `dsh --profile headless` | `dsh --profile acp` + ACP JSON-RPC |
| 生命周期 | 一进程一任务，跑完即退 | 持久会话，可跨调用复用 |
| 上下文 | 每次全新，无记忆 | **同一 session_id 保留上下文** |
| 多轮追问 | ❌ | ✅ |
| 前置 | 无 | `DSH_ACP_ENABLED=true` |

用法：

```
# 第一次：不传 session_id ⇒ 新建会话，响应里返回 session_id
dsh_run({ task: "...", transport: "acp" })
  → { sessionId: "8f8be338-…", sessionCreated: true, turnsInSession: 1, answer: "..." }

# 后续：带上同一个 session_id ⇒ 复用会话，保留上下文
dsh_run({ task: "...", transport: "acp", session_id: "8f8be338-…" })
  → { sessionId: "8f8be338-…", sessionCreated: false, turnsInSession: 2, answer: "..." }
```

（已实测：同 id 复用、`turnsInSession` 递增。）

## ⚠️ ACP 路由必须打 patch

`dsh --profile acp` **自身**把 `dsh-acp` 的 provider/model 钉死为
`deepseek-official` / `deepseek-v4-flash`，这会**绕过** `settings.yaml` 里
`agent-default-model` 的选择。在走 `DEEPSEEK_API_KEY` + 自定义 baseURL 的本机上，
后果是 `session/prompt` 直接返回：

```
Internal error: turn failed: Authentication Fails, Your api key: ****c328 is invalid
```

注意 **`headless` 不受影响**（它读 settings 层的 `deepseek` 路由，实测正常）。
两边因此会落在**不同网关**上 —— 这会让 harness 对比失去意义。

修复方式是给 ACP 打一个按 entry id 覆盖的路由 patch（本仓库自带 `acp-route.patch.yml`）：

```yaml
- id: acp
  config:
    provider: deepseek
    model: deepseek-v4.1-flash
```

然后在环境变量里挂上它：

```toml
DSH_ACP_ENABLED = "true"
DSH_ACP_PATCH = "<workspace-root>/tools/dsh-subagent-bridge/acp-route.patch.yml"
```

**如果你换了网关或 model id，记得同步改这个 patch**，否则 ACP 会重新掉回
`deepseek-official` 并鉴权失败。

## 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `DSH_BIN` | dsh 入口（`.../@deepseek-ai/dsh/lib/bin.js`） | 自动探测：`DSH_HOME` → `NPM_CONFIG_PREFIX` → `APPDATA`/`LOCALAPPDATA` 下的全局 npm → `PATH` 上的 `dsh`/`dsh.cmd`/`dsh.ps1` |
| `DSH_MIN_VERSION` | 最低可接受的 dsh 版本；低于它拒绝启动 | `0.1.5` |
| `DSH_PROFILE` | 要启动的 profile | `headless` |
| `DSH_WORKSPACE_ROOT` | 允许的工作区根；`cwd` 不得逃出 | 进程 cwd |
| `DSH_SUBAGENT_PROVIDER` / `DSH_SUBAGENT_MODEL` | 覆盖子 agent 模型路由（仅报告用；实际路由由 profile 决定） | profile 自身默认 |
| `DSH_ACP_ENABLED` | `true` 时开放 `transport=acp` | 关闭 |
| `DSH_ACP_PATCH` | ACP 路由 patch 文件路径（见上节，**本机必需**） | 无 |
| `BRIDGE_LOG` | 给每次 `dsh_run` 追加一行 JSON 摘要 | 不写 |

`headless` profile 默认路由即 `deepseek-official` / `deepseek-flash`，无需额外配置。

## 安全与边界（fail-closed）

- **无 shell**：任务文本作为**单个 argv 元素**传给 `node <dsh bin>`，`shell:false`，
  不经过任何 shell 解释。
- **启动期拒绝**：`DSH_BIN` 指向不存在的文件时直接退出码 2，不静默降级。
- **调用期拒绝**：空任务、超长任务（>16000 字符）、逃出工作区根的 `cwd`、
  非正超时，都在 spawn 之前返回错误。
- **硬上限**：任务 16000 字符、输出 24000 字符、超时上限 1800s、并发上限 4。
- **超时整树终止**：Windows 上用 `taskkill /t /f` 杀掉整个进程树，避免留下孤儿
  （已实测验证无残留）。
- **不返回中间轨迹**：只回传子 agent 的最终答复与元数据。

## 抗升级

入口解析与版本判定都刻意不绑定具体版本：

- **入口**：候选顺序 `DSH_BIN` → `DSH_HOME/lib/bin.js` → `NPM_CONFIG_PREFIX` → `APPDATA`/`LOCALAPPDATA`
  下的全局 npm → `PATH` 上的 `dsh`/`dsh.cmd`/`dsh.ps1`。shim 一律**先取同目录的 npm 布局，再从 shim
  文本反解真实 `lib/bin.js`**（识别 `%dp0%` / `%~dp0` / `$basedir` 前缀，以及绝对与相对路径），
  因此调用方**从不需要 shell**；dsh 换安装形态、换版本都不会失联。
- **版本门**：启动时读入口所属包的 `package.json`（只认 `name === @deepseek-ai/dsh`）得到实际版本，
  与 `DSH_MIN_VERSION`（默认 `0.1.5`）比较。比较只看 `major.minor.patch`，所以 `0.1.5-rc.2` 这类
  预发布后缀不影响判定。**低于下限拒绝启动**；版本读不出来（测试桩、异常布局）只警告、不阻断 ——
  否则"起点不是 dsh 包"的合法场景会被误杀。
- 两个结果都在 `dsh_status.dsh` 里：`launcher` / `source` / `version` / `versionSource` / `minVersion` /
  `versionCheck`（`ok` / `below-minimum` / `unknown`）。

> ⚠️ **升级 dsh 后要留意 profile 层的 provider 冲突**：0.1.7-rc.1 的 `dsh-base` 新增了官方
> `llm-deepseek`（`DeepSeek Messages adapter`）entry，它会和自定义网关的 `llm-pi-ai` 争用同一个
> provider id `deepseek`。争输的一方若落到官方端点，就表现为
> `AUTH: Authentication Fails, Your api key: ****xxxx is invalid`（即使该 key 在自建网关上有效）。
> 在用到自定义网关的 profile 的 `cordis.patch.yml` 里禁用它即可：
>
> ```yaml
> - id: llm-deepseek
>   disabled: true
> ```

## 已知限制

- **`per-call` 是一次性的**：每次 `dsh_run` 都是全新的 DSH agent，不共享上下文、无多轮追问。
  需要多轮请用 `transport=acp`。
- **ACP 会话存活于桥接器进程内**：`session_id` 随桥接器重启而失效，也不跨机器。
  ACP 会话上限 8 个（`ACP_SESSION_CAP`）。
- **模型由 profile 决定**：`DSH_SUBAGENT_*` 仅在 `dsh_status` 里**如实报告**，本桥接器
  不会去改写 profile 的 `agent-default-model`。要换模型请改 profile 或 ACP 路由 patch。
- **不含权限应答**：子 agent 若遇到需要批准的操作，行为由 DSH 自身策略决定。

## 运行

```powershell
node --test          # 25 个离线用例，不联网、不调用模型
node --check src/server.mjs
```

注册到 Codex（`~/.codex/config.toml`）：

```toml
[mcp_servers.dsh_subagent]
type = "stdio"
command = "node"
args = ["<workspace-root>/tools/dsh-subagent-bridge/src/server.mjs"]
startup_timeout_sec = 30
tool_timeout_sec = 1800.0

[mcp_servers.dsh_subagent.env]
DSH_WORKSPACE_ROOT = "<workspace-root>"
DSH_PROFILE = "headless"
```

改动后需重启 Codex。
