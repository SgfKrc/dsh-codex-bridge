/** Minimal newline-delimited JSON-RPC client for an ACP agent process. */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { cliSpawnCommand } from './config.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;
const STDERR_CAP = 8_000;

export class AcpError extends Error {
  constructor(message, { code = 'acp_error', data = null } = {}) {
    super(message);
    this.name = 'AcpError';
    this.code = code;
    this.data = data;
  }
}

function timeoutError(method, timeoutMs) {
  return new AcpError(`ACP ${method} timed out after ${timeoutMs}ms`, { code: 'timeout' });
}

function textFromUpdate(update) {
  if (!update || typeof update !== 'object') return '';
  if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') return String(update.content.text ?? '');
  if (update.sessionUpdate === 'agent_message_chunk' && typeof update.content?.text === 'string') return update.content.text;
  return '';
}

function terminateProcess(child) {
  if (!child || (child.exitCode !== null && child.exitCode !== undefined) || child.signalCode) return Promise.resolve();
  if (process.platform === 'win32' && child.pid) {
    return new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      killer.once('close', resolve);
      killer.once('error', () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } resolve(); });
    });
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
  return Promise.resolve();
}

function capability(result, name) {
  if (name === 'load' && result?.agentCapabilities?.loadSession === true) return {};
  return result?.agentCapabilities?.sessionCapabilities?.[name] ?? null;
}

/**
 * One ACP process and one or more sessions. The class is transport-only: it
 * does not persist session ids or history and never decides write policy.
 */
export class AcpClient {
  constructor({
    cliPath,
    modelRef,
    cwd,
    additionalDirectories = [],
    workspaceOnly = true,
    env = process.env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    spawnImpl = spawn,
    commandPrefix = ['acp'],
    clientInfo = { name: 'reasonix-codex-bridge', version: '0.1.0' },
    onUpdate = null,
    onRequest = null,
  } = {}) {
    if (!cliPath) throw new TypeError('cliPath is required');
    if (!modelRef) throw new TypeError('modelRef is required');
    if (!cwd) throw new TypeError('cwd is required');
    this.cliPath = cliPath;
    this.modelRef = modelRef;
    this.cwd = cwd;
    this.additionalDirectories = [...additionalDirectories];
    this.workspaceOnly = workspaceOnly !== false;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.spawnImpl = spawnImpl;
    this.commandPrefix = [...commandPrefix];
    this.clientInfo = clientInfo;
    this.onUpdate = onUpdate;
    this.onRequest = onRequest;
    this.child = null;
    this.reader = null;
    this.nextId = 1;
    this.pending = new Map();
    this.started = false;
    this.closed = false;
    this.initializeResult = null;
    this.sessions = new Set();
    this.stderr = '';
    this.stderrTruncated = false;
  }

  get capabilities() { return this.initializeResult?.agentCapabilities ?? null; }

  supportsSession(name) { return Boolean(capability(this.initializeResult, name)); }

  async start() {
    if (this.started && !this.closed) return this;
    const args = [...this.commandPrefix, '-model', this.modelRef];
    if (this.workspaceOnly) args.push('-workspace-only');
    const invocation = cliSpawnCommand(this.cliPath, args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (invocation.error) throw new AcpError(invocation.error, { code: 'spawn_rejected' });
    this.child = this.spawnImpl(invocation.file, invocation.args, invocation.options);
    if (!this.child?.stdin || !this.child?.stdout) throw new AcpError('ACP process did not expose stdio streams', { code: 'spawn_error' });
    this.started = true;
    this.closed = false;
    this.reader = createInterface({ input: this.child.stdout, terminal: false });
    this.reader.on('line', (line) => this.#handleLine(line));
    this.child.stderr?.setEncoding?.('utf8');
    this.child.stderr?.on?.('data', (chunk) => {
      if (this.stderr.length >= STDERR_CAP) { this.stderrTruncated = true; return; }
      const remaining = STDERR_CAP - this.stderr.length;
      this.stderr += String(chunk).slice(0, remaining);
      if (String(chunk).length > remaining) this.stderrTruncated = true;
    });
    this.child.once?.('error', (error) => this.#failPending(new AcpError(`cannot start ACP process: ${error.message}`, { code: 'spawn_error' })));
    this.child.once?.('close', (code, signal) => {
      if (!this.closed) this.#failPending(new AcpError(`ACP process exited before completion (code=${code ?? 'null'}, signal=${signal ?? 'none'})`, { code: 'process_exit' }));
      this.closed = true;
      this.started = false;
      this.sessions.clear();
    });
    let result;
    try {
      result = await this.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: this.clientInfo,
      });
    } catch (error) {
      await this.close();
      throw error;
    }
    if (!result?.agentCapabilities) {
      await this.close();
      throw new AcpError('ACP initialize response did not advertise agentCapabilities', { code: 'capability_missing' });
    }
    this.initializeResult = result;
    this.#sendNotification('initialized', {});
    return this;
  }

  async request(method, params = {}, timeoutMs = this.timeoutMs) {
    if (!this.child || this.closed) throw new AcpError('ACP client is not running', { code: 'not_started' });
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(timeoutError(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new AcpError(`cannot write ACP request: ${error.message}`, { code: 'write_error' }));
      }
    });
  }

  async newSession({ cwd = this.cwd, additionalDirectories = this.additionalDirectories, mcpServers = [] } = {}) {
    const params = { cwd, mcpServers };
    if (additionalDirectories.length) params.additionalDirectories = [...additionalDirectories];
    const result = await this.request('session/new', params);
    if (!result?.sessionId) throw new AcpError('ACP session/new response did not contain sessionId', { code: 'invalid_response' });
    this.sessions.add(result.sessionId);
    return result;
  }

  async loadSession(sessionId, { cwd = this.cwd, additionalDirectories = this.additionalDirectories, mcpServers = [] } = {}) {
    this.#requireSessionCapability('load', 'session/load');
    return this.#resumeLike('session/load', sessionId, { cwd, additionalDirectories, mcpServers });
  }

  async resumeSession(sessionId, { cwd = this.cwd, additionalDirectories = this.additionalDirectories, mcpServers = [] } = {}) {
    this.#requireSessionCapability('resume', 'session/resume');
    return this.#resumeLike('session/resume', sessionId, { cwd, additionalDirectories, mcpServers });
  }

  async prompt(sessionId, text, { timeoutMs = this.timeoutMs, onUpdate = this.onUpdate } = {}) {
    if (!this.sessions.has(sessionId)) this.sessions.add(sessionId);
    const updates = [];
    const previous = this.onUpdate;
    const callback = onUpdate ?? previous;
    this.onUpdate = (update, message) => {
      updates.push(update);
      if (callback !== previous) previous?.(update, message);
      callback?.(update, message);
    };
    try {
      try {
        const result = await this.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: String(text) }] }, timeoutMs);
        return { ...result, updates, text: updates.map(textFromUpdate).join('') };
      } catch (error) {
        if (error?.code === 'timeout') {
          try { await this.cancel(sessionId); } catch { /* timeout cleanup is best effort */ }
        }
        throw error;
      }
    } finally {
      this.onUpdate = previous;
    }
  }

  async cancel(sessionId, timeoutMs = Math.min(this.timeoutMs, 5_000)) {
    return this.request('session/cancel', { sessionId }, timeoutMs);
  }

  async closeSession(sessionId, timeoutMs = Math.min(this.timeoutMs, 5_000)) {
    if (!this.child || this.closed || !sessionId) return null;
    try { return await this.request('session/close', { sessionId }, timeoutMs); } finally { this.sessions.delete(sessionId); }
  }

  async deleteSession(sessionId, timeoutMs = Math.min(this.timeoutMs, 5_000)) {
    if (!this.child || this.closed || !sessionId) return null;
    this.#requireSessionCapability('delete', 'session/delete');
    try { return await this.request('session/delete', { sessionId }, timeoutMs); } finally { this.sessions.delete(sessionId); }
  }

  async close({ sessionId = null, timeoutMs = Math.min(this.timeoutMs, 5_000) } = {}) {
    if (this.closed && !this.child) return;
    if (sessionId && this.child?.stdin?.writable) {
      try { await this.request('session/close', { sessionId }, timeoutMs); } catch { /* process teardown is the final cleanup */ }
    }
    this.closed = true;
    this.#failPending(new AcpError('ACP client closed', { code: 'closed' }));
    this.reader?.close();
    try { this.child?.stdin?.end(); } catch { /* already closed */ }
    await new Promise((resolve) => {
      if (!this.child || this.child.exitCode !== null || this.child.signalCode) return resolve();
      const timer = setTimeout(resolve, 250);
      this.child.once('close', () => { clearTimeout(timer); resolve(); });
    });
    if (this.child && this.child.exitCode === null && !this.child.signalCode) await terminateProcess(this.child);
    this.child = null;
    this.started = false;
    this.sessions.clear();
  }

  /** Terminate the ACP process tree without sending session close requests. */
  async abort() {
    const child = this.child;
    this.closed = true;
    this.started = false;
    this.#failPending(new AcpError('ACP client aborted', { code: 'closed' }));
    this.reader?.close();
    try { child?.stdin?.destroy?.(); } catch { /* already closed */ }
    await terminateProcess(child);
    this.child = null;
    this.sessions.clear();
  }

  #resumeLike(method, sessionId, { cwd, additionalDirectories, mcpServers }) {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new TypeError('sessionId is required');
    const params = { sessionId: sessionId.trim(), cwd, mcpServers };
    if (additionalDirectories.length) params.additionalDirectories = [...additionalDirectories];
    return this.request(method, params).then((result) => {
      this.sessions.add(sessionId.trim());
      return result;
    });
  }

  #requireSessionCapability(name, method) {
    if (!this.initializeResult) throw new AcpError('ACP client is not initialized', { code: 'not_initialized' });
    if (!this.supportsSession(name)) throw new AcpError(`${method} is not advertised by the ACP agent`, { code: 'capability_unsupported' });
  }

  #sendNotification(method, params) {
    if (!this.child?.stdin?.writable) return;
    try { this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); } catch { /* process teardown */ }
  }

  #handleLine(line) {
    if (!String(line).trim()) return;
    let message;
    try { message = JSON.parse(line); } catch (error) { this.#failPending(new AcpError(`invalid ACP JSON: ${error.message}`, { code: 'protocol_error' })); return; }
    if (message.id !== undefined && message.id !== null && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new AcpError(message.error.message || `ACP ${pending.method} failed`, { code: message.error.code ?? 'remote_error', data: message.error.data ?? null }));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === 'session/update') {
      this.onUpdate?.(message.params?.update ?? null, message);
      return;
    }
    if (message.method === 'session/request_permission' && message.id !== undefined && message.id !== null) {
      const response = this.onRequest ? this.onRequest(message) : { outcome: { outcome: 'cancelled' } };
      Promise.resolve(response).then((result) => this.#sendResponse(message.id, result)).catch(() => this.#sendResponse(message.id, { outcome: { outcome: 'cancelled' } }));
    }
  }

  #sendResponse(id, result) {
    if (!this.child?.stdin?.writable) return;
    try { this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`); } catch { /* process teardown */ }
  }

  #failPending(error) {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

export function collectAcpText(updates) {
  return (Array.isArray(updates) ? updates : []).map(textFromUpdate).join('');
}

export function acpSpawnCommand(cliPath, modelRef, { workspaceOnly = true } = {}) {
  const args = ['acp', '-model', modelRef];
  if (workspaceOnly) args.push('-workspace-only');
  return cliSpawnCommand(cliPath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}
