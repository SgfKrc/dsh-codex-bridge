/**
 * Design-only ACP session budget prototype.
 *
 * This module is intentionally not imported by server.mjs. It models the
 * lifecycle decisions required before a persistent transport can be enabled.
 */
export const ACP_HISTORY_HARD_CAP_BYTES = 128 * 1024 * 1024;
export const ACP_COMPACT_TRIGGER_RATIO = 0.75;

function cloneMessages(messages) {
  return messages.map((message) => structuredClone(message));
}

export function historyBytes(messages) {
  if (!Array.isArray(messages)) throw new TypeError('history must be an array');
  return Buffer.byteLength(JSON.stringify(messages), 'utf8');
}

/**
 * Compact oldest non-system messages transactionally. The caller owns the
 * summarizer; a thrown/invalid summary leaves the original history untouched.
 */
export function compactHistory(messages, { summarize, preserveRecent = 2 } = {}) {
  if (!Array.isArray(messages)) throw new TypeError('history must be an array');
  const original = cloneMessages(messages);
  if (typeof summarize !== 'function') return { ok: false, reason: 'summarizer_missing', messages: original, compacted: false };
  const system = messages.filter((message) => message?.role === 'system');
  const nonSystem = messages.filter((message) => message?.role !== 'system');
  if (nonSystem.length <= preserveRecent) return { ok: false, reason: 'not_enough_history', messages: original, compacted: false };
  const compactable = nonSystem.slice(0, nonSystem.length - preserveRecent);
  try {
    const summary = summarize(cloneMessages(compactable));
    if (typeof summary !== 'string' || !summary.trim()) throw new Error('summarizer returned empty output');
    const recent = cloneMessages(nonSystem.slice(-preserveRecent));
    const compacted = [...cloneMessages(system), { role: 'system', content: `[ACP compacted ${compactable.length} messages]\n${summary.trim()}`, acpCompacted: true }, ...recent];
    return { ok: true, reason: 'compacted', messages: compacted, compacted: true, summarizedCount: compactable.length, bytes: historyBytes(compacted) };
  } catch (error) {
    return { ok: false, reason: 'compact_failed', error: error instanceof Error ? error.message : String(error), messages: original, compacted: false };
  }
}

/**
 * Decide how a persistent session should accept its next message.
 * No branch mutates the supplied history; per-call fallback keeps persistent
 * history unchanged and returns an isolated one-message call payload.
 */
export function prepareSessionContinuation(history, nextMessage, {
  hardCapBytes = ACP_HISTORY_HARD_CAP_BYTES,
  compactTriggerRatio = ACP_COMPACT_TRIGGER_RATIO,
  summarize,
  preserveRecent = 2,
} = {}) {
  if (!Array.isArray(history)) throw new TypeError('history must be an array');
  if (!nextMessage || typeof nextMessage !== 'object') throw new TypeError('nextMessage must be an object');
  if (!Number.isInteger(hardCapBytes) || hardCapBytes < 1) throw new RangeError('hardCapBytes must be a positive integer');
  if (!(compactTriggerRatio > 0 && compactTriggerRatio < 1)) throw new RangeError('compactTriggerRatio must be between 0 and 1');
  const original = cloneMessages(history);
  const candidate = [...original, structuredClone(nextMessage)];
  const candidateBytes = historyBytes(candidate);
  const triggerBytes = Math.floor(hardCapBytes * compactTriggerRatio);
  if (candidateBytes < triggerBytes) return { action: 'append', persistentHistory: candidate, callMessages: candidate, bytes: candidateBytes };

  const compacted = compactHistory(candidate, { summarize, preserveRecent });
  if (!compacted.ok) {
    return {
      action: 'per_call',
      reason: compacted.reason,
      persistentHistory: original,
      callMessages: [structuredClone(nextMessage)],
      bytes: historyBytes(original),
    };
  }
  if (compacted.bytes >= hardCapBytes) {
    return {
      action: 'rotate',
      reason: 'compacted_history_at_or_over_hard_cap',
      persistentHistory: [structuredClone(nextMessage)],
      callMessages: [structuredClone(nextMessage)],
      bytes: historyBytes([nextMessage]),
      summarizedCount: compacted.summarizedCount,
    };
  }
  return {
    action: 'compact',
    reason: 'below_hard_cap_after_compact',
    persistentHistory: compacted.messages,
    callMessages: compacted.messages,
    bytes: compacted.bytes,
    summarizedCount: compacted.summarizedCount,
  };
}
