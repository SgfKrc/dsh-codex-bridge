/**
 * ACP session budget coordinator.
 *
 * This module is used by the opt-in ACP transport manager. It owns adapter
 * history and turns the pure ACP budget prototype into an explicit,
 * transactional flow while retaining a stateless fallback.
 */
import { AcpError } from './acp-client.mjs';
import {
  ACP_COMPACT_TRIGGER_RATIO,
  ACP_HISTORY_HARD_CAP_BYTES,
  historyBytes,
  prepareSessionContinuation,
} from './acp-prototype.mjs';
import { scrubAcpContent } from './acp-security.mjs';

const DEFAULT_SUMMARY_MESSAGE_CAP = 512;
const DEFAULT_SUMMARY_CAP = 12_000;

function clone(value) {
  return structuredClone(value);
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (message?.content === undefined || message?.content === null) return '';
  return JSON.stringify(message.content);
}

/** Create a deterministic, bounded summary without an additional model call. */
export function summarizeAcpMessages(messages, {
  perMessageCap = DEFAULT_SUMMARY_MESSAGE_CAP,
  maxChars = DEFAULT_SUMMARY_CAP,
} = {}) {
  if (!Array.isArray(messages)) throw new TypeError('messages must be an array');
  if (!Number.isInteger(perMessageCap) || perMessageCap < 1) throw new RangeError('perMessageCap must be a positive integer');
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new RangeError('maxChars must be a positive integer');
  const lines = [];
  for (const [index, message] of messages.entries()) {
    const role = typeof message?.role === 'string' && message.role.trim() ? message.role.trim() : 'unknown';
    const normalized = messageText(message).replace(/\s+/gu, ' ').trim();
    const snippet = normalized.length > perMessageCap ? `${normalized.slice(0, perMessageCap - 1)}...` : normalized;
    lines.push(`${index + 1}. ${role}: ${snippet}`);
  }
  const result = lines.join('\n');
  return result.length > maxChars ? `${result.slice(0, maxChars - 3)}...` : result;
}

function historyEnvelope(messages) {
  return messages.map((message, index) => {
    const role = typeof message?.role === 'string' ? message.role : 'unknown';
    return `[message ${index + 1} role=${role}]\n${messageText(message)}`;
  }).join('\n\n');
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Coordinates one ACP session while keeping the server's stateless fallback
 * explicit. The fallback receives the next user message and never receives a
 * mutable reference to adapter history.
 */
export class AcpSessionCoordinator {
  constructor({
    client,
    summarize = summarizeAcpMessages,
    fallbackPrompt = null,
    hardCapBytes = ACP_HISTORY_HARD_CAP_BYTES,
    compactTriggerRatio = ACP_COMPACT_TRIGGER_RATIO,
    preserveRecent = 2,
    now = () => Date.now(),
    onDecision = null,
    sanitizePrompt = (value) => value,
  } = {}) {
    if (!client || typeof client.newSession !== 'function' || typeof client.prompt !== 'function') throw new TypeError('client with newSession and prompt is required');
    if (typeof summarize !== 'function') throw new TypeError('summarize must be a function');
    if (fallbackPrompt !== null && typeof fallbackPrompt !== 'function') throw new TypeError('fallbackPrompt must be a function');
    if (typeof sanitizePrompt !== 'function') throw new TypeError('sanitizePrompt must be a function');
    this.client = client;
    this.summarize = summarize;
    this.fallbackPrompt = fallbackPrompt;
    this.hardCapBytes = hardCapBytes;
    this.compactTriggerRatio = compactTriggerRatio;
    this.preserveRecent = preserveRecent;
    this.now = now;
    this.onDecision = onDecision;
    this.sanitizePrompt = sanitizePrompt;
    this.sessionId = null;
    this.history = [];
    this.decisionLog = [];
    this.started = false;
  }

  get currentHistory() { return clone(this.history); }
  get decisions() { return clone(this.decisionLog); }

  async start(options = {}) {
    if (this.started && this.sessionId) return this.sessionId;
    await this.client.start?.();
    const session = await this.client.newSession(options);
    if (!session?.sessionId) throw new AcpError('ACP coordinator could not create a session', { code: 'invalid_response' });
    this.sessionId = session.sessionId;
    this.history = [];
    this.started = true;
    return this.sessionId;
  }

  async prompt(text, { role = 'user', timeoutMs } = {}) {
    if (!this.started || !this.sessionId) throw new AcpError('ACP coordinator is not started', { code: 'not_started' });
    const nextMessage = { role, content: String(this.sanitizePrompt(text)) };
    const beforeBytes = historyBytes(this.history);
    const candidateBytes = historyBytes([...this.history, nextMessage]);
    const startedAt = this.now();
    const decision = prepareSessionContinuation(this.history, nextMessage, {
      hardCapBytes: this.hardCapBytes,
      compactTriggerRatio: this.compactTriggerRatio,
      summarize: this.summarize,
      preserveRecent: this.preserveRecent,
    });
    try {
      if (decision.action === 'append') return await this.#append(decision, nextMessage, timeoutMs, { beforeBytes, candidateBytes, startedAt });
      if (decision.action === 'compact' || decision.action === 'rotate') return await this.#replaceSession(decision, nextMessage, timeoutMs, { beforeBytes, candidateBytes, startedAt });
      return await this.#fallback(decision, nextMessage, { beforeBytes, candidateBytes, startedAt });
    } catch (error) {
      if (decision.action !== 'per_call') {
        const fallbackDecision = { ...decision, action: 'per_call', reason: `${decision.action}_failed` };
        try { return await this.#fallback(fallbackDecision, nextMessage, { beforeBytes, candidateBytes, startedAt, error }); } catch { /* preserve the original transport error */ }
      }
      throw error;
    }
  }

  async close() {
    if (!this.sessionId) return;
    const sessionId = this.sessionId;
    this.sessionId = null;
    this.started = false;
    this.history = [];
    await this.client.closeSession?.(sessionId);
  }

  #record(decision, { beforeBytes, candidateBytes, startedAt, resultBytes = beforeBytes, error = null, fallbackUsed = false } = {}) {
    const entry = {
      action: decision.action,
      reason: decision.reason ?? null,
      beforeBytes,
      candidateBytes,
      resultBytes,
      summarizedCount: decision.summarizedCount ?? 0,
      elapsedMs: Math.max(0, this.now() - startedAt),
      fallbackUsed,
    };
    if (error) entry.errorCode = error.code ?? 'error';
    this.decisionLog.push(entry);
    this.onDecision?.(clone(entry));
    return entry;
  }

  async #append(decision, nextMessage, timeoutMs, context) {
    const result = await this.client.prompt(this.sessionId, nextMessage.content, { timeoutMs });
    this.history = this.#historyWithResult(decision.persistentHistory, result);
    this.#record(decision, { ...context, resultBytes: historyBytes(this.history) });
    return { ...result, transport: 'acp', action: 'append', sessionId: this.sessionId };
  }

  async #replaceSession(decision, nextMessage, timeoutMs, context) {
    const oldSessionId = this.sessionId;
    let replacement = null;
    let result;
    try {
      replacement = await this.client.newSession();
      if (!replacement?.sessionId) throw new AcpError('ACP replacement session did not contain sessionId', { code: 'invalid_response' });
      if (replacement.sessionId === oldSessionId) throw new AcpError('ACP replacement reused the active session id', { code: 'invalid_response' });
      const envelope = decision.action === 'compact' ? historyEnvelope(decision.callMessages) : nextMessage.content;
      if (Buffer.byteLength(envelope, 'utf8') >= this.hardCapBytes) throw new AcpError('ACP replacement context envelope exceeds the hard cap', { code: 'history_over_cap' });
      result = await this.client.prompt(replacement.sessionId, envelope, { timeoutMs });
      this.sessionId = replacement.sessionId;
      this.history = this.#historyWithResult(decision.persistentHistory, result);
    } catch (error) {
      if (replacement?.sessionId && replacement.sessionId !== oldSessionId) {
        try { await this.client.closeSession?.(replacement.sessionId); } catch { /* best effort cleanup */ }
        try { await this.client.deleteSession?.(replacement.sessionId); } catch { /* best effort cleanup */ }
      }
      throw error;
    }
    // Cleanup is deliberately best effort after the replacement is active. A
    // close/delete race must not discard the successfully established session.
    try { await this.client.closeSession?.(oldSessionId); } catch { /* replacement remains the active session */ }
    if (typeof this.client.deleteSession === 'function' && this.client.supportsSession?.('delete')) {
      try { await this.client.deleteSession(oldSessionId); } catch { /* close is sufficient when deletion races or is unsupported */ }
    }
    this.#record(decision, { ...context, resultBytes: historyBytes(this.history) });
    return { ...result, transport: 'acp', action: decision.action, sessionId: this.sessionId };
  }

  async #fallback(decision, nextMessage, context) {
    if (!this.fallbackPrompt) {
      this.#record(decision, { ...context, error: new AcpError('ACP per-call fallback is unavailable', { code: 'fallback_unavailable' }), fallbackUsed: true });
      throw new AcpError('ACP per-call fallback is unavailable', { code: 'fallback_unavailable' });
    }
    const result = await this.fallbackPrompt(nextMessage.content, {
      message: clone(nextMessage),
      reason: decision.reason ?? 'per_call',
      ...(context.error ? { error: context.error } : {}),
    });
    this.#record(decision, { ...context, resultBytes: historyBytes(this.history), fallbackUsed: true });
    return { ...result, transport: 'per_call', action: 'per_call', sessionId: this.sessionId };
  }

  #historyWithResult(messages, result) {
    const next = clone(messages);
    const response = typeof result?.text === 'string'
      ? scrubAcpContent(result.text, { sourcePath: result.sourcePath ?? result.path ?? '' })
      : '';
    if (response) next.push({ role: 'assistant', content: response });
    return next;
  }
}
