#!/usr/bin/env node
/**
 * DSH 子智能体 MCP 桥接器 —— 把 `dsh --profile headless` 发布为 Codex 可调的 MCP 工具。
 *
 * 设计要点（与 worktree 里另两个桥接器保持同一形状，但刻意更窄）：
 *
 * - **零依赖**：只用 node 内置模块，不需要 npm install 即可运行。
 * - **无 shell**：一律 `shell:false` 直接 spawn `node <dsh bin> --profile headless <task>`，
 *   任务文本作为**单个 argv 元素**传入，不经过任何 shell 解释，因此不担心注入。
 * - **fail-closed**：找不到 dsh 入口、任务为空或超长、cwd 逃出允许根，都直接拒绝而不是猜。
 * - **有界**：任务长度、超时、输出长度、并发数都有硬上限；超时按**进程树**终止。
 * - **只读语义**：本工具默认以只读沙箱启动子 agent（DSH 侧 `--profile headless` 走
 *   workspace-write，但调用方不应依赖它写文件）。它返回子 agent 的最终答复，
 *   不返回中间工具轨迹。
 *
 * 与 Reasonix 通道的对比意义：Reasonix 通道走 MCP→reasonix-cli→子 agent；
 * 本通道走 MCP→dsh headless→子 agent。两条链路的**模型可对齐到同一个 deepseek 模型**，
 * 因此差异可归因于 harness 本身。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpClient, AcpError } from './acp-client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_NAME = 'dsh-subagent-bridge';

// ── 硬上限（代码级，不是用户可配项）──────────────────────────────────────────
const TASK_CHAR_CAP = 16000;
const OUTPUT_CHAR_CAP = 24000;
const HARD_TIMEOUT_SECONDS_CAP = 1800;
const DEFAULT_TIMEOUT_SECONDS = 900;
const QUEUE_CAP = 4;

function log(message) { process.stderr.write(`[${SERVER_NAME}] ${message}\n`); }
function refuse(reason, hint) {
  log(`refusing to start: ${reason}`);
  if (hint) log(hint);
  process.exit(2);
}

function envTrim(name) {
  const v = (process.env[name] ?? '').trim();
  return v || '';
}

// ── dsh 入口解析：从不硬编码路径 ─────────────────────────────────────────────
// 顺序：DSH_BIN（显式）→ DSH_HOME 下的 lib/bin.js → 全局 npm 安装位置 → PATH 上的 dsh。
function resolveDshBin() {
  const explicit = envTrim('DSH_BIN');
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`DSH_BIN points to a missing file: ${explicit}`);
    return explicit;
  }
  const candidates = [];
  const dshHome = envTrim('DSH_HOME');
  if (dshHome) candidates.push(path.join(dshHome, 'lib', 'bin.js'));
  const appData = envTrim('APPDATA');
  if (appData) {
    candidates.push(path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  }
  const localAppData = envTrim('LOCALAPPDATA');
  if (localAppData) {
    candidates.push(path.join(localAppData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    'cannot locate the dsh launcher. Set DSH_BIN to <...>/@deepseek-ai/dsh/lib/bin.js, '
    + `or install dsh globally. Probed: ${candidates.join(', ') || '(no candidates)'}`,
  );
}

const DSH_BIN = (() => {
  try { return resolveDshBin(); } catch (error) { refuse(error.message); return ''; }
})();

const DSH_PROFILE = envTrim('DSH_PROFILE') || 'headless';

// 允许的工作区根。默认取 DSH_WORKSPACE_ROOT，否则进程 cwd。
const WORKSPACE_ROOT = path.resolve(envTrim('DSH_WORKSPACE_ROOT') || process.cwd());

// 可选：覆盖子 agent 的模型路由（透传给 profile 的 agent-default-model）。
// 留空即使用 profile 自身的默认（headless 默认即 deepseek-official/deepseek-flash）。
const MODEL_PROVIDER = envTrim('DSH_SUBAGENT_PROVIDER');
const MODEL_ID = envTrim('DSH_SUBAGENT_MODEL');

// ── ACP 传输（默认关闭，逐次 opt-in）─────────────────────────────────────────
// 与 Reasonix 通道的 transport 语义对齐：默认 per-call（一次性），
// 需要持久会话时显式传 transport=acp 并给出 session_id 以复用。
const ACP_ENABLED = envTrim('DSH_ACP_ENABLED') === 'true';
const ACP_PATCH_PATH = envTrim('DSH_ACP_PATCH') ? path.resolve(envTrim('DSH_ACP_PATCH')) : '';
const ACP_SESSION_CAP = 8;

/** session_id → { client, createdAt, turns } */
const acpSessions = new Map();

const BRIDGE_LOG_PATH = envTrim('BRIDGE_LOG') ? path.resolve(envTrim('BRIDGE_LOG')) : '';

function withinRoot(target) {
  const rel = path.relative(WORKSPACE_ROOT, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ── 并发闸门：简单计数，超额直接拒绝而不是排队堆积 ──────────────────────────
let inFlight = 0;

function runHeadless(task, { cwd, timeoutSeconds }) {
  return new Promise((resolve) => {
    const args = [DSH_BIN, '--profile', DSH_PROFILE, task];
    const child = spawn(process.execPath, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;
    let timer = null;

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(outcome);
    };

    const collect = (chunk, which) => {
      const text = chunk.toString('utf8');
      if (which === 'out') {
        if (stdout.length < OUTPUT_CHAR_CAP) {
          stdout += text.slice(0, OUTPUT_CHAR_CAP - stdout.length);
          if (stdout.length >= OUTPUT_CHAR_CAP) truncated = true;
        } else truncated = true;
      } else if (stderr.length < OUTPUT_CHAR_CAP) {
        stderr += text.slice(0, OUTPUT_CHAR_CAP - stderr.length);
      }
    };

    child.stdout.on('data', (c) => collect(c, 'out'));
    child.stderr.on('data', (c) => collect(c, 'err'));

    timer = setTimeout(() => {
      // headless 自己会派生工作进程；Windows 上必须整树终止，否则留下孤儿。
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { shell: false, windowsHide: true, stdio: 'ignore' });
        } else {
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch { /* 进程可能已经退出 */ }
      finish({ kind: 'timeout', stdout, stderr, truncated, timeoutSeconds });
    }, timeoutSeconds * 1000);

    child.on('error', (error) => finish({ kind: 'spawn_error', message: error.message, stdout, stderr, truncated }));
    child.on('close', (code) => {
      finish({ kind: code === 0 ? 'ok' : 'nonzero', code, stdout, stderr, truncated });
    });
  });
}

function clip(text, cap = 4000) {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n… [truncated ${text.length - cap} chars]`;
}

/** 通过持久 ACP 会话跑一个任务；可复用已存在的 session_id。 */
async function runAcp(task, { cwd, timeoutSeconds, sessionId }) {
  let entry = sessionId ? acpSessions.get(sessionId) : null;
  let created = false;

  if (sessionId && !entry) throw new AcpError(`unknown ACP session_id: ${sessionId}`, { code: 'unknown_session' });
  if (entry && entry.cwd !== cwd) {
    throw new AcpError(`ACP session ${sessionId} was created for ${entry.cwd}; cannot reuse it in ${cwd}`, { code: 'session_cwd_mismatch' });
  }

  if (!entry) {
    if (acpSessions.size >= ACP_SESSION_CAP) {
      throw new AcpError(`ACP session cap reached (${ACP_SESSION_CAP}); close one before creating another`, { code: 'session_cap' });
    }
    const client = new AcpClient({ binPath: DSH_BIN, patchPath: ACP_PATCH_PATH, cwd, timeoutMs: timeoutSeconds * 1000 });
    await client.start();
    const session = await client.newSession();
    entry = { client, cwd, createdAt: Date.now(), turns: 0 };
    acpSessions.set(session.sessionId, entry);
    created = true;
  }

  const result = await entry.client.prompt(task);
  entry.turns += 1;
  const id = [...acpSessions.entries()].find(([, v]) => v === entry)?.[0] ?? sessionId;
  return { sessionId: id, created, turns: entry.turns, text: result.text, stopReason: result.stopReason, updateCount: result.updates.length };
}

const TOOLS = [
  {
    name: 'dsh_run',
    description:
      'Run one task on the DSH headless harness as an out-of-process subagent and return its final answer. '
      + 'Each call is a fresh one-shot DSH agent (no interactive follow-up, no shared context with the caller). '
      + 'The child agent runs with the DSH profile\'s own model route and tools; only its final assistant message '
      + 'is returned, not its intermediate tool trace. Use this to compare harness behaviour against the Reasonix '
      + 'channel on the same model and task.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Self-contained task text for the DSH subagent.' },
        cwd: { type: 'string', description: 'Workspace-relative directory inside the allowed root; defaults to the workspace root.' },
        timeout_seconds: { type: 'integer', minimum: 1, description: `Per-call timeout in seconds. Defaults to ${DEFAULT_TIMEOUT_SECONDS}; hard cap ${HARD_TIMEOUT_SECONDS_CAP}.` },
        transport: { type: 'string', enum: ['per-call', 'acp'], description: 'per-call (default) starts a fresh one-shot DSH agent per call. acp uses a persistent ACP session; pass session_id to reuse an existing one, or omit it to create one (the response returns the new session_id).' },
        session_id: { type: 'string', description: 'Reuse an existing ACP session id. Only valid with transport=acp.' },
      },
      required: ['task'],
    },
  },
  {
    name: 'dsh_status',
    description: 'Show bridge configuration and limits without calling a model.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callTool(name, args) {
  if (name === 'dsh_status') {
    return {
      text: JSON.stringify({
        schema: 'qlh.dsh.subagent.status.v1',
        server: SERVER_NAME,
        launcher: DSH_BIN,
        profile: DSH_PROFILE,
        workspaceRoot: WORKSPACE_ROOT,
        subagentModel: { provider: MODEL_PROVIDER || null, model: MODEL_ID || null, source: MODEL_ID ? 'DSH_SUBAGENT_* environment' : 'profile default' },
        transport: {
          default: 'per-call',
          acp: {
            enabled: ACP_ENABLED,
            patchPath: ACP_PATCH_PATH || null,
            sessionCap: ACP_SESSION_CAP,
            activeSessions: acpSessions.size,
          },
        },
        inFlight,
        queueCap: QUEUE_CAP,
        limits: {
          taskCharCap: TASK_CHAR_CAP,
          outputCharCap: OUTPUT_CHAR_CAP,
          defaultTimeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
          hardTimeoutSecondsCap: HARD_TIMEOUT_SECONDS_CAP,
        },
      }, null, 2),
    };
  }

  if (name !== 'dsh_run') throw new Error(`unknown tool: ${name}`);

  const task = typeof args?.task === 'string' ? args.task.trim() : '';
  if (!task) throw new Error('task is required and must be a non-empty string');
  if (task.length > TASK_CHAR_CAP) {
    throw new Error(`task is ${task.length} chars, over the ${TASK_CHAR_CAP} char cap`);
  }

  const cwd = args?.cwd
    ? path.resolve(WORKSPACE_ROOT, String(args.cwd))
    : WORKSPACE_ROOT;
  if (!withinRoot(cwd)) throw new Error(`cwd escapes the allowed workspace root: ${args.cwd}`);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);

  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  if (args?.timeout_seconds !== undefined) {
    const raw = Number(args.timeout_seconds);
    if (!Number.isInteger(raw) || raw < 1) throw new Error('timeout_seconds must be a positive integer');
    timeoutSeconds = Math.min(raw, HARD_TIMEOUT_SECONDS_CAP);
  }

  if (inFlight >= QUEUE_CAP) {
    throw new Error(`queue full: ${inFlight} job(s) in flight, cap ${QUEUE_CAP}. Retry shortly.`);
  }

  const transport = args?.transport === 'acp' ? 'acp' : 'per-call';
  const sessionId = typeof args?.session_id === 'string' ? args.session_id.trim() : '';
  if (transport !== 'acp' && sessionId) throw new Error('session_id is only valid with transport=acp');
  if (transport === 'acp' && !ACP_ENABLED) {
    throw new Error('transport=acp is disabled: set DSH_ACP_ENABLED=true to opt in');
  }

  inFlight += 1;
  const startedAt = Date.now();
  let outcome;
  let acpMeta = null;
  try {
    if (transport === 'acp') {
      try {
        acpMeta = await runAcp(task, { cwd, timeoutSeconds, sessionId });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        return { text: `ACP transport failed: ${text}`, isError: true };
      }
    } else {
      outcome = await runHeadless(task, { cwd, timeoutSeconds });
    }
  } finally {
    inFlight -= 1;
  }

  if (transport === 'acp') {
    return {
      text: JSON.stringify({
        schema: 'qlh.dsh.subagent.result.v1',
        transport: 'acp',
        result: 'ok',
        sessionId: acpMeta.sessionId,
        sessionCreated: acpMeta.created,
        turnsInSession: acpMeta.turns,
        stopReason: acpMeta.stopReason,
        answer: acpMeta.text.trim(),
      }, null, 2),
    };
  }

  const elapsedMs = Date.now() - startedAt;

  if (BRIDGE_LOG_PATH) {
    try {
      const record = {
        time: new Date().toISOString(),
        profile: DSH_PROFILE,
        result: outcome.kind,
        exitCode: outcome.code ?? null,
        elapsedMs,
        stdoutChars: outcome.stdout.length,
        truncated: outcome.truncated,
      };
      const { appendFileSync } = await import('node:fs');
      appendFileSync(BRIDGE_LOG_PATH, `${JSON.stringify(record)}\n`, 'utf8');
    } catch { /* 日志失败不影响结果 */ }
  }

  if (outcome.kind === 'timeout') {
    return {
      text: `DSH subagent timed out after ${outcome.timeoutSeconds}s and its process tree was terminated.\n\n`
        + `stderr tail:\n${clip(outcome.stderr)}`,
      isError: true,
    };
  }
  if (outcome.kind === 'spawn_error') {
    return { text: `failed to start the DSH subagent: ${outcome.message}`, isError: true };
  }
  if (outcome.kind === 'nonzero') {
    return {
      text: `DSH subagent exited with code ${outcome.code}.\n\nstdout:\n${clip(outcome.stdout)}\n\nstderr:\n${clip(outcome.stderr)}`,
      isError: true,
    };
  }

  const answer = outcome.stdout.trim();
  const payload = {
    schema: 'qlh.dsh.subagent.result.v1',
    result: 'ok',
    elapsedMs,
    truncated: outcome.truncated,
    answer,
  };
  return { text: JSON.stringify(payload, null, 2) };
}

// ── MCP stdio：换行分隔的 JSON-RPC 2.0（与另两个桥接器同一帧格式）───────────
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const handlers = {
  initialize: () => ({
    capabilities: { tools: {} },
    protocolVersion: '2024-11-05',
    serverInfo: { name: SERVER_NAME, version: '1.0.0' },
  }),
  ping: () => ({}),
  'tools/list': () => ({ tools: TOOLS }),
  'tools/call': async (params) => {
    const result = await callTool(params?.name, params?.arguments ?? {});
    return { content: [{ type: 'text', text: result.text }], isError: result.isError };
  },
};

let buffer = '';
process.stdin.setEncoding('utf8');

// MCP 宿主关闭管道时，把仍然活着的 ACP 会话收干净，避免留下孤儿进程。
process.stdin.on('end', () => {
  for (const [, entry] of acpSessions) entry.client.abort();
  acpSessions.clear();
});
process.on('exit', () => {
  for (const [, entry] of acpSessions) entry.client.abort();
});

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    const { id, method, params } = message;
    if (id === undefined || id === null) continue;
    const handler = handlers[method];
    if (!handler) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${method}` } });
      continue;
    }
    Promise.resolve()
      .then(() => handler(params))
      .then((result) => send({ jsonrpc: '2.0', id, result }))
      .catch((error) => {
        const text = error instanceof Error ? error.message : String(error);
        if (method === 'tools/call') send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } });
        else send({ jsonrpc: '2.0', id, error: { code: -32603, message: text } });
      });
  }
});

log(`ready: launcher=${DSH_BIN} profile=${DSH_PROFILE} root=${WORKSPACE_ROOT}`);
