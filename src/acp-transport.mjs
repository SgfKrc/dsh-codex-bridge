/**
 * Opt-in ACP/per-call transport switch.
 *
 * This adapter owns only read-mode ACP sessions. Implement calls continue to
 * use the bridge's existing Git-audited path. A transport fault is isolated to
 * ACP, marks the adapter degraded, and retries the same request through the
 * explicit per-call fallback supplied by the embedding server.
 */
import { randomUUID } from 'node:crypto';
import { AcpError } from './acp-client.mjs';
import { AcpSessionCoordinator } from './acp-session.mjs';

const SECURITY_ERROR_PREFIXES = ['session_scope_', 'write_', 'read_mode_', 'mode_'];

function validSessionKey(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\r\n]/u.test(value)) {
    throw new AcpError('session_id must be a short opaque identifier', { code: 'session_scope_invalid' });
  }
  return value.trim();
}

function truncate(value, cap) {
  const text = String(value ?? '');
  if (text.length <= cap) return { text, truncated: false, originalLength: text.length };
  return { text: `${text.slice(0, cap)}\n\n[output truncated; original ${text.length} chars]`, truncated: true, originalLength: text.length };
}

function securityError(error) {
  return SECURITY_ERROR_PREFIXES.some((prefix) => String(error?.code ?? '').startsWith(prefix));
}

function transportError(error) {
  return ['spawn_rejected', 'spawn_error', 'timeout', 'process_exit', 'not_started', 'not_initialized', 'capability_missing', 'invalid_response', 'protocol_error', 'write_error', 'closed'].includes(error?.code);
}

/**
 * Coordinates ACP sessions for an embedding server. `fallback` receives the
 * original request and `{ reason, error, cancelRef }`; it must execute the
 * existing per-call path and retain its normal audit/checkpoint behavior.
 */
export class AcpTransportManager {
  constructor({ clientFactory, fallback, securityPolicy = null, outputCharCap = 24_000, owner = 'mcp-stdio', onEvent = null } = {}) {
    if (typeof clientFactory !== 'function') throw new TypeError('clientFactory is required');
    if (typeof fallback !== 'function') throw new TypeError('fallback is required');
    if (securityPolicy !== null && (typeof securityPolicy !== 'object' || typeof securityPolicy.authorizeCall !== 'function')) throw new TypeError('securityPolicy must expose authorizeCall or be null');
    if (!Number.isInteger(outputCharCap) || outputCharCap < 1) throw new RangeError('outputCharCap must be a positive integer');
    if (typeof owner !== 'string' || !owner.trim()) throw new TypeError('owner must be a non-empty string');
    this.clientFactory = clientFactory;
    this.fallback = fallback;
    this.securityPolicy = securityPolicy;
    this.outputCharCap = outputCharCap;
    this.owner = owner.trim();
    this.onEvent = onEvent;
    this.sessions = new Map();
    this.creating = new Map();
    this.closing = false;
    this.degraded = false;
    this.fallbackCount = 0;
    this.lastFallback = null;
  }

  get status() {
    return { degraded: this.degraded, persistentSessions: this.sessions.size, fallbackCount: this.fallbackCount, lastFallback: this.lastFallback ? { reason: this.lastFallback.reason, code: this.lastFallback.code } : null };
  }

  async run({ sessionId = null, taskId = null, owner = this.owner, task, mode = 'inspect', cwd, profile = '', model = '', maxSteps = null, timeoutSeconds = null, timeoutMs, outputCharCap = this.outputCharCap, cancelRef = null, requestedPaths = [] } = {}) {
    const startedAt = Date.now();
    const key = validSessionKey(sessionId);
    const scopedTaskId = taskId ?? key ?? randomUUID();
    const request = { sessionId: key, taskId: scopedTaskId, owner, task, mode, cwd, profile, model, maxSteps, timeoutSeconds, timeoutMs, outputCharCap, cancelRef, requestedPaths };
    request.startedAt = startedAt;
    if (mode === 'implement') return this.#fallback(request, 'write_mode_per_call');
    if (this.degraded || this.closing) return this.#fallback(request, 'acp_degraded');
    let entry = null;
    let ephemeral = false;
    try {
      entry = key ? this.sessions.get(key) : null;
      if (!entry && key) {
        let creation = this.creating.get(key);
        if (!creation) {
          creation = this.#createEntry(key, request);
          this.creating.set(key, creation);
        }
        try { entry = await creation; } finally {
          if (this.creating.get(key) === creation) this.creating.delete(key);
        }
      } else if (!entry) {
        entry = await this.#createEntry(null, request);
        ephemeral = true;
      }
      this.#authorize(entry, request);
      const result = await this.#enqueuePrompt(entry, request, task, timeoutMs);
      if (cancelRef?.requested) return this.#cancelled(request, entry);
      if (result?.transport === 'per_call' || result?.meta?.transport === 'per-call') {
        const reason = result.meta?.transportFallback ?? '';
        if (/^acp_(?:timeout|process_exit|spawn_|protocol_error|write_error|closed|not_started|not_initialized)/u.test(reason)) {
          this.degraded = true;
          await this.#closeEntry(entry, key);
        }
        return { ...result, meta: { ...(result.meta ?? {}), transport: 'per-call', transportFallback: result.meta?.transportFallback ?? 'acp_per_call' } };
      }
      const body = truncate(result?.text ?? '', Math.max(1, Math.min(outputCharCap, this.outputCharCap)));
      this.onEvent?.({ action: 'acp_success', sessionId: key, mode, truncated: body.truncated });
      return {
        isError: false,
        text: `[mode=${mode} cwd=${cwd} model=${model} transport=acp session=${key ?? 'ephemeral'}]\n\n${body.text || '[worker returned no content]'}`,
        meta: { outcome: 'success', transport: 'acp', sessionId: key, internalSessionId: entry.internalSessionId, outputBytes: Buffer.byteLength(body.text, 'utf8'), truncated: body.truncated, originalOutputChars: body.originalLength, elapsedMs: Date.now() - startedAt, maxSteps, timeoutSeconds },
      };
    } catch (error) {
      if (cancelRef?.requested) return this.#cancelled(request, entry);
      if (securityError(error)) throw error;
      if (!transportError(error) && !(error instanceof AcpError)) throw error;
      this.degraded = true;
      this.lastFallback = { reason: `acp_${error?.code ?? 'error'}`, code: error?.code ?? 'error' };
      this.onEvent?.({ action: 'acp_fallback', sessionId: key, reason: this.lastFallback.reason, code: this.lastFallback.code });
      if (entry) {
        await this.#closeEntry(entry, key);
      }
      return this.#fallback(request, this.lastFallback.reason, error);
    } finally {
      if (ephemeral) await this.#closeEntry(entry, null);
    }
  }

  async close() {
    this.closing = true;
    await Promise.allSettled([...this.creating.values()]);
    const entries = [...new Set(this.sessions.values())];
    this.sessions.clear();
    this.creating.clear();
    await Promise.all(entries.map((entry) => this.#closeEntry(entry, null)));
  }

  #authorize(entry, request) {
    this.securityPolicy?.authorizeCall(entry.metadata ?? entry, {
      mode: request.mode,
      role: request.mode === 'implement' ? 'write' : 'read',
      owner: request.owner,
      taskId: request.taskId,
      cwd: request.cwd,
      profile: request.profile,
      model: request.model,
      requestedPaths: request.requestedPaths,
    });
  }

  async #createEntry(key, request) {
    const metadata = { sessionId: key ?? `ephemeral-${randomUUID()}`, cwd: request.cwd, profile: request.profile, model: request.model, owner: request.owner, taskId: request.taskId };
    this.#authorize(metadata, request);
    let client = null;
    let coordinator = null;
    let entry = null;
    try {
      client = await this.clientFactory({ cwd: request.cwd, profile: request.profile, model: request.model, owner: request.owner, taskId: request.taskId, sessionId: key, timeoutMs: request.timeoutMs });
      coordinator = new AcpSessionCoordinator({
        client,
        fallbackPrompt: (text, context) => {
          const activeRequest = entry?.activeRequest ?? request;
          const reason = context.error?.code ? `acp_${context.error.code}` : `acp_${context.reason ?? 'per_call'}`;
          return this.#fallback({ ...activeRequest, task: text }, reason, context.error);
        },
        sanitizePrompt: this.securityPolicy?.sanitizeText ? this.securityPolicy.sanitizeText.bind(this.securityPolicy) : undefined,
      });
      await coordinator.start({ cwd: request.cwd });
      entry = { key, metadata, client, coordinator, internalSessionId: coordinator.sessionId, activeRequest: null, tail: Promise.resolve(), closed: false };
      if (this.closing) throw new AcpError('ACP transport manager is closing', { code: 'closed' });
      if (key) this.sessions.set(key, entry);
      return entry;
    } catch (error) {
      try { await coordinator?.close?.(); } catch { /* best effort */ }
      try { await client?.close?.(); } catch { /* best effort */ }
      throw error;
    }
  }

  async #closeEntry(entry, key) {
    if (!entry) return;
    entry.closed = true;
    if (key) this.sessions.delete(key);
    try { await entry.tail; } catch { /* prompt failure is handled by its caller */ }
    try { await entry.coordinator?.close?.(); } catch { /* best effort */ }
    try { await entry.client?.close?.(); } catch { /* best effort */ }
  }

  #cancelled(request, entry) {
    return { isError: true, text: `worker cancelled (transport=acp session=${request.sessionId ?? 'ephemeral'})`, meta: { outcome: 'cancelled', transport: 'acp', sessionId: request.sessionId, internalSessionId: entry?.coordinator?.sessionId ?? entry?.internalSessionId ?? null, exitCode: null, elapsedMs: Date.now() - request.startedAt, outputBytes: 0, truncated: false } };
  }

  #enqueuePrompt(entry, request, task, timeoutMs) {
    const cancelRef = request.cancelRef;
    let started = false;
    let settled = false;
    let cancelled = false;
    const cancel = () => {
      if (settled) return;
      cancelled = true;
      if (started) void entry.client.cancel?.(entry.coordinator?.sessionId ?? entry.internalSessionId).catch?.(() => {});
    };
    if (cancelRef && typeof cancelRef === 'object') {
      cancelRef.cancel = cancel;
      if (cancelRef.requested) cancel();
    }
    const operation = async () => {
      if (cancelled || cancelRef?.requested) return this.#cancelled(request, entry);
      if (this.degraded || entry.closed || !entry.coordinator?.started) return this.#fallback(request, 'acp_degraded');
      started = true;
      if (cancelled || cancelRef?.requested) return this.#cancelled(request, entry);
      entry.activeRequest = request;
      try {
        const result = await entry.coordinator.prompt(task, { timeoutMs });
        entry.internalSessionId = entry.coordinator.sessionId;
        return result;
      } finally {
        entry.activeRequest = null;
      }
    };
    const current = entry.tail.then(operation, operation);
    entry.tail = current.catch(() => {});
    return current.finally(() => {
      settled = true;
      if (cancelRef && typeof cancelRef === 'object' && cancelRef.cancel === cancel) cancelRef.cancel = null;
    });
  }

  async #fallback(request, reason, error = null) {
    this.fallbackCount += 1;
    this.lastFallback = { reason, code: error?.code ?? null };
    const result = await this.fallback(request, { reason, error, cancelRef: request.cancelRef });
    return { ...result, meta: { ...(result?.meta ?? {}), transport: 'per-call', transportFallback: reason } };
  }
}
