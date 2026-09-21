/**
 * DSH ACP 客户端 —— 换行分隔 JSON-RPC 2.0，驱动 `dsh --profile acp`。
 *
 * 与 `dsh-codex-bridge/src/acp-client.mjs` 对 Reasonix 的做法对齐：
 * 一个 ACP 进程承载一个或多个会话，会话可跨 `dsh_run` 调用复用（持久会话）。
 *
 * 协议要点（已实测）：
 *   initialize → { protocolVersion, agentCapabilities.sessionCapabilities }
 *   session/new({ cwd, mcpServers }) → { sessionId, configOptions }
 *   session/prompt({ sessionId, prompt:[{type:'text',text}] }) → { stopReason }
 *   中途以 session/update 通知推送 agent_message_chunk
 *   session/close({ sessionId })
 *
 * 本模块只管传输：不决定写策略、不持久化 session 归属。
 */
import { spawn } from 'node:child_process';

export class AcpError extends Error {
  constructor(message, { code = 'acp_error', data = null } = {}) {
    super(message);
    this.name = 'AcpError';
    this.code = code;
    this.data = data;
  }
}

function terminateTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { shell: false, windowsHide: true, stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch { /* 可能已退出 */ }
}

/** 从一条 session/update 通知里取出助手可见文本。 */
function textFromUpdate(update) {
  if (!update || typeof update !== 'object') return '';
  const kind = String(update.sessionUpdate ?? '').toLowerCase();
  if (kind !== 'agent_message_chunk' && kind !== 'agentmessagechunk') return '';
  const content = update.content;
  if (Array.isArray(content)) return content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('');
  return typeof content?.text === 'string' ? content.text : '';
}

export function collectAcpText(updates) {
  return (Array.isArray(updates) ? updates : []).map(textFromUpdate).join('');
}

export class AcpClient {
  #child = null;
  #buffer = '';
  #pending = new Map();
  #nextId = 1;
  #closed = false;
  #sessionId = null;
  #initResult = null;
  #updates = [];
  #collecting = false;

  constructor({ binPath, patchPath, cwd, timeoutMs = 900000 }) {
    this.binPath = binPath;
    this.patchPath = patchPath;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
  }

  get sessionId() { return this.#sessionId; }
  get updates() { return this.#updates; }

  async start() {
    if (this.#child) throw new AcpError('ACP client already started', { code: 'already_started' });
    const args = [this.binPath, '--profile', 'acp'];
    if (this.patchPath) args.push('--patch', this.patchPath);
    const child = spawn(process.execPath, args, {
      cwd: this.cwd,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    this.#child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onData(chunk));
    child.stderr.on('data', (c) => process.stderr.write(`[${'dsh-subagent-bridge'}:acp] ${c}`));
    child.once('error', (error) => this.#failAll(new AcpError(`cannot start ACP process: ${error.message}`, { code: 'spawn_error' })));
    child.once('close', (code, signal) => {
      if (!this.#closed) this.#failAll(new AcpError(`ACP process exited early (code=${code ?? 'null'}, signal=${signal ?? 'none'})`, { code: 'process_exit' }));
    });

    const init = await this.#request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    if (!init?.agentCapabilities) {
      throw new AcpError('ACP initialize response did not advertise agentCapabilities', { code: 'capability_missing' });
    }
    this.#initResult = init;
    return init;
  }

  supportsSession(name) {
    return Boolean(this.#initResult?.agentCapabilities?.sessionCapabilities?.[name]);
  }

  async newSession() {
    const result = await this.#request('session/new', { cwd: this.cwd, mcpServers: [] });
    if (!result?.sessionId) throw new AcpError('session/new did not return a sessionId', { code: 'invalid_response' });
    this.#sessionId = result.sessionId;
    return result;
  }

  /** 发送一个 prompt 并等待该轮次结束，返回收集到的助手文本。 */
  async prompt(text) {
    if (!this.#sessionId) throw new AcpError('no ACP session; call newSession() first', { code: 'no_session' });
    this.#updates = [];
    this.#collecting = true;
    try {
      const result = await this.#request('session/prompt', {
        sessionId: this.#sessionId,
        prompt: [{ type: 'text', text }],
      }, this.timeoutMs);
      return { text: collectAcpText(this.#updates), stopReason: result?.stopReason ?? null, updates: this.#updates };
    } finally {
      this.#collecting = false;
    }
  }

  async close() {
    if (this.#closed) return;
    if (this.#sessionId && this.supportsSession('close')) {
      try { await this.#request('session/close', { sessionId: this.#sessionId }, 15000); } catch { /* 尽力而为 */ }
    }
    this.#closed = true;
    terminateTree(this.#child);
    this.#failAll(new AcpError('ACP client closed', { code: 'closed' }));
  }

  abort() {
    this.#closed = true;
    terminateTree(this.#child);
    this.#failAll(new AcpError('ACP client aborted', { code: 'aborted' }));
  }

  #onData(chunk) {
    this.#buffer += chunk;
    let index;
    while ((index = this.#buffer.indexOf('\n')) !== -1) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.method === 'session/update') {
        if (this.#collecting) this.#updates.push(message.params?.update ?? message.params);
        continue;
      }
      const id = message.id;
      if (id === undefined || id === null) continue;
      const entry = this.#pending.get(id);
      if (!entry) continue;
      this.#pending.delete(id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new AcpError(message.error.message || 'ACP request failed', { code: message.error.code ?? 'remote_error', data: message.error.data ?? null }));
      } else {
        entry.resolve(message.result);
      }
    }
  }

  #request(method, params, timeoutMs) {
    if (this.#closed) return Promise.reject(new AcpError('ACP client is closed', { code: 'closed' }));
    if (!this.#child?.stdin) return Promise.reject(new AcpError('ACP process has no stdin', { code: 'not_started' }));
    const id = this.#nextId++;
    const budget = timeoutMs ?? this.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new AcpError(`ACP ${method} timed out after ${budget}ms`, { code: 'timeout' }));
      }, budget);
      this.#pending.set(id, { resolve, reject, timer, method });
      try {
        this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new AcpError(`cannot write ACP request: ${error.message}`, { code: 'write_error' }));
      }
    });
  }

  #failAll(error) {
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.#pending.clear();
  }
}
