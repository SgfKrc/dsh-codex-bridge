/**
 * Opt-in ACP session registry and lifecycle coordinator.
 *
 * The production MCP server remains per-call by default. This module keeps
 * session metadata durable without persisting prompts, responses, or secrets,
 * serializes work per session, and makes resume/cleanup explicit to its caller.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AcpError } from './acp-client.mjs';
import { normalizeSessionScope } from './acp-security.mjs';

export const ACP_REGISTRY_SCHEMA = 'qlh.reasonix.sessions.v1';

function clone(value) {
  return structuredClone(value);
}

function errorCode(error) {
  return error?.code ?? 'error';
}

function validateSessionId(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('sessionId is required');
  return value.trim();
}

function validateMetadata({ sessionId, cwd, profile, model, owner, taskId, scope }, { scopeRequired = false } = {}) {
  const normalizedScope = normalizeSessionScope({ owner, taskId, scope }, { required: scopeRequired });
  return {
    sessionId: validateSessionId(sessionId),
    cwd: typeof cwd === 'string' ? cwd : '',
    profile: typeof profile === 'string' ? profile : '',
    model: typeof model === 'string' ? model : '',
    ...normalizedScope,
  };
}

function publicEntry(entry) {
  return {
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    profile: entry.profile,
    model: entry.model,
    state: entry.state,
    createdAt: entry.createdAt,
    lastUsedAt: entry.lastUsedAt,
    closedAt: entry.closedAt ?? null,
    ...(entry.owner && entry.taskId ? { scope: { owner: entry.owner, taskId: entry.taskId } } : {}),
  };
}

function parseStore(raw, statePath) {
  let data;
  try { data = JSON.parse(raw); } catch (error) { throw new AcpError(`ACP registry is invalid JSON: ${error.message}`, { code: 'registry_invalid' }); }
  if (data?.schema !== ACP_REGISTRY_SCHEMA || !Array.isArray(data.sessions)) throw new AcpError(`ACP registry schema mismatch: ${statePath}`, { code: 'registry_invalid' });
  return data.sessions.map((item) => {
    const metadata = validateMetadata(item ?? {});
    return {
      ...metadata,
      state: item.state === 'closed' ? 'closed' : 'orphaned',
      createdAt: Number.isFinite(item.createdAt) ? item.createdAt : 0,
      lastUsedAt: Number.isFinite(item.lastUsedAt) ? item.lastUsedAt : 0,
      closedAt: Number.isFinite(item.closedAt) ? item.closedAt : null,
    };
  });
}

/**
 * Registry for ACP sessions. A registry entry never contains a task body or a
 * client object on disk. `clientFactory` is supplied by the embedding layer so
 * resume can recreate a transport with the current executable and policy.
 */
export class AcpSessionRegistry {
  constructor({ statePath = null, clientFactory = null, now = () => Date.now(), onEvent = null, scopeRequired = false, securityPolicy = null } = {}) {
    if (statePath !== null && typeof statePath !== 'string') throw new TypeError('statePath must be a string or null');
    if (clientFactory !== null && typeof clientFactory !== 'function') throw new TypeError('clientFactory must be a function or null');
    if (typeof scopeRequired !== 'boolean') throw new TypeError('scopeRequired must be boolean');
    if (securityPolicy !== null && (typeof securityPolicy !== 'object' || typeof securityPolicy.authorizeCall !== 'function')) throw new TypeError('securityPolicy must expose authorizeCall or be null');
    this.statePath = statePath ? path.resolve(statePath) : null;
    this.clientFactory = clientFactory;
    this.now = now;
    this.onEvent = onEvent;
    this.scopeRequired = scopeRequired;
    this.securityPolicy = securityPolicy;
    this.entries = new Map();
    this.#load();
  }

  get size() { return this.entries.size; }

  list({ includeClosed = true } = {}) {
    return [...this.entries.values()]
      .filter((entry) => includeClosed || entry.state !== 'closed')
      .map((entry) => publicEntry(this.#effectiveState(entry)));
  }

  async create({ client, cwd, profile, model, owner, taskId, scope, sessionOptions = {} } = {}) {
    if (!client || typeof client.newSession !== 'function') throw new TypeError('client with newSession is required');
    const normalizedScope = normalizeSessionScope({ owner, taskId, scope }, { required: this.scopeRequired });
    try {
      await client.start?.();
      const result = await client.newSession(sessionOptions);
      const metadata = validateMetadata({ sessionId: result?.sessionId, cwd, profile, model, ...normalizedScope }, { scopeRequired: this.scopeRequired });
      return this.register({ ...metadata, client });
    } catch (error) {
      try { await client.close?.(); } catch { /* best effort teardown */ }
      throw error;
    }
  }

  register({ client, sessionId, cwd, profile, model, owner, taskId, scope, createdAt = this.now(), lastUsedAt = createdAt } = {}) {
    if (!client) throw new TypeError('client is required');
    const metadata = validateMetadata({ sessionId, cwd, profile, model, owner, taskId, scope }, { scopeRequired: this.scopeRequired });
    if (this.entries.has(metadata.sessionId)) throw new AcpError(`ACP session is already registered: ${metadata.sessionId}`, { code: 'session_exists' });
    const entry = { ...metadata, client, state: 'active', createdAt, lastUsedAt, closedAt: null, tail: Promise.resolve() };
    this.entries.set(entry.sessionId, entry);
    try { this.#persist(); } catch (error) { this.entries.delete(entry.sessionId); throw error; }
    return publicEntry(entry);
  }

  async prompt(sessionId, text, options = {}) {
    const entry = this.#requireEntry(sessionId);
    const { owner, taskId, scope, ...clientOptions } = options && typeof options === 'object' ? options : {};
    this.#assertScope(entry, { owner, taskId, scope });
    this.#authorizeCall(entry, { ...clientOptions, owner, taskId, scope });
    return this.#enqueue(entry, async () => {
      this.#requireActive(entry);
      this.#assertScope(entry, { owner, taskId, scope });
      this.#authorizeCall(entry, { ...clientOptions, owner, taskId, scope });
      const result = await entry.client.prompt(entry.sessionId, text, clientOptions);
      entry.lastUsedAt = this.now();
      this.#persist();
      this.#emit('prompt', entry, { ok: true });
      return result;
    });
  }

  async resume(sessionId, { clientFactory = this.clientFactory, load = false, sessionOptions = {} } = {}) {
    const id = validateSessionId(sessionId);
    const entry = this.#requireEntry(id);
    return this.#enqueue(entry, () => this.#resumeEntry(entry, { clientFactory, load, sessionOptions }));
  }

  async close(sessionId) {
    const entry = this.#requireEntry(sessionId);
    return this.#enqueue(entry, async () => {
      if (entry.state === 'closed') return publicEntry(entry);
      entry.state = 'closing';
      this.#persist();
      try {
        await entry.client?.closeSession?.(entry.sessionId);
        await entry.client?.close?.();
      } catch (error) {
        entry.state = this.#isClientLive(entry) ? 'active' : 'orphaned';
        this.#persist();
        this.#emit('close', entry, { ok: false, errorCode: errorCode(error) });
        throw error;
      }
      entry.state = 'closed';
      entry.closedAt = this.now();
      this.#persist();
      this.#emit('close', entry, { ok: true });
      return publicEntry(entry);
    });
  }

  async delete(sessionId, { clientFactory = this.clientFactory, sessionOptions = {} } = {}) {
    const entry = this.#requireEntry(sessionId);
    return this.#enqueue(entry, async () => {
      if (!entry.client || !this.#isClientLive(entry)) {
        await this.#resumeEntry(entry, { clientFactory, load: false, sessionOptions });
      }
      if (!entry.client?.supportsSession?.('delete')) throw new AcpError('ACP agent does not advertise session/delete', { code: 'capability_unsupported' });
      entry.state = 'closing';
      this.#persist();
      try {
        await entry.client?.closeSession?.(entry.sessionId);
        await entry.client.deleteSession(entry.sessionId);
        await entry.client?.close?.();
      } catch (error) {
        entry.state = this.#isClientLive(entry) ? 'active' : 'orphaned';
        this.#persist();
        this.#emit('delete', entry, { ok: false, errorCode: errorCode(error) });
        throw error;
      }
      this.entries.delete(entry.sessionId);
      this.#persist();
      this.#emit('delete', entry, { ok: true });
      return { sessionId: entry.sessionId, state: 'deleted' };
    });
  }

  async shutdown() {
    const entries = [...this.entries.values()].filter((entry) => entry.state !== 'closed');
    const results = await Promise.all(entries.map(async (entry) => {
      try { return await this.close(entry.sessionId); } catch (error) { return { sessionId: entry.sessionId, state: 'orphaned', errorCode: errorCode(error) }; }
    }));
    return { closed: results.filter((item) => item.state === 'closed').map((item) => item.sessionId), errors: results.filter((item) => item.state !== 'closed') };
  }

  installProcessHandlers(processLike = process) {
    if (!processLike || typeof processLike.on !== 'function') throw new TypeError('processLike must expose on/removeListener');
    let shuttingDown = false;
    const handler = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      void this.shutdown();
    };
    processLike.on('beforeExit', handler);
    processLike.on('SIGINT', handler);
    processLike.on('SIGTERM', handler);
    return () => {
      processLike.removeListener?.('beforeExit', handler);
      processLike.removeListener?.('SIGINT', handler);
      processLike.removeListener?.('SIGTERM', handler);
    };
  }

  #load() {
    if (!this.statePath) return;
    let raw;
    try { raw = readFileSync(this.statePath, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') return;
      throw new AcpError(`cannot read ACP registry: ${error.message}`, { code: 'registry_unreadable' });
    }
    for (const entry of parseStore(raw, this.statePath)) {
      if (!this.entries.has(entry.sessionId)) this.entries.set(entry.sessionId, { ...entry, client: null, tail: Promise.resolve() });
    }
  }

  async #resumeEntry(entry, { clientFactory, load, sessionOptions }) {
    if (entry.state === 'active' && this.#isClientLive(entry)) return publicEntry(entry);
    if (typeof clientFactory !== 'function') throw new AcpError('ACP registry has no clientFactory for resume', { code: 'resume_unavailable' });
    const client = await clientFactory(publicEntry(entry));
    if (!client || typeof client.start !== 'function') throw new AcpError('ACP clientFactory returned an invalid client', { code: 'resume_unavailable' });
    try {
      await client.start();
      const canResume = client.supportsSession?.('resume');
      const canLoad = client.supportsSession?.('load');
      if (load ? canLoad : canResume || canLoad) {
        if (!load && canResume) await client.resumeSession(entry.sessionId, sessionOptions);
        else if (canLoad) await client.loadSession(entry.sessionId, sessionOptions);
        else throw new AcpError('ACP agent advertises neither resume nor load', { code: 'capability_unsupported' });
      } else {
        throw new AcpError('ACP agent does not advertise session resume/load', { code: 'capability_unsupported' });
      }
    } catch (error) {
      try { await client.close?.(); } catch { /* best effort teardown */ }
      throw error;
    }
    entry.client = client;
    entry.state = 'active';
    entry.lastUsedAt = this.now();
    entry.closedAt = null;
    this.#persist();
    this.#emit('resume', entry, { ok: true, load: Boolean(load) });
    return publicEntry(entry);
  }

  #persist() {
    if (!this.statePath) return;
    mkdirSync(path.dirname(this.statePath), { recursive: true });
    const data = JSON.stringify({ schema: ACP_REGISTRY_SCHEMA, version: 1, sessions: [...this.entries.values()].map(publicEntry) }, null, 2);
    const temporary = `${this.statePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    writeFileSync(temporary, `${data}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, this.statePath);
  }

  #requireEntry(sessionId) {
    const id = validateSessionId(sessionId);
    const entry = this.entries.get(id);
    if (!entry) throw new AcpError(`ACP session is not registered: ${id}`, { code: 'session_not_found' });
    return entry;
  }

  #requireActive(entry) {
    if (entry.state !== 'active') throw new AcpError(`ACP session is not active: ${entry.sessionId}`, { code: 'session_not_active' });
    if (!this.#isClientLive(entry)) {
      entry.state = 'orphaned';
      this.#persist();
      throw new AcpError(`ACP session transport is not running: ${entry.sessionId}`, { code: 'session_orphaned' });
    }
  }

  #assertScope(entry, request) {
    const expected = normalizeSessionScope(entry, { required: this.scopeRequired });
    const actual = normalizeSessionScope(request, { required: this.scopeRequired || Boolean(expected.owner || expected.taskId) });
    if (expected.owner !== actual.owner || expected.taskId !== actual.taskId) {
      throw new AcpError(`ACP session scope does not match caller/task: ${entry.sessionId}`, { code: 'session_scope_mismatch' });
    }
  }

  #authorizeCall(entry, options) {
    this.securityPolicy?.authorizeCall(entry, options);
  }

  #isClientLive(entry) {
    return Boolean(entry.client && (entry.client.started === undefined || entry.client.started === true) && entry.client.closed !== true);
  }

  #effectiveState(entry) {
    if (entry.state === 'active' && entry.client && !this.#isClientLive(entry)) return { ...entry, state: 'orphaned' };
    return entry;
  }

  #enqueue(entry, operation) {
    const current = entry.tail.then(operation, operation);
    entry.tail = current.catch(() => {});
    return current;
  }

  #emit(action, entry, details) {
    this.onEvent?.({ action, sessionId: entry.sessionId, ...details });
  }
}
