/**
 * Opt-in security gates for persistent ACP sessions.
 *
 * The MCP server remains per-call by default. Consumers that explicitly enable
 * ACP persistence can use this module to bind a session to one caller,
 * keep its cwd inside the workspace, enforce the existing write policy, and
 * remove credentials from local continuation history.
 */
import path from 'node:path';
import { AcpError } from './acp-client.mjs';
import { resolveWorkspaceRoot, resolveWritePolicy } from './config.mjs';

const MAX_SCOPE_ID_LENGTH = 256;
const SENSITIVE_KEY = '(?:api[_-]?key|access[_-]?key|token|secret|password|passwd|private[_-]?key|authorization|auth|cookie)';
const SENSITIVE_ASSIGNMENT = new RegExp(`(\\b${SENSITIVE_KEY}\\b\\s*[:=]\\s*)[^\\r\\n,;]+`, 'giu');
const ENV_ASSIGNMENT = /(^|\r?\n)(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*)[^\r\n]*/gmu;
const SENSITIVE_JSON = new RegExp(`([\"']${SENSITIVE_KEY}[\"']\\s*:\\s*)(\"[^\"]*\"|'[^']*'|[^,}\\r\\n]+)`, 'giu');
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu;
const PEM_PRIVATE_KEY = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/giu;
const SENSITIVE_FILE = /(?:^|[/\\\\])(?:\.env(?:\.[^/\\\\]+)?|credentials(?:\.[^/\\\\]+)?|secrets(?:\.[^/\\\\]+)?)$/iu;

function clone(value) {
  return structuredClone(value);
}

function normalizedAbsolute(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return path.resolve(value);
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function validateScopeId(value, label, required) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new AcpError(`${label} is required for a scoped ACP session`, { code: 'session_scope_required' });
    return '';
  }
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_SCOPE_ID_LENGTH || /[\r\n]/u.test(value)) {
    throw new AcpError(`${label} must be a short opaque identifier`, { code: 'session_scope_invalid' });
  }
  return value.trim();
}

export function normalizeSessionScope({ owner, taskId, scope } = {}, { required = false } = {}) {
  const source = scope && typeof scope === 'object' ? scope : {};
  const normalizedOwner = validateScopeId(owner ?? source.owner, 'owner', required);
  const normalizedTaskId = validateScopeId(taskId ?? source.taskId, 'taskId', required);
  if ((normalizedOwner && !normalizedTaskId) || (!normalizedOwner && normalizedTaskId)) {
    throw new AcpError('owner and taskId must be supplied together', { code: 'session_scope_invalid' });
  }
  return { owner: normalizedOwner, taskId: normalizedTaskId };
}

export function scrubAcpContent(content, { sourcePath = '' } = {}) {
  const value = typeof content === 'string' ? content : String(content ?? '');
  if (sourcePath && SENSITIVE_FILE.test(sourcePath)) return '[REDACTED sensitive file]';
  return value
    .replace(PEM_PRIVATE_KEY, '[REDACTED private key]')
    .replace(BEARER_TOKEN, 'Bearer [REDACTED]')
    .replace(SENSITIVE_ASSIGNMENT, '$1[REDACTED]')
    .replace(SENSITIVE_JSON, '$1"[REDACTED]"')
    .replace(ENV_ASSIGNMENT, '$1$2[REDACTED]');
}

export function scrubAcpMessage(message) {
  if (!message || typeof message !== 'object') return message;
  const result = clone(message);
  const sourcePath = typeof result.sourcePath === 'string' ? result.sourcePath : (typeof result.path === 'string' ? result.path : '');
  if (typeof result.content === 'string') result.content = scrubAcpContent(result.content, { sourcePath });
  else if (result.content !== undefined && result.content !== null) result.content = scrubAcpContent(JSON.stringify(result.content), { sourcePath });
  return result;
}

export function scrubAcpMessages(messages) {
  if (!Array.isArray(messages)) throw new TypeError('messages must be an array');
  return messages.map(scrubAcpMessage);
}

function normalizeRelativePath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const original = value.trim().replaceAll('\\', '/');
  if (original.startsWith('/') || /^[A-Za-z]:\//u.test(original)) return null;
  const normalized = path.posix.normalize(original);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized.replace(/^\.\//u, '').replace(/\/$/u, '');
}

function pathAllowed(relativePath, allowedPaths) {
  const candidate = normalizeRelativePath(relativePath);
  if (!candidate) return false;
  return allowedPaths.some((allowed) => candidate === allowed || candidate.startsWith(`${allowed}/`));
}

/** Fail-closed preflight for an ACP call; server postflight remains authoritative. */
export class AcpSecurityPolicy {
  constructor({ workspaceRoot, allowedRoots = null, writePolicy = null, requireScope = true } = {}) {
    this.workspaceRoot = normalizedAbsolute(workspaceRoot ?? process.cwd(), 'workspaceRoot');
    const roots = allowedRoots === null ? [this.workspaceRoot] : allowedRoots;
    if (!Array.isArray(roots) || roots.length === 0) throw new TypeError('allowedRoots must be a non-empty array');
    this.allowedRoots = Object.freeze(roots.map((root) => normalizedAbsolute(root, 'allowedRoot')));
    this.writePolicy = writePolicy && typeof writePolicy === 'object' ? writePolicy : { allowWrite: false, enabled: false, allowedPaths: [], errors: ['write policy unavailable'] };
    if (typeof requireScope !== 'boolean') throw new TypeError('requireScope must be boolean');
    this.requireScope = requireScope;
  }

  sanitizeText(text, options = {}) { return scrubAcpContent(text, options); }
  sanitizeMessages(messages) { return scrubAcpMessages(messages); }

  static fromBridgeConfig(bridgeConfig, options = {}) {
    return new AcpSecurityPolicy({
      workspaceRoot: options.workspaceRoot ?? resolveWorkspaceRoot(bridgeConfig),
      allowedRoots: options.allowedRoots ?? null,
      writePolicy: options.writePolicy ?? resolveWritePolicy(bridgeConfig),
      requireScope: options.requireScope ?? true,
    });
  }

  authorizeSession(session, request = {}) {
    if (!session || typeof session !== 'object') throw new AcpError('ACP session metadata is required', { code: 'session_scope_invalid' });
    const sessionScope = normalizeSessionScope(session, { required: this.requireScope });
    const requestScope = normalizeSessionScope(request, { required: this.requireScope });
    if (sessionScope.owner !== requestScope.owner || sessionScope.taskId !== requestScope.taskId) {
      throw new AcpError('ACP session scope does not match caller/task', { code: 'session_scope_mismatch' });
    }
    const cwd = normalizedAbsolute(request.cwd ?? session.cwd, 'cwd');
    const sessionCwd = normalizedAbsolute(session.cwd, 'session.cwd');
    if (cwd !== sessionCwd || !this.allowedRoots.some((root) => inside(root, cwd))) {
      throw new AcpError('ACP session cwd is outside the allowed workspace roots', { code: 'session_scope_mismatch' });
    }
    for (const field of ['profile', 'model']) {
      if (request[field] !== undefined && String(request[field]) !== String(session[field] ?? '')) {
        throw new AcpError(`ACP session ${field} cannot change during continuation`, { code: 'session_scope_mismatch' });
      }
    }
    return { sessionId: session.sessionId ?? null, cwd, scope: clone(sessionScope) };
  }

  authorizeCall(session, { mode = 'inspect', role = 'read', subagentRole, owner, taskId, scope, cwd, profile, model, requestedPaths = [] } = {}) {
    if (!Array.isArray(requestedPaths)) throw new TypeError('requestedPaths must be an array');
    if (!['inspect', 'review', 'plan', 'implement'].includes(mode)) throw new AcpError(`unsupported ACP mode: ${mode}`, { code: 'mode_invalid' });
    const effectiveRole = subagentRole ?? role;
    const authorized = this.authorizeSession(session, { owner, taskId, scope, cwd, profile, model });
    if (mode === 'implement') {
      if (effectiveRole !== 'write') throw new AcpError('mode=implement requires the write subagent role', { code: 'write_role_required' });
      if (!this.writePolicy.allowWrite || !this.writePolicy.enabled || this.writePolicy.errors?.length) {
        throw new AcpError('mode=implement is disabled by the write policy', { code: 'write_policy_denied' });
      }
      for (const requestedPath of requestedPaths) {
        if (!pathAllowed(requestedPath, this.writePolicy.allowedPaths ?? [])) {
          throw new AcpError(`write path is outside allowedPaths: ${requestedPath}`, { code: 'write_path_denied' });
        }
      }
    } else if (effectiveRole === 'write') {
      throw new AcpError('write role is not allowed for a read-only ACP mode', { code: 'read_mode_write_denied' });
    }
    return { ...authorized, mode, role: effectiveRole, requestedPaths: [...requestedPaths] };
  }
}
