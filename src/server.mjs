/** Local stdio MCP facade for the configured Reasonix worker. */
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { appendFileSync, existsSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { rollbackRecordSnapshot, restoreSnapshotEntries, snapshotWriteBaseline } from './snapshot.mjs';
import {
  ConfigError,
  SERVER_NAME,
  checkCliVersion,
  cliSpawnCommand,
  cliSpawnOptions,
  readBridgeConfig,
  doctorRefs,
  EXEC_HARD_OUTPUT_CHAR_CAP,
  EXEC_HARD_TIMEOUT_SECONDS_CAP,
  readDoctor,
  resolveCliPath,
  resolveExecPolicy,
  resolveModelRef,
  resolveProviderSearchCapability,
  resolveSubagent,
  resolveSubagentRole,
  resolveTransport,
  resolveWritePolicy,
  resolveWorkspaceRoot,
  validateModelRef,
} from './config.mjs';
import {
  consumeCheckpoint,
  countReadyCheckpoints,
  fingerprint,
  isCheckpointId,
  readCheckpoint,
  resolveCheckpointDir,
  writeCheckpoint,
} from './checkpoint.mjs';
import { AcpClient } from './acp-client.mjs';
import { AcpSecurityPolicy } from './acp-security.mjs';
import { AcpTransportManager } from './acp-transport.mjs';
import { resolveWorkflowStage, stageForMode, workflowStatus } from './workflow.mjs';

function log(message) { process.stderr.write(`[${SERVER_NAME}] ${message}\n`); }
function refuse(reason, hint) {
  log(`refusing to start: ${reason}`);
  if (hint) log(hint);
  process.exit(2);
}

// Reasonix counts an assistant/tool exchange as two internal steps. Keep the
// public tool-round control separate so callers do not have to guess that CLI
// implementation detail.
const REASONIX_STEPS_PER_TOOL_ROUND = 2;
// Keep long runs bounded while leaving enough room for explicit multi-stage work.
const HARD_MAX_STEPS_CAP = 256;
const HARD_TIMEOUT_SECONDS_CAP = 1800;
const TASK_CHAR_CAP = 8000;
const HARD_OUTPUT_CHAR_CAP = 24000;
const HARD_QUEUE_CAP = 5;
const HISTORY_HARD_CAP_BYTES = 128 * 1024 * 1024;
// Per-mode defaults are raw Reasonix steps (2 per tool-call round); callers may raise them per call
// via max_steps/tool_rounds up to the hard caps below.
const MODES = { inspect: { maxSteps: 80, timeoutSeconds: 600 }, review: { maxSteps: 96, timeoutSeconds: 900 }, plan: { maxSteps: 96, timeoutSeconds: 900 }, implement: { maxSteps: 96, timeoutSeconds: 900 } };
const BRIDGE_LOG_PATH = (process.env.BRIDGE_LOG ?? '').trim() ? path.resolve(process.env.BRIDGE_LOG.trim()) : '';

const TOOLS = [
  { name: 'reasonix_run', description: 'Run the configured Reasonix worker in inspect, review, plan, or explicitly authorized implement mode. Budget: omit max_steps and tool_rounds to use the mode default (inspect 40 tool-call rounds, review/plan/implement 48); pass tool_rounds only when a task needs a different bound (1 round = 2 raw CLI steps, hard cap 128 rounds); max_steps is the raw CLI budget and is only for explicit CLI-compatible overrides. Set parallel=true explicitly for concurrent read-only jobs. Pass stage=plan|implement|review to make the main-agent workflow stage visible; the bridge never auto-advances stages. When transport=acp is enabled, pass session_id to opt into a persistent ACP session.', inputSchema: { type: 'object', properties: { task: { type: 'string', description: 'Self-contained task text for the worker.' }, cwd: { type: 'string', description: 'Workspace-relative directory inside the allowed roots; defaults to the workspace root.' }, max_steps: { type: 'integer', description: 'Raw Reasonix internal steps (2 per tool-call round). Omit to use the mode default (inspect 80, review/plan/implement 96); only pass for explicit CLI-compatible overrides. Hard cap 256.' }, tool_rounds: { type: 'integer', minimum: 1, description: 'Tool-call rounds (1 round = 2 raw steps). Omit to use the mode default (inspect 40, review/plan/implement 48); hard cap 128. Prefer this over max_steps.' }, mode: { type: 'string', enum: ['inspect', 'implement', 'review', 'plan'], description: 'inspect/review/plan are read-only; implement requires an explicit write role plus the per-machine write policy.' }, stage: { type: 'string', enum: ['plan', 'implement', 'review'], description: 'Makes the main-agent workflow stage visible; the bridge never auto-advances stages.' }, timeout_seconds: { type: 'integer', description: 'Per-call timeout. Omit to use the mode default (inspect 600s, review/plan/implement 900s); hard cap 1800s.' }, parallel: { type: 'boolean', description: 'true opts into a concurrent read-only slot; implement/resume/rollback stay exclusive.' }, session_id: { type: 'string', description: 'Only when transport=acp is enabled, to opt into a persistent ACP session.' } }, required: ['task'] } },
  { name: 'reasonix_resume', description: 'Explicitly resume one durable checkpoint after workspace/configuration drift checks. A checkpoint is one-shot and is never replayed implicitly.', inputSchema: { type: 'object', properties: { checkpoint_id: { type: 'string', description: 'Checkpoint id returned by a failed reasonix_run.' }, max_steps: { type: 'integer', description: 'Raw Reasonix internal steps; omit to reuse the checkpoint budget.' }, tool_rounds: { type: 'integer', minimum: 1, description: 'Tool-call rounds; omit to reuse the checkpoint budget.' }, timeout_seconds: { type: 'integer', description: 'Per-call timeout; omit to reuse the checkpoint budget.' } }, required: ['checkpoint_id'] } },
  { name: 'reasonix_cancel', description: 'Request cancellation of one queued or running job. Running workers are terminated and the terminal cancellation remains visible in reasonix_status.', inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] } },
  { name: 'reasonix_events', description: 'Poll a bounded, ordered lifecycle stream for one job. Events contain only job id, stage, state, terminal outcome, and bounded counters; task text, model references, paths, and worker output are never returned.', inputSchema: { type: 'object', properties: { job_id: { type: 'string' }, after_seq: { type: 'integer', minimum: 0, description: 'Return events after this per-job sequence number.' }, limit: { type: 'integer', minimum: 1, maximum: 64, description: 'Maximum number of events to return.' } }, required: ['job_id'] } },
  { name: 'reasonix_rollback', description: 'Explicitly roll back one successful implement call by its returned rollback_id, only when its files are unchanged since that call.', inputSchema: { type: 'object', properties: { rollback_id: { type: 'string' } }, required: ['rollback_id'] } },
  { name: 'reasonix_exec', description: 'Run one explicitly configured command profile through a no-shell argv spawn as the explicit exec/test workflow stage. The policy is disabled by default, requires a clean Git workspace, and never accepts a caller-provided executable.', inputSchema: { type: 'object', properties: { command: { type: 'string' }, args: { type: 'array', items: { type: 'string' }, maxItems: 128 }, cwd: { type: 'string' }, stage: { type: 'string', enum: ['exec'] }, timeout_seconds: { type: 'integer', minimum: 1 }, output_char_cap: { type: 'integer', minimum: 1 } }, required: ['command'] } },
  { name: 'reasonix_status', description: 'Show bridge configuration and limits without calling a model.', inputSchema: { type: 'object', properties: {} } },
];

let bridgeConfig = { path: '', exists: false, data: {} };
try {
  bridgeConfig = readBridgeConfig();
} catch (error) {
  refuse(error instanceof ConfigError ? error.message : String(error?.message ?? error));
}

function configuredLimit(config, key) {
  const root = config?.data;
  const nested = root?.limits;
  if (nested && typeof nested === 'object' && !Array.isArray(nested) && Object.hasOwn(nested, key)) return nested[key];
  if (root && typeof root === 'object' && Object.hasOwn(root, key)) return root[key];
  return undefined;
}
function resolveConfiguredLimit(config, key, fallback, hardCap) {
  const raw = configuredLimit(config, key);
  if (raw === undefined) return fallback;
  const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(parsed) || parsed < 1) {
    log(`warning: bridge config ${key} is invalid; using default ${fallback}`);
    return fallback;
  }
  if (parsed > hardCap) {
    log(`warning: bridge config ${key}=${parsed} exceeds hard cap ${hardCap}; clamped to ${hardCap}`);
    return hardCap;
  }
  return parsed;
}
const LIMITS = Object.freeze({
  maxStepsCap: resolveConfiguredLimit(bridgeConfig, 'MAX_STEPS_CAP', HARD_MAX_STEPS_CAP, HARD_MAX_STEPS_CAP),
  timeoutSecondsCap: resolveConfiguredLimit(bridgeConfig, 'TIMEOUT_SECONDS_CAP', HARD_TIMEOUT_SECONDS_CAP, HARD_TIMEOUT_SECONDS_CAP),
  outputCharCap: resolveConfiguredLimit(bridgeConfig, 'OUTPUT_CHAR_CAP', HARD_OUTPUT_CHAR_CAP, HARD_OUTPUT_CHAR_CAP),
  queueCap: resolveConfiguredLimit(bridgeConfig, 'queueCap', HARD_QUEUE_CAP, HARD_QUEUE_CAP),
});

let CLI_PATH = '';
try {
  CLI_PATH = resolveCliPath();
} catch (error) {
  refuse(
    error instanceof ConfigError ? error.message : String(error?.message ?? error),
    'set REASONIX_EXE, or install Reasonix so the standard locations are populated.',
  );
}

const VERSION_CHECK = checkCliVersion(CLI_PATH);
if (VERSION_CHECK.status === 'fail') {
  refuse(
    VERSION_CHECK.error,
    `upgrade Reasonix or set REASONIX_MIN_VERSION below ${VERSION_CHECK.version ?? 'the installed version'} only for a deliberate compatibility check.`,
  );
}
if (VERSION_CHECK.warning) log(`warning: ${VERSION_CHECK.warning}`);
if (VERSION_CHECK.status === 'unknown') log(`warning: Reasonix CLI version check unknown (${VERSION_CHECK.error})`);

const WORKSPACE_ROOT = resolveWorkspaceRoot(bridgeConfig);
const CHECKPOINT_DIR = resolveCheckpointDir(process.env.BRIDGE_CHECKPOINT_DIR || bridgeConfig.data?.checkpointDir);
const CHECKPOINT_ENABLED = !isInside(WORKSPACE_ROOT, CHECKPOINT_DIR);
if (!CHECKPOINT_ENABLED) log('warning: checkpoint directory is inside the workspace; durable checkpoints disabled to avoid dirtying the Git tree');
const SUBAGENT = resolveSubagent(bridgeConfig);
let SUBAGENT_ROLE;
try {
  SUBAGENT_ROLE = resolveSubagentRole(bridgeConfig, SUBAGENT);
} catch (error) {
  refuse(error instanceof ConfigError ? error.message : String(error?.message ?? error));
}
const MODEL_RESOLUTION = resolveModelRef({ cliPath: CLI_PATH, bridgeConfig });
const MODEL_REF = MODEL_RESOLUTION.ref;
if (!MODEL_REF) {
  refuse(
    `no subagent model reference configured (${MODEL_RESOLUTION.error ?? 'no source'})`,
    'pick one with: node src/configure.mjs list  ->  node src/configure.mjs use <provider>/<model>',
  );
}
const MODEL_REF_PROBLEM = validateModelRef(MODEL_REF);
if (MODEL_REF_PROBLEM) {
  refuse(`${MODEL_REF_PROBLEM}: ${MODEL_REF}`, 'fix with: node src/configure.mjs use <provider>/<model>');
}
const SUBAGENT_NAME = SUBAGENT_ROLE.name ?? SUBAGENT.name;
const MODEL_REF_SOURCE = MODEL_RESOLUTION.source;
const MODEL_DOCTOR = MODEL_RESOLUTION.doctor?.ok
  ? MODEL_RESOLUTION.doctor
  : readDoctor(CLI_PATH, 30_000, { writeCache: false });
const PROVIDER_SEARCH = resolveProviderSearchCapability(MODEL_DOCTOR?.data, MODEL_REF);
const MODEL_CAPABILITIES = resolveModelCapabilities(MODEL_DOCTOR);
const WRITE_POLICY = resolveWritePolicy(bridgeConfig);
const EXEC_POLICY = resolveExecPolicy(bridgeConfig);
const TRANSPORT = resolveTransport(bridgeConfig);
if (TRANSPORT.error) log(`warning: ${TRANSPORT.error}; using per-call transport`);
const rollbackRecords = new Map();
const MAX_ROLLBACK_RECORDS = 32;

function resolveModelCapabilities(doctorResult = MODEL_DOCTOR) {
  const doctor = doctorResult;
  if (!doctor?.ok) return { available: false, provider: null, model: null, contextWindow: null, vision: null, base_url_host: null, error: doctor?.error || 'reasonix doctor unavailable' };
  const selected = doctorRefs(doctor.data).refs.find((item) => item.ref === MODEL_REF);
  if (!selected) return { available: false, provider: null, model: null, contextWindow: null, vision: null, base_url_host: null, error: 'selected model is not reported by reasonix doctor' };
  const host = selected.baseHost && /^[A-Za-z0-9.:[\]-]+$/u.test(selected.baseHost) ? selected.baseHost : null;
  return {
    available: true,
    provider: selected.provider,
    model: selected.model,
    contextWindow: selected.contextWindow,
    vision: selected.vision,
    base_url_host: host,
    error: null,
  };
}
function modeBudgetStatus() {
  return Object.fromEntries(Object.entries(MODES).map(([mode, preset]) => [mode, {
    maxSteps: preset.maxSteps,
    toolRounds: Math.ceil(preset.maxSteps / REASONIX_STEPS_PER_TOOL_ROUND),
    timeoutSeconds: preset.timeoutSeconds,
  }]));
}

function allowedRoots() {
  const extra = (process.env.REASONIX_ADD_DIRS ?? '').split(path.delimiter).map((x) => x.trim()).filter(Boolean);
  return [WORKSPACE_ROOT, ...extra].map((entry) => { const absolute = path.resolve(entry); try { return realpathSync.native(absolute); } catch { return absolute; } });
}
function isInside(root, candidate) { return candidate === root || candidate.startsWith(root + path.sep); }
function resolveCwd(raw) {
  const roots = allowedRoots();
  const base = raw === undefined || raw === null || String(raw).trim() === '' ? roots[0] : path.resolve(roots[0], String(raw).trim());
  let real;
  try { real = realpathSync.native(base); } catch { throw new Error(`cwd does not exist or is not readable: ${base}`); }
  if (!statSync(real).isDirectory()) throw new Error(`cwd is not a directory: ${real}`);
  if (!roots.some((root) => isInside(root, real))) throw new Error(`cwd outside allowed workspace: ${real}`);
  return real;
}

function execPathLabel(cwd) {
  const relative = path.relative(WORKSPACE_ROOT, cwd).replaceAll('\\', '/');
  return relative || '.';
}

function execCwdAllowed(cwd) {
  const relative = execPathLabel(cwd);
  return EXEC_POLICY.allowedPaths.some((allowed) => !allowed || relative === allowed || relative.startsWith(`${allowed}/`));
}

function gitStatusChanged(before, after) {
  if (!before?.ok || !after?.ok) return true;
  const beforeMap = new Map(before.entries.map((entry) => [entry.path, entry.status]));
  const afterMap = new Map(after.entries.map((entry) => [entry.path, entry.status]));
  const paths = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  return [...paths].filter((entry) => beforeMap.get(entry) !== afterMap.get(entry));
}

function redactExecOutput(value) {
  let text = String(value ?? '');
  for (const candidate of [WORKSPACE_ROOT, process.env.USERPROFILE, process.env.HOME]) {
    if (candidate) text = text.replaceAll(candidate, candidate === WORKSPACE_ROOT ? '<workspace>' : '<user>');
  }
  return text.replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)([^\s"'&]+)/giu, '$1[REDACTED]');
}

function executableCandidates(value) {
  const text = String(value);
  if (path.isAbsolute(text) || text.includes('/') || text.includes('\\')) return [path.isAbsolute(text) ? text : path.resolve(WORKSPACE_ROOT, text)];
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (process.platform !== 'win32') return dirs.map((dir) => path.join(dir, text));
  const extensions = ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)];
  return dirs.flatMap((dir) => extensions.map((extension) => path.join(dir, text + extension)));
}

function resolveExecExecutable(spec) {
  for (const candidate of executableCandidates(spec.executable)) {
    try {
      if (statSync(candidate).isFile()) return realpathSync.native(candidate);
    } catch { /* try the next PATH candidate */ }
  }
  throw new Error(`configured executable is not available for command=${spec.name}`);
}

function gitStatus(root) {
  const result = spawn('git', ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], cliSpawnOptions('git', { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    result.stdout.setEncoding('utf8');
    result.stderr.setEncoding('utf8');
    result.stdout.on('data', (chunk) => { stdout += chunk; });
    result.stderr.on('data', (chunk) => { stderr += chunk; });
    result.once('error', (error) => resolve({ ok: false, entries: [], error: `cannot run git status: ${error.message}` }));
    result.once('close', (code) => {
      if (code !== 0) return resolve({ ok: false, entries: [], error: `git status exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}` });
      const entries = [];
      const fields = stdout.split('\0').filter(Boolean);
      for (let index = 0; index < fields.length; index += 1) {
        const field = fields[index];
        if (field.length < 4) continue;
        const status = field.slice(0, 2);
        const firstPath = field.slice(3).replaceAll('\\', '/');
        entries.push({ status, path: firstPath });
        if (status.includes('R') || status.includes('C')) {
          const oldPath = fields[index + 1];
          if (oldPath) entries.push({ status: 'D', path: oldPath.replaceAll('\\', '/') });
          index += 1;
        }
      }
      resolve({ ok: true, entries, error: '' });
    });
  });
}
function checkpointConfigFingerprint() {
  return fingerprint({
    modelRef: MODEL_REF,
    subagent: SUBAGENT_NAME,
    role: SUBAGENT_ROLE.role,
    reasonixVersion: VERSION_CHECK.version || 'unknown',
    transport: TRANSPORT.mode,
    limits: LIMITS,
  });
}
async function checkpointWorkspaceSnapshot() {
  const status = await gitStatus(WORKSPACE_ROOT);
  const head = runGitSync(WORKSPACE_ROOT, ['rev-parse', 'HEAD']);
  return {
    rootFingerprint: fingerprint(WORKSPACE_ROOT),
    gitAvailable: status.ok && head.ok,
    gitHead: status.ok && head.ok ? head.stdout.trim() : null,
    gitStatusFingerprint: status.ok ? fingerprint(status.entries) : null,
  };
}
function checkpointWorkspaceDrift(expected, current) {
  if (!expected || expected.rootFingerprint !== current.rootFingerprint) return 'workspace identity changed';
  if (expected.gitAvailable !== current.gitAvailable) return 'Git availability changed';
  if (expected.gitAvailable && (expected.gitHead !== current.gitHead || expected.gitStatusFingerprint !== current.gitStatusFingerprint)) return 'Git HEAD or working tree changed';
  return '';
}
function checkpointableOutcome(outcome) {
  return ['timeout', 'worker_exit', 'step_limit', 'cursor_error'].includes(outcome);
}
async function createRunCheckpoint({ mode, stage = stageForMode(mode), task, cwd, maxSteps, timeoutSeconds, outcome, exitCode, stepLimitRounds, cursorError, parentCheckpointId = null }) {
  if (!CHECKPOINT_ENABLED || !isInside(WORKSPACE_ROOT, cwd)) return null;
  try {
    const workspace = await checkpointWorkspaceSnapshot();
    const relativeCwd = path.relative(WORKSPACE_ROOT, cwd).replaceAll('\\', '/') || '.';
    const record = writeCheckpoint(CHECKPOINT_DIR, {
      createdAt: new Date().toISOString(),
      mode,
      stage,
      task,
      cwd: relativeCwd,
      maxSteps,
      timeoutSeconds,
      outcome,
      exitCode,
      stepLimitRounds: Number.isInteger(stepLimitRounds) ? stepLimitRounds : null,
      cursorError: cursorError === true,
      parentCheckpointId: isCheckpointId(parentCheckpointId) ? parentCheckpointId : null,
      reasonixVersion: VERSION_CHECK.version || null,
      configFingerprint: checkpointConfigFingerprint(),
      workspace,
    });
    return record.id;
  } catch (error) {
    log(`checkpoint disabled for this failure: ${error?.message ?? error}`);
    return null;
  }
}
async function validateCheckpointForResume(checkpoint) {
  if (checkpoint.configFingerprint !== checkpointConfigFingerprint()) return 'bridge configuration or selected profile changed';
  const workspace = await checkpointWorkspaceSnapshot();
  return checkpointWorkspaceDrift(checkpoint.workspace, workspace);
}
function resumeTask(checkpoint) {
  const task = `Continue the previous task from the current workspace. The prior explicit run ended with ${checkpoint.outcome}. Inspect current state first, do not restart completed work, and do not reuse or edit any continuation cursor.\n\nOriginal task:\n${checkpoint.task}`;
  if (task.length > TASK_CHAR_CAP) throw new Error(`resumed task exceeds ${TASK_CHAR_CAP} chars`);
  return task;
}
function changedEntries(before, after) {
  const beforeMap = new Map(before.map((entry) => [entry.path, entry.status]));
  return after.filter((entry) => beforeMap.get(entry.path) !== entry.status);
}
function pathMatchesAllowed(relativePath) {
  const candidate = relativePath.replaceAll('\\', '/').replace(/^\.\//, '');
  return WRITE_POLICY.allowedPaths.some((allowed) => candidate === allowed || candidate.startsWith(`${allowed}/`));
}
async function rollbackEntries(root, entries, snapshotEntries = []) {
  // Snapshot entries (pre-existing user edits under allowedPaths) are restored
  // verbatim and excluded from the git-based path, which would reset them to HEAD.
  const restored = restoreSnapshotEntries(root, snapshotEntries);
  const handledPaths = restored.handled;
  const normalize = (value) => String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
  const unique = [...new Map(entries.filter((entry) => entry?.path && !handledPaths.has(normalize(entry.path))).map((entry) => [entry.path, entry])).values()];
  if (!unique.length) return { ok: restored.errors.length === 0, error: restored.errors.join('; ') };
  const tracked = unique.filter((entry) => !entry.status.includes('?')).map((entry) => entry.path);
  const untracked = unique.filter((entry) => entry.status.includes('?')).map((entry) => entry.path);
  const errors = [...restored.errors];
  if (tracked.length) {
    await new Promise((resolve) => {
      const restore = spawn('git', ['-C', root, 'restore', '--worktree', '--staged', '--', ...tracked], cliSpawnOptions('git', { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
      restore.once('error', (error) => { errors.push(`git restore: ${error.message}`); resolve(); });
      restore.once('close', (code) => { if (code !== 0) errors.push(`git restore exited with code ${code}`); resolve(); });
    });
  }
  for (const relativePath of untracked) {
    // A worker may stage a rename/copy destination. Unstage it before removing
    // the worktree path, otherwise the index keeps the rename alive.
    if (runGitSync(root, ['ls-files', '--error-unmatch', '--', relativePath]).ok) {
      const reset = runGitSync(root, ['reset', '--', relativePath]);
      if (!reset.ok) errors.push(`unstage ${relativePath}: ${reset.error}`);
    }
    try { rmSync(path.join(root, relativePath), { recursive: true, force: true }); } catch (error) { errors.push(`remove ${relativePath}: ${error.message}`); }
  }
  return { ok: errors.length === 0, error: errors.join('; ') };
}
function runGitSync(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], cliSpawnOptions('git', {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  }));
  if (result.error || result.status !== 0) return { ok: false, stdout: '', error: result.error?.message || `git ${args[0]} exited with code ${result.status}` };
  return { ok: true, stdout: String(result.stdout ?? ''), error: '' };
}
function gitHeadHash(root, relativePath) {
  const result = spawnSync('git', ['-C', root, 'show', `HEAD:${relativePath}`], cliSpawnOptions('git', {
    encoding: 'buffer',
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
  }));
  if (result.error || result.status !== 0) return '';
  return createHash('sha256').update(result.stdout).digest('hex');
}
function hashFile(filePath) {
  return new Promise((resolve) => {
    let stats;
    try { stats = statSync(filePath); } catch (error) {
      if (error?.code === 'ENOENT') return resolve({ status: 'missing', sha256: null, error: '' });
      return resolve({ status: 'unreadable', sha256: null, error: error?.message ?? String(error) });
    }
    if (!stats.isFile()) return resolve({ status: 'unreadable', sha256: null, error: 'path is not a regular file' });
    let hash;
    try { hash = createHash('sha256'); } catch (error) { return resolve({ status: 'unreadable', sha256: null, error: error?.message ?? String(error) }); }
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', (error) => resolve({ status: 'unreadable', sha256: null, error: error?.message ?? String(error) }));
    stream.once('end', () => resolve({ status: 'readable', sha256: hash.digest('hex'), error: '' }));
  });
}
function countTextLines(filePath) {
  try {
    const data = readFileSync(filePath);
    if (data.includes(0)) return { additions: null, deletions: null, binary: true };
    const text = data.toString('utf8');
    return { additions: text === '' ? 0 : text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').length - (text.endsWith('\n') ? 1 : 0), deletions: 0, binary: false };
  } catch {
    return { additions: null, deletions: null, binary: false };
  }
}
function gitNumstat(root, paths) {
  if (!paths.length) return new Map();
  const result = runGitSync(root, ['diff', 'HEAD', '--numstat', '--', ...paths]);
  if (!result.ok) return new Map();
  const stats = new Map();
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!match) continue;
    stats.set(match[3].replaceAll('\\', '/'), {
      additions: match[1] === '-' ? null : Number(match[1]),
      deletions: match[2] === '-' ? null : Number(match[2]),
      binary: match[1] === '-' || match[2] === '-',
    });
  }
  return stats;
}
function gitDiffStat(root, paths) {
  if (!paths.length) return '';
  const result = runGitSync(root, ['diff', 'HEAD', '--stat', '--', ...paths]);
  return result.ok ? result.stdout.trim() : '';
}
function changeKind(entry) {
  if (entry.status.includes('D')) return 'deleted';
  // For rename/copy status, Git reports the destination first and the source
  // as a separate deleted entry. Treat the destination like an added path so
  // rollback removes it instead of looking for a nonexistent HEAD blob.
  if (entry.status.includes('A') || entry.status.includes('?') || entry.status.includes('R') || entry.status.includes('C')) return 'added';
  return 'modified';
}
async function buildChangeSet(root, entries, rollbackId = null) {
  const paths = entries.map((entry) => entry.path);
  const numstat = gitNumstat(root, paths);
  const changes = [];
  for (const entry of entries) {
    const filePath = path.resolve(root, entry.path);
    const fileHash = await hashFile(filePath);
    const exists = fileHash.status === 'readable';
    const kind = changeKind(entry);
    let lineStats = numstat.get(entry.path);
    if (!lineStats && exists && kind === 'added') lineStats = countTextLines(filePath);
    if (!lineStats) lineStats = { additions: kind === 'deleted' ? 0 : null, deletions: kind === 'deleted' ? null : 0, binary: false };
    changes.push({ path: entry.path, kind, additions: lineStats.additions, deletions: lineStats.deletions, binary: lineStats.binary, sha256: fileHash.sha256, hash_status: fileHash.status });
  }
  return {
    schema: 'qlh.reasonix.changes.v1',
    rollback_id: rollbackId,
    diff_stat: gitDiffStat(root, paths) || (changes.length ? `untracked changes: ${changes.length} file(s)` : ''),
    changes,
  };
}
function rememberRollback(root, changes) {
  if (!changes.length) return null;
  const rollbackId = randomUUID();
  rollbackRecords.set(rollbackId, { root, changes, createdAt: Date.now() });
  while (rollbackRecords.size > MAX_ROLLBACK_RECORDS) rollbackRecords.delete(rollbackRecords.keys().next().value);
  return rollbackId;
}
async function explicitRollback(rollbackId) {
  const value = typeof rollbackId === 'string' ? rollbackId.trim() : '';
  if (!value) return { isError: true, text: 'rollback_id is required' };
  const record = rollbackRecords.get(value);
  if (!record) return { isError: true, text: 'rollback_id is unknown or has expired' };
  const conflicts = [];
  const missing = [];
  const unreadable = [];
  for (const change of record.changes) {
    const currentPath = path.resolve(record.root, change.path);
    const currentHash = await hashFile(currentPath);
    if (currentHash.status === 'unreadable') {
      unreadable.push(change.path);
      continue;
    }
    const expectedStatus = change.hash_status ?? (change.sha256 === null ? 'missing' : 'readable');
    if (expectedStatus === 'unreadable') {
      unreadable.push(`${change.path} (recorded hash unavailable)`);
    } else if (currentHash.status === 'missing' && expectedStatus !== 'missing') {
      missing.push(change.path);
    } else if (currentHash.status !== expectedStatus || currentHash.sha256 !== change.sha256) {
      conflicts.push(change.path);
    }
  }
  if (unreadable.length) return { isError: true, text: `rollback refused because files are unreadable: ${unreadable.join(', ')}` };
  if (missing.length) return { isError: true, text: `rollback refused because files are missing: ${missing.join(', ')}` };
  if (conflicts.length) return { isError: true, text: `rollback refused because files changed after the implement call: ${conflicts.join(', ')}` };
  const entries = record.changes.map((change) => ({ path: change.path, status: change.kind === 'added' ? '??' : change.kind === 'deleted' ? ' D' : ' M' }));
  const baselineEntries = rollbackRecordSnapshot(record.baseline);
  const baselineByPath = new Map(baselineEntries.map((entry) => [entry.path, entry]));
  const rollback = await rollbackEntries(record.root, entries, baselineEntries);
  if (!rollback.ok) return { isError: true, text: `rollback failed: ${rollback.error}` };
  const afterStatus = await gitStatus(record.root);
  if (!afterStatus.ok) return { isError: true, text: `rollback post-check failed: ${afterStatus.error}` };
  const remaining = afterStatus.entries.filter((entry) => record.changes.some((change) => change.path === entry.path) && !baselineByPath.has(entry.path));
  if (remaining.length) return { isError: true, text: `rollback post-check found changes still present: ${remaining.map((entry) => entry.path).join(', ')}` };
  const postHashConflicts = [];
  for (const change of record.changes) {
    const currentHash = await hashFile(path.resolve(record.root, change.path));
    if (baselineByPath.has(change.path)) {
      // Paths restored from the write baseline legitimately keep the user's
      // pre-existing content, so compare against the baseline hash, not HEAD.
      const baselineEntry = baselineByPath.get(change.path);
      if (baselineEntry.kind === 'absent') {
        if (currentHash.status !== 'missing') postHashConflicts.push(change.path);
      } else if (currentHash.status !== 'readable' || currentHash.sha256 !== baselineEntry.sha256) {
        postHashConflicts.push(change.path);
      }
      continue;
    }
    if (change.kind === 'added') {
      if (currentHash.status !== 'missing') postHashConflicts.push(change.path);
      continue;
    }
    const expectedHash = gitHeadHash(record.root, change.path);
    if (!expectedHash || currentHash.status !== 'readable' || currentHash.sha256 !== expectedHash) postHashConflicts.push(change.path);
  }
  if (postHashConflicts.length) return { isError: true, text: `rollback post-check hash mismatch: ${postHashConflicts.join(', ')}` };
  rollbackRecords.delete(value);
  return { isError: false, text: JSON.stringify({ schema: 'qlh.reasonix.rollback.v1', rollback_id: value, status: 'rolled_back', paths: record.changes.map((change) => change.path) }) };
}
function clampInteger(value, fallback, cap) {
  const safeFallback = Math.min(cap, Math.max(1, Math.trunc(fallback)));
  if (value === null || value === '' || typeof value === 'boolean') return safeFallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return safeFallback;
  return Math.min(cap, Math.max(1, Math.trunc(parsed)));
}
function truncate(value, cap, originalLength = value.length, trim = false) {
  const body = trim ? value.trim() : value;
  return originalLength <= cap ? body : `${body.slice(0, cap)}\n\n[output truncated; original ${originalLength} chars]`;
}
function parseStepLimit(stderr) {
  const match = String(stderr ?? '').match(/paused after\s+(\d+)\s+tool-call rounds?\s+\(max_steps\)/iu);
  return match ? Number(match[1]) : null;
}
function parseCursorError(stderr) {
  return /(?:continuation\s+)?cursor\s+(?:is\s+)?(?:not\s+valid|invalid|malformed)/iu.test(String(stderr ?? ''))
    || /read_file[^\n]{0,160}(?:cursor|continuation)/iu.test(String(stderr ?? ''));
}
function cliUsageUnavailable(reason = 'cli_usage_not_forwarded', source = 'cli') {
  return {
    status: 'unavailable',
    source,
    reason,
    prompt_tokens: null,
    completion_tokens: null,
    prompt_cache_hit_tokens: null,
    prompt_cache_miss_tokens: null,
  };
}
function parseJsonRecords(text) {
  const records = [];
  const value = String(text ?? '').trim();
  if (!value) return records;
  try { records.push(JSON.parse(value)); } catch { /* CLI output may be plain text or JSONL. */ }
  for (const line of value.split(/\r?\n/u)) {
    const candidate = line.trim().replace(/^data:\s*/iu, '');
    if (!candidate || candidate === value) continue;
    try { records.push(JSON.parse(candidate)); } catch { /* Ignore non-JSON worker lines. */ }
  }
  return records;
}
function collectUsageObjects(value, output = [], depth = 0) {
  if (!value || typeof value !== 'object' || depth > 3) return output;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 16)) collectUsageObjects(item, output, depth + 1);
    return output;
  }
  if (Object.hasOwn(value, 'usage') && value.usage && typeof value.usage === 'object') output.push(value.usage);
  if (Object.hasOwn(value, 'metrics') && value.metrics && typeof value.metrics === 'object') output.push(value.metrics);
  for (const key of ['result', 'response', 'data']) {
    if (value[key] && typeof value[key] === 'object') collectUsageObjects(value[key], output, depth + 1);
  }
  return output;
}
function usageInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function readUsageField(value, keys) {
  for (const key of keys) {
    const parsed = usageInteger(value?.[key]);
    if (parsed !== null) return parsed;
  }
  return null;
}
function normalizeCliUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const usage = {
    prompt_tokens: readUsageField(value, ['prompt_tokens', 'promptTokens', 'total_prompt_tokens']),
    completion_tokens: readUsageField(value, ['completion_tokens', 'completionTokens', 'generated_tokens', 'total_generated_tokens']),
    prompt_cache_hit_tokens: readUsageField(value, ['prompt_cache_hit_tokens', 'promptCacheHitTokens', 'cache_hit_tokens']),
    prompt_cache_miss_tokens: readUsageField(value, ['prompt_cache_miss_tokens', 'promptCacheMissTokens', 'cache_miss_tokens']),
  };
  if (Object.values(usage).every((item) => item === null)) return null;
  const hasHit = usage.prompt_cache_hit_tokens !== null;
  const hasMiss = usage.prompt_cache_miss_tokens !== null;
  if (hasHit && hasMiss) return { status: 'available', source: 'cli', ...usage };
  return { status: 'unavailable', source: 'cli', reason: 'cache_usage_not_forwarded', ...usage };
}
function cliUsageCompleteness(usage) {
  const fields = [
    'prompt_tokens',
    'completion_tokens',
    'prompt_cache_hit_tokens',
    'prompt_cache_miss_tokens',
  ];
  const fieldCount = fields.reduce((count, field) => count + (usage[field] !== null ? 1 : 0), 0);
  return [fieldCount, usage.status === 'available' ? 1 : 0];
}
function extractCliUsage(stdout, stderr, truncated) {
  if (truncated) return cliUsageUnavailable('cli_output_truncated');
  let best = null;
  let bestScore = [-1, -1];
  for (const text of [stdout, stderr]) {
    for (const record of parseJsonRecords(text)) {
      for (const candidate of [record, ...collectUsageObjects(record)]) {
        const usage = normalizeCliUsage(candidate);
        if (!usage) continue;
        const score = cliUsageCompleteness(usage);
        if (score[0] > bestScore[0] || (score[0] === bestScore[0] && score[1] > bestScore[1])) {
          best = usage;
          bestScore = score;
        }
      }
    }
  }
  return best ?? cliUsageUnavailable();
}
function workerFailureExtra(meta) {
  const extra = {};
  if (Number.isInteger(meta?.stepLimitRounds)) extra.stepLimitRounds = meta.stepLimitRounds;
  if (meta?.cursorError === true) extra.cursorError = true;
  return extra;
}
function cwdRootLabel(cwd) {
  const roots = allowedRoots();
  const index = roots.findIndex((root) => isInside(root, cwd));
  return index === 0 ? 'workspace' : index > 0 ? `allowed-${index}` : 'unknown';
}
let logFailureReported = false;
let lastRun = null;
function runSummary(entry) {
  const summary = {
    timestamp: new Date().toISOString(),
    mode: entry.mode,
    stage: entry.stage ?? stageForMode(entry.mode),
    operation: entry.operation ?? null,
    transport: entry.transport ?? 'per-call',
    transportFallback: entry.transportFallback ?? null,
    cwdRoot: entry.cwdRoot,
    maxSteps: entry.maxSteps,
    timeoutSeconds: entry.timeoutSeconds,
    outcome: entry.outcome,
    stepLimitRounds: Number.isInteger(entry.stepLimitRounds) ? entry.stepLimitRounds : null,
    cursorError: entry.cursorError === true,
    exitCode: entry.exitCode ?? null,
    elapsedMs: Number.isFinite(entry.elapsedMs) ? entry.elapsedMs : 0,
    outputBytes: Number.isFinite(entry.outputBytes) ? entry.outputBytes : 0,
    truncated: entry.truncated === true,
  };
  if (entry.usage !== undefined) summary.usage = entry.usage;
  else if (['inspect', 'review', 'plan', 'implement'].includes(entry.mode)) {
    summary.usage = cliUsageUnavailable(entry.transport === 'acp' ? 'acp_usage_not_forwarded' : undefined, entry.transport === 'acp' ? 'acp' : 'cli');
  }
  return summary;
}
function writeCallLog(record) {
  if (!BRIDGE_LOG_PATH) return;
  try { appendFileSync(BRIDGE_LOG_PATH, `${JSON.stringify(record)}\n`, 'utf8'); } catch (error) {
    if (!logFailureReported) {
      logFailureReported = true;
      log(`call log disabled after write failure: ${error.message}`);
    }
  }
}
function recordRun(entry) {
  const summary = runSummary(entry);
  lastRun = summary;
  writeCallLog(summary);
}
function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  if (process.platform === 'win32' && child.pid) return new Promise((resolve) => { const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); killer.once('close', resolve); killer.once('error', () => { child.kill('SIGKILL'); resolve(); }); });
  child.kill('SIGKILL');
  return Promise.resolve();
}
function runWorker({ cwd, maxSteps, timeoutSeconds, outputCharCap, task, mode, stage = stageForMode(mode) }, { record = true, checkpoint = mode !== 'implement', parentCheckpointId = null, cancelRef = null, transport = 'per-call', transportFallback = null } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const args = ['subagent', 'run', SUBAGENT_NAME, '--model', MODEL_REF, '--max-steps', String(maxSteps), '--dir', cwd, '--', task];
    const invocation = cliSpawnCommand(CLI_PATH, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    if (invocation.error) {
      const usage = cliUsageUnavailable();
      recordRun({ mode, stage, transport, transportFallback, cwdRoot: cwdRootLabel(cwd), maxSteps, timeoutSeconds, outcome: 'spawn_rejected', exitCode: null, usage, elapsedMs: Date.now() - startedAt, outputBytes: 0, truncated: false });
      resolve({ isError: true, text: invocation.error, meta: { outcome: 'spawn_rejected', stage, transport, transportFallback, usage, exitCode: null, elapsedMs: Date.now() - startedAt, outputBytes: 0, truncated: false } });
      return;
    }
    const child = spawn(invocation.file, invocation.args, invocation.options);
    let stdout = ''; let stderr = ''; let stdoutChars = 0; let stderrChars = 0; let settled = false; let truncatedOutput = false;
    let cancelRequested = false;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    const finish = (result, outcome, exitCode = null, extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (cancelRef) cancelRef.cancel = null;
      const finalOutcome = cancelRequested ? 'cancelled' : outcome;
      const finalResult = cancelRequested ? { isError: true, text: `worker cancelled after ${((Date.now() - startedAt) / 1000).toFixed(1)}s` } : result;
      const outputTruncated = truncatedOutput || stdoutChars > outputCharCap || stderrChars > outputCharCap;
      const usage = extractCliUsage(stdout, stderr, outputTruncated);
      if (record) recordRun({ mode, stage, transport, transportFallback, cwdRoot: cwdRootLabel(cwd), maxSteps, timeoutSeconds, outcome: finalOutcome, exitCode, ...extra, usage, elapsedMs: Date.now() - startedAt, outputBytes: Buffer.byteLength(stdout, 'utf8'), truncated: outputTruncated });
      resolve({ ...finalResult, meta: { outcome: finalOutcome, stage, transport, transportFallback, exitCode, ...extra, usage, elapsedMs: Date.now() - startedAt, outputBytes: Buffer.byteLength(stdout, 'utf8'), truncated: outputTruncated } });
    };
    const timer = setTimeout(async () => {
      if (settled) return;
      await terminate(child);
      if (settled) return;
      if (cancelRequested) {
        finish({ isError: true, text: '' }, 'cancelled', null);
        return;
      }
      const checkpointId = checkpoint
        ? await createRunCheckpoint({ mode, stage, task, cwd, maxSteps, timeoutSeconds, outcome: 'timeout', exitCode: null, parentCheckpointId })
        : null;
      const suffix = checkpointId ? `\n\ncheckpoint_id=${checkpointId}; call reasonix_resume to continue explicitly.` : '';
      finish({ isError: true, text: `worker timeout (${timeoutSeconds}s)\n${truncate(stderr, 2000, stderrChars)}${suffix}` }, 'timeout', null, checkpointId ? { checkpointId } : {});
    }, timeoutSeconds * 1000);
    if (cancelRef && typeof cancelRef === 'object') {
      cancelRef.cancel = () => {
        if (settled || cancelRequested) return;
        cancelRequested = true;
        void terminate(child);
      };
      if (cancelRef.requested) cancelRef.cancel();
    }
    child.stdout.on('data', (chunk) => {
      stdoutChars += chunk.length;
      const remaining = Math.max(0, outputCharCap * 2 - stdout.length);
      if (remaining > 0) stdout += chunk.slice(0, remaining);
      if (stdoutChars > outputCharCap) truncatedOutput = true;
    });
    child.stderr.on('data', (chunk) => {
      stderrChars += chunk.length;
      const remaining = Math.max(0, outputCharCap * 2 - stderr.length);
      if (remaining > 0) stderr += chunk.slice(0, remaining);
      if (stderrChars > outputCharCap) truncatedOutput = true;
    });
    child.on('error', (error) => finish({ isError: true, text: `cannot start reasonix CLI: ${error.message}` }, 'spawn_error'));
    child.on('close', async (code) => {
      if (settled) return;
      if (cancelRequested) {
        finish({ isError: true, text: '' }, 'cancelled', code);
        return;
      }
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1); const body = truncate(stdout, outputCharCap, stdoutChars, mode !== 'plan');
      if (code !== 0) {
        const stepLimitRounds = parseStepLimit(stderr);
        const cursorError = parseCursorError(stderr);
        const outcome = cursorError ? 'cursor_error' : stepLimitRounds === null ? 'worker_exit' : 'step_limit';
        const prefix = cursorError
          ? `worker reported a malformed or invalid read_file continuation cursor (${elapsed}s); re-read the file without reusing or editing the cursor. The bridge did not retry the task.`
          : stepLimitRounds === null
            ? `worker exited with code ${code} (${elapsed}s)`
            : `worker reached Reasonix max_steps=${maxSteps} after ${stepLimitRounds} tool-call rounds (${elapsed}s); timeout_seconds=${timeoutSeconds} was not reached. Increase max_steps or pass tool_rounds.`;
        const checkpointId = checkpoint
          ? await createRunCheckpoint({ mode, stage, task, cwd, maxSteps, timeoutSeconds, outcome, exitCode: code, stepLimitRounds, cursorError, parentCheckpointId })
          : null;
        const extra = { ...(stepLimitRounds === null ? {} : { stepLimitRounds }), ...(cursorError ? { cursorError: true } : {}), ...(checkpointId ? { checkpointId } : {}) };
        const stderrBody = cursorError ? '[cursor diagnostic redacted]' : truncate(stderr, 2000, stderrChars);
        const suffix = checkpointId ? `\n\ncheckpoint_id=${checkpointId}; call reasonix_resume to continue explicitly.` : '';
        finish({ isError: true, text: `${prefix}${body ? `\n\n--- stdout ---\n${body}` : ''}${stderrBody ? `\n\n--- stderr ---\n${stderrBody}` : ''}${suffix}` }, outcome, code, extra);
      }
      else finish({ isError: false, text: mode === 'plan' ? body : `[mode cwd=${cwd} model=${MODEL_REF} steps<=${maxSteps} elapsed=${elapsed}s]\n\n${body || '[worker returned no content]'}` }, 'success', 0);
    });
  });
}

async function runExec({ cwd, spec, args, timeoutSeconds, outputCharCap, stage = 'exec' }, cancelRef = null) {
  const startedAt = Date.now();
  const beforeStatus = await gitStatus(WORKSPACE_ROOT);
  if (!beforeStatus.ok) {
    recordRun({ mode: 'exec', stage, operation: spec.name, transport: 'local-exec', cwdRoot: cwdRootLabel(cwd), maxSteps: null, timeoutSeconds, outcome: 'workspace_unverifiable', exitCode: null, elapsedMs: Date.now() - startedAt, outputBytes: 0, truncated: false });
    return { isError: true, text: `reasonix_exec requires a verifiable Git workspace: ${beforeStatus.error}`, meta: { outcome: 'workspace_unverifiable', stage, transport: 'local-exec', exitCode: null, elapsedMs: Date.now() - startedAt, outputBytes: 0, truncated: false } };
  }
  if (EXEC_POLICY.requireCleanTree && beforeStatus.entries.length) {
    recordRun({ mode: 'exec', stage, operation: spec.name, transport: 'local-exec', cwdRoot: cwdRootLabel(cwd), maxSteps: null, timeoutSeconds, outcome: 'workspace_dirty', exitCode: null, elapsedMs: Date.now() - startedAt, outputBytes: 0, truncated: false });
    return { isError: true, text: `reasonix_exec requires a clean Git workspace (${beforeStatus.entries.length} existing change(s)); use an isolated worktree or commit/stash them first.`, meta: { outcome: 'workspace_dirty', stage, transport: 'local-exec', exitCode: null, elapsedMs: Date.now() - startedAt, outputBytes: 0, truncated: false } };
  }
  let executable;
  try { executable = resolveExecExecutable(spec); } catch (error) {
    recordRun({ mode: 'exec', stage, operation: spec.name, transport: 'local-exec', cwdRoot: cwdRootLabel(cwd), maxSteps: null, timeoutSeconds, outcome: 'spawn_rejected', exitCode: null, elapsedMs: Date.now() - startedAt, outputBytes: 0, truncated: false });
    return { isError: true, text: error.message, meta: { outcome: 'spawn_rejected', stage, transport: 'local-exec', exitCode: null, elapsedMs: Date.now() - startedAt, outputBytes: 0, truncated: false } };
  }
  const invocation = cliSpawnCommand(executable, [...spec.argsPrefix, ...args], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  if (invocation.error) {
    recordRun({ mode: 'exec', stage, operation: spec.name, transport: 'local-exec', cwdRoot: cwdRootLabel(cwd), maxSteps: null, timeoutSeconds, outcome: 'spawn_rejected', exitCode: null, elapsedMs: Date.now() - startedAt, outputBytes: 0, truncated: false });
    return { isError: true, text: invocation.error, meta: { outcome: 'spawn_rejected', stage, transport: 'local-exec', exitCode: null, elapsedMs: Date.now() - startedAt, outputBytes: 0, truncated: false } };
  }
  return new Promise((resolve) => {
    const child = spawn(invocation.file, invocation.args, invocation.options);
    let stdout = ''; let stderr = ''; let stdoutChars = 0; let stderrChars = 0; let truncatedOutput = false; let settled = false; let cancelRequested = false;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    const finish = async (outcome, exitCode = null, signal = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (cancelRef) cancelRef.cancel = null;
      const afterStatus = await gitStatus(WORKSPACE_ROOT);
      const changed = gitStatusChanged(beforeStatus, afterStatus);
      const workspaceModified = changed.length > 0;
      const finalOutcome = cancelRequested ? 'cancelled' : workspaceModified ? 'workspace_modified' : outcome;
      const payload = {
        schema: 'qlh.reasonix.exec.v1', command: spec.name, args: [...args], cwd: execPathLabel(cwd), outcome: finalOutcome,
        exitCode, signal, elapsedMs: Date.now() - startedAt, stdout: redactExecOutput(stdout), stderr: redactExecOutput(stderr),
        stdoutChars, stderrChars, truncated: truncatedOutput || stdoutChars > outputCharCap || stderrChars > outputCharCap, changedPaths: changed,
      };
      const outputBytes = Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8');
      recordRun({ mode: 'exec', stage, operation: spec.name, transport: 'local-exec', cwdRoot: cwdRootLabel(cwd), maxSteps: null, timeoutSeconds, outcome: finalOutcome, exitCode, elapsedMs: payload.elapsedMs, outputBytes, truncated: payload.truncated });
      resolve({ isError: finalOutcome !== 'success', text: JSON.stringify(payload), meta: { outcome: finalOutcome, stage, transport: 'local-exec', exitCode, elapsedMs: payload.elapsedMs, outputBytes, truncated: payload.truncated } });
    };
    const timer = setTimeout(async () => { await terminate(child); await finish('timeout'); }, timeoutSeconds * 1000);
    if (cancelRef && typeof cancelRef === 'object') {
      cancelRef.cancel = () => { if (settled || cancelRequested) return; cancelRequested = true; void terminate(child); };
      if (cancelRef.requested) cancelRef.cancel();
    }
    child.stdout.on('data', (chunk) => { stdoutChars += chunk.length; const remaining = Math.max(0, outputCharCap * 2 - stdout.length); if (remaining > 0) stdout += chunk.slice(0, remaining); if (stdoutChars > outputCharCap) truncatedOutput = true; });
    child.stderr.on('data', (chunk) => { stderrChars += chunk.length; const remaining = Math.max(0, outputCharCap * 2 - stderr.length); if (remaining > 0) stderr += chunk.slice(0, remaining); if (stderrChars > outputCharCap) truncatedOutput = true; });
    child.once('error', () => { void finish('spawn_error'); });
    child.once('close', (code, signal) => { void finish(code === 0 ? 'success' : 'nonzero', code, signal); });
  });
}
async function runImplement({ cwd, maxSteps, timeoutSeconds, outputCharCap, task, stage = 'implement' }, cancelRef = null) {
  const reject = (text, startedAt = Date.now()) => {
    const usage = cliUsageUnavailable();
    recordRun({ mode: 'implement', stage, cwdRoot: cwdRootLabel(cwd), maxSteps, timeoutSeconds, outcome: 'write_rejected', usage, exitCode: null, elapsedMs: Date.now() - startedAt, outputBytes: 0, truncated: false });
    return { isError: true, text, meta: { outcome: 'write_rejected', stage, usage, exitCode: null, elapsedMs: Date.now() - startedAt, outputBytes: 0, truncated: false } };
  };
  const startedAt = Date.now();
  if (!WRITE_POLICY.allowWrite) return reject('mode=implement is disabled; set allowWrite=true in bridge.config.json and pass mode=implement explicitly.', startedAt);
  if (WRITE_POLICY.errors.length) return reject(`mode=implement is disabled; invalid write policy: ${WRITE_POLICY.errors.join('; ')}`, startedAt);
  if (!WRITE_POLICY.allowedPaths.length) return reject('mode=implement is disabled; allowedPaths must contain at least one repository-relative path.', startedAt);
  const beforeStatus = await gitStatus(WORKSPACE_ROOT);
  if (!beforeStatus.ok) return reject(`mode=implement requires a verifiable Git workspace: ${beforeStatus.error}`, startedAt);
  const cleanTreePolicy = WRITE_POLICY.cleanTreePolicy;
  if (cleanTreePolicy === 'strict' && beforeStatus.entries.length) {
    return reject(`mode=implement requires a clean Git workspace (${beforeStatus.entries.length} existing change(s)) under cleanTreePolicy=strict; commit or stash them first, or switch to cleanTreePolicy="snapshot".`, startedAt);
  }
  let baseline = { ok: true, entries: [], error: '' };
  if (cleanTreePolicy === 'snapshot' && beforeStatus.entries.length) {
    baseline = snapshotWriteBaseline(WORKSPACE_ROOT, beforeStatus.entries, pathMatchesAllowed);
    if (!baseline.ok) return reject(`mode=implement refused to snapshot pre-existing changes: ${baseline.error}`, startedAt);
  }
  const result = await runWorker({ cwd, maxSteps, timeoutSeconds, outputCharCap, task, mode: 'implement', stage }, { record: false, cancelRef });
  const afterStatus = await gitStatus(WORKSPACE_ROOT);
  if (!afterStatus.ok) {
    recordRun({ mode: 'implement', stage, cwdRoot: cwdRootLabel(cwd), maxSteps, timeoutSeconds, outcome: 'write_rejected', usage: result.meta?.usage, exitCode: result.meta?.exitCode ?? null, ...workerFailureExtra(result.meta), elapsedMs: Date.now() - startedAt, outputBytes: result.meta?.outputBytes ?? 0, truncated: result.meta?.truncated === true });
    return { isError: true, text: `mode=implement could not verify post-write Git state: ${afterStatus.error}`, meta: { ...result.meta, stage, outcome: 'write_rejected' } };
  }
  const changed = changedEntries(beforeStatus.entries, afterStatus.entries);
  if (baseline.entries.length) {
    // Status-code diffs miss edits to paths that were already dirty in the same
    // way before the call; compare those against the write baseline content.
    const changedPaths = new Set(changed.map((entry) => entry.path));
    const baselineByPath = new Map(baseline.entries.map((entry) => [entry.path, entry]));
    for (const entry of afterStatus.entries) {
      if (changedPaths.has(entry.path)) continue;
      const known = baselineByPath.get(entry.path);
      if (!known) continue;
      const current = await hashFile(path.join(WORKSPACE_ROOT, entry.path));
      const differs = known.kind === 'absent'
        ? current.status !== 'missing'
        : current.status !== 'readable' || current.sha256 !== known.sha256;
      if (differs) {
        changed.push(entry);
        changedPaths.add(entry.path);
      }
    }
  }
  const disallowed = changed.filter((entry) => !pathMatchesAllowed(entry.path));
  const mustRollback = disallowed.length > 0 || result.isError;
  if (mustRollback && changed.length) {
    const rollback = await rollbackEntries(WORKSPACE_ROOT, changed, baseline.entries);
    const reason = disallowed.length
      ? `write touched paths outside allowedPaths: ${disallowed.map((entry) => entry.path).join(', ')}`
      : `worker failed: ${result.text}`;
    const rollbackText = rollback.ok ? 'rollback completed' : `rollback failed: ${rollback.error}`;
    const outcome = disallowed.length ? 'write_rejected' : (result.meta?.outcome ?? 'worker_exit');
    const checkpointId = !disallowed.length && rollback.ok && checkpointableOutcome(outcome)
      ? await createRunCheckpoint({ mode: 'implement', stage, task, cwd, maxSteps, timeoutSeconds, outcome, exitCode: result.meta?.exitCode ?? null, stepLimitRounds: result.meta?.stepLimitRounds, cursorError: result.meta?.cursorError })
      : null;
    recordRun({ mode: 'implement', stage, cwdRoot: cwdRootLabel(cwd), maxSteps, timeoutSeconds, outcome, usage: result.meta?.usage, exitCode: result.meta?.exitCode ?? null, ...workerFailureExtra(result.meta), elapsedMs: Date.now() - startedAt, outputBytes: result.meta?.outputBytes ?? 0, truncated: result.meta?.truncated === true });
    return { isError: true, text: JSON.stringify({ schema: 'qlh.reasonix.changes.v1', rollback_id: null, ...(checkpointId ? { checkpoint_id: checkpointId } : {}), outcome, error: `${reason}; ${rollbackText}`, changes: [] }), meta: { ...result.meta, stage, outcome, ...(checkpointId ? { checkpointId } : {}) } };
  }
  if (result.isError) {
    const outcome = result.meta?.outcome ?? 'worker_exit';
    const checkpointId = checkpointableOutcome(outcome)
      ? await createRunCheckpoint({ mode: 'implement', stage, task, cwd, maxSteps, timeoutSeconds, outcome, exitCode: result.meta?.exitCode ?? null, stepLimitRounds: result.meta?.stepLimitRounds, cursorError: result.meta?.cursorError })
      : null;
    recordRun({ mode: 'implement', stage, cwdRoot: cwdRootLabel(cwd), maxSteps, timeoutSeconds, outcome, exitCode: result.meta?.exitCode ?? null, ...workerFailureExtra(result.meta), elapsedMs: Date.now() - startedAt, outputBytes: result.meta?.outputBytes ?? 0, truncated: result.meta?.truncated === true });
    return { isError: true, text: JSON.stringify({ schema: 'qlh.reasonix.changes.v1', rollback_id: null, ...(checkpointId ? { checkpoint_id: checkpointId } : {}), outcome, error: 'worker failed; no changes were retained', changes: [] }), meta: { ...result.meta, stage, ...(checkpointId ? { checkpointId } : {}) } };
  }
  const changeSet = await buildChangeSet(WORKSPACE_ROOT, changed);
  const rollbackId = rememberRollback(WORKSPACE_ROOT, changeSet.changes);
  if (rollbackId && baseline.entries.length) {
    const record = rollbackRecords.get(rollbackId);
    if (record) record.baseline = rollbackRecordSnapshot(baseline.entries);
  }
  changeSet.rollback_id = rollbackId;
  recordRun({ mode: 'implement', stage, cwdRoot: cwdRootLabel(cwd), maxSteps, timeoutSeconds, outcome: 'success', usage: result.meta?.usage, exitCode: 0, elapsedMs: Date.now() - startedAt, outputBytes: result.meta?.outputBytes ?? 0, truncated: result.meta?.truncated === true });
  return { isError: false, text: JSON.stringify(changeSet), meta: { ...result.meta, stage, outcome: 'success', rollbackId } };
}

const ACP_SECURITY = new AcpSecurityPolicy({
  workspaceRoot: WORKSPACE_ROOT,
  allowedRoots: allowedRoots(),
  writePolicy: WRITE_POLICY,
  requireScope: true,
});
const ACP_TRANSPORT = new AcpTransportManager({
  clientFactory: ({ cwd, timeoutMs }) => new AcpClient({
    cliPath: CLI_PATH,
    modelRef: MODEL_REF,
    cwd,
    workspaceOnly: true,
    timeoutMs: timeoutMs ?? 30_000,
  }),
  fallback: (request, context) => runWorker(
    { cwd: request.cwd, maxSteps: request.maxSteps, timeoutSeconds: request.timeoutSeconds, outputCharCap: request.outputCharCap, task: request.task, mode: request.mode, stage: request.stage },
    { cancelRef: context.cancelRef, transport: 'per-call', transportFallback: context.reason },
  ),
  securityPolicy: ACP_SECURITY,
  outputCharCap: LIMITS.outputCharCap,
});
async function runAcp(request, cancelRef) {
  try {
    const result = await ACP_TRANSPORT.run({ ...request, cancelRef, timeoutMs: request.timeoutSeconds * 1000 });
    if (result.meta?.transport === 'acp') {
      recordRun({ mode: request.mode, stage: request.stage, transport: result.meta.transport, transportFallback: result.meta.transportFallback ?? null, cwdRoot: cwdRootLabel(request.cwd), maxSteps: request.maxSteps, timeoutSeconds: request.timeoutSeconds, outcome: result.meta.outcome ?? (result.isError ? 'worker_exit' : 'success'), exitCode: result.meta.exitCode ?? null, elapsedMs: result.meta.elapsedMs ?? 0, outputBytes: result.meta.outputBytes ?? 0, truncated: result.meta.truncated === true });
    }
    return result;
  } catch (error) {
    const outcome = error?.code?.startsWith?.('session_scope_') || error?.code?.startsWith?.('write_') || error?.code?.startsWith?.('read_mode_') ? 'rejected' : 'acp_error';
    recordRun({ mode: request.mode, stage: request.stage, transport: 'acp', cwdRoot: cwdRootLabel(request.cwd), maxSteps: request.maxSteps, timeoutSeconds: request.timeoutSeconds, outcome, exitCode: null, elapsedMs: 0, outputBytes: 0, truncated: false });
    return { isError: true, text: error instanceof Error ? error.message : String(error), meta: { outcome, stage: request.stage, transport: 'acp', exitCode: null, elapsedMs: 0, outputBytes: 0, truncated: false } };
  }
}
async function resumeCheckpoint(checkpointId, args = {}, cancelRef = null) {
  if (!CHECKPOINT_ENABLED) return { isError: true, text: 'checkpoint resume is disabled because the checkpoint directory is inside the workspace.' };
  const loaded = readCheckpoint(CHECKPOINT_DIR, checkpointId);
  if (!loaded.ok) return { isError: true, text: `cannot resume checkpoint: ${loaded.error}` };
  const checkpoint = loaded.value;
  if (checkpoint.status !== 'ready') return { isError: true, text: 'cannot resume checkpoint: checkpoint has already been consumed' };
  if (!['inspect', 'review', 'plan', 'implement'].includes(checkpoint.mode)) return { isError: true, text: 'cannot resume checkpoint: mode is invalid' };
  let cwd;
  try { cwd = resolveCwd(checkpoint.cwd); } catch (error) { return { isError: true, text: `cannot resume checkpoint: ${error.message}` }; }
  const drift = await validateCheckpointForResume(checkpoint);
  if (drift) return { isError: true, text: `cannot resume checkpoint: ${drift}` };
  if (checkpoint.mode !== 'implement' && SUBAGENT_ROLE.role !== 'read') return { isError: true, text: `resume mode=${checkpoint.mode} requires a read-role subagent; selected role is ${SUBAGENT_ROLE.role}.` };
  if (checkpoint.mode === 'implement' && SUBAGENT_ROLE.role !== 'write') return { isError: true, text: 'resume mode=implement requires an explicit write-role subagent.' };
  let task;
  try { task = resumeTask(checkpoint); } catch (error) { return { isError: true, text: `cannot resume checkpoint: ${error.message}` }; }
  const maxToolRounds = Math.floor(LIMITS.maxStepsCap / REASONIX_STEPS_PER_TOOL_ROUND);
  const maxSteps = args.tool_rounds === undefined
    ? clampInteger(args.max_steps, checkpoint.maxSteps, LIMITS.maxStepsCap)
    : clampInteger(args.tool_rounds, Math.ceil(checkpoint.maxSteps / REASONIX_STEPS_PER_TOOL_ROUND), maxToolRounds) * REASONIX_STEPS_PER_TOOL_ROUND;
  const timeoutSeconds = clampInteger(args.timeout_seconds, checkpoint.timeoutSeconds, LIMITS.timeoutSecondsCap);
  const stage = checkpoint.stage ?? stageForMode(checkpoint.mode);
  try { consumeCheckpoint(CHECKPOINT_DIR, checkpoint); } catch (error) { return { isError: true, text: `cannot resume checkpoint: could not mark it consumed (${error.message})` }; }
  return checkpoint.mode === 'implement'
    ? runImplement({ cwd, maxSteps, timeoutSeconds, outputCharCap: LIMITS.outputCharCap, task, stage }, cancelRef)
    : runWorker({ cwd, maxSteps, timeoutSeconds, outputCharCap: LIMITS.outputCharCap, task, mode: checkpoint.mode, stage }, { parentCheckpointId: checkpoint.id, cancelRef });
}
function estimateTaskTokens(task) {
  return Math.max(1, Math.ceil(Buffer.byteLength(task, 'utf8') / 4));
}
const MAX_JOB_RECORDS = 64;
const MAX_JOB_EVENTS = 32;
const jobQueue = [];
const jobRecords = new Map();
const jobEvents = new Map();
let queueDepth = 0;
let inFlight = 0;
let parallelActive = 0;
let exclusiveActive = 0;
function retryHint() {
  const seconds = lastRun?.elapsedMs > 0 ? Math.max(1, Math.ceil(lastRun.elapsedMs / 1000)) : 1;
  return `retry after about ${seconds}s`;
}
function jobSummary(record) {
  return {
    jobId: record.id,
    mode: record.mode,
    stage: record.stage ?? stageForMode(record.mode),
    transport: record.transport ?? 'per-call',
    transportFallback: record.transportFallback ?? null,
    cwdRoot: record.cwdRoot,
    parallel: record.parallel,
    exclusive: record.exclusive,
    state: record.state,
    outcome: record.outcome,
    maxSteps: record.maxSteps,
    timeoutSeconds: record.timeoutSeconds,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    reclaimedAt: record.reclaimedAt,
    cancelRequested: record.cancelRequested,
    exitCode: record.exitCode,
    stepLimitRounds: record.stepLimitRounds,
    cursorError: record.cursorError,
    checkpointId: record.checkpointId,
    eventCount: jobEvents.get(record.id)?.length ?? 0,
  };
}
function pruneJobRecords() {
  while (jobRecords.size > MAX_JOB_RECORDS) {
    const candidate = [...jobRecords.values()].find((record) => ['completed', 'failed', 'cancelled'].includes(record.state));
    if (!candidate) return;
    jobRecords.delete(candidate.id);
    jobEvents.delete(candidate.id);
  }
}
function recordJobEvent(record, type) {
  const events = jobEvents.get(record.id) ?? [];
  const event = {
    jobId: record.id,
    seq: (events.at(-1)?.seq ?? 0) + 1,
    type,
    mode: record.mode,
    stage: record.stage ?? stageForMode(record.mode),
    state: record.state,
    outcome: record.outcome,
    maxSteps: record.maxSteps,
    timeoutSeconds: record.timeoutSeconds,
    stepLimitRounds: record.stepLimitRounds,
    cancelRequested: record.cancelRequested === true,
    queueDepth,
    inFlight,
    parallelActive,
    exclusiveActive,
    at: new Date().toISOString(),
  };
  events.push(event);
  if (events.length > MAX_JOB_EVENTS) events.splice(0, events.length - MAX_JOB_EVENTS);
  jobEvents.set(record.id, events);
}
function settleJobRecord(record, result) {
  const meta = result?.meta ?? {};
  const outcome = meta.outcome ?? (result?.isError ? 'worker_exit' : 'success');
  record.outcome = outcome;
  record.state = outcome === 'success' ? 'completed' : outcome === 'cancelled' ? 'cancelled' : 'failed';
  record.exitCode = meta.exitCode ?? null;
  record.stepLimitRounds = Number.isInteger(meta.stepLimitRounds) ? meta.stepLimitRounds : null;
  record.cursorError = meta.cursorError === true;
  record.checkpointId = meta.checkpointId ?? null;
  record.endedAt = new Date().toISOString();
  record.reclaimedAt = record.endedAt;
  record.reclaimed = true;
  record.cancel = null;
  recordJobEvent(record, record.state === 'completed' ? 'completed' : record.state === 'cancelled' ? 'cancelled' : 'failed');
}
function attachJobMeta(result, record) {
  return { ...result, meta: { ...(result?.meta ?? {}), jobId: record.id } };
}
function startJob(item) {
  const { record } = item;
  record.state = 'running';
  record.startedAt = new Date().toISOString();
  inFlight += 1;
  if (record.exclusive) exclusiveActive += 1;
  else parallelActive += 1;
  recordJobEvent(record, 'started');
  const cancelRef = { requested: false, cancel: null };
  record.cancel = () => {
    record.cancelRequested = true;
    cancelRef.requested = true;
    if (typeof cancelRef.cancel === 'function') cancelRef.cancel();
  };
  Promise.resolve()
    .then(() => item.job(cancelRef))
    .then((result) => {
      settleJobRecord(record, result);
      item.resolve(attachJobMeta(result, record));
    }, (error) => {
      const result = { isError: true, text: `job failed: ${error?.message ?? error}`, meta: { outcome: 'worker_exit', exitCode: null, elapsedMs: 0, outputBytes: 0, truncated: false } };
      settleJobRecord(record, result);
      item.resolve(attachJobMeta(result, record));
    })
    .finally(() => {
      inFlight -= 1;
      if (record.exclusive) exclusiveActive -= 1;
      else parallelActive -= 1;
      queueDepth -= 1;
      pruneJobRecords();
      pumpJobs();
    });
}
function pumpJobs() {
  if (exclusiveActive > 0) return;
  if (jobQueue[0]?.record.exclusive) {
    if (parallelActive === 0) startJob(jobQueue.shift());
    return;
  }
  while (jobQueue.length && !jobQueue[0].record.exclusive && parallelActive < LIMITS.queueCap) startJob(jobQueue.shift());
}
function enqueue(job, meta, { parallel = false, exclusive = true } = {}) {
  if (queueDepth >= LIMITS.queueCap) {
    recordRun({ ...meta, outcome: 'queue_rejected', elapsedMs: 0, outputBytes: 0, truncated: false });
    return Promise.resolve({ isError: true, text: `too many queued requests (depth=${queueDepth}, cap=${LIMITS.queueCap}); ${retryHint()}`, meta: { outcome: 'queue_rejected', exitCode: null, elapsedMs: 0, outputBytes: 0, truncated: false } });
  }
  const record = {
    id: randomUUID(),
    mode: meta.mode,
    stage: meta.stage ?? stageForMode(meta.mode),
    transport: meta.transport ?? 'per-call',
    transportFallback: meta.transportFallback ?? null,
    cwdRoot: meta.cwdRoot,
    maxSteps: meta.maxSteps,
    timeoutSeconds: meta.timeoutSeconds,
    parallel,
    exclusive,
    state: 'queued',
    outcome: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    endedAt: null,
    reclaimedAt: null,
    reclaimed: false,
    cancelRequested: false,
    cancel: null,
    exitCode: null,
    stepLimitRounds: null,
    cursorError: false,
    checkpointId: null,
  };
  let resolveResult;
  const resultPromise = new Promise((resolve) => { resolveResult = resolve; });
  const item = { job, record, resolve: resolveResult };
  record.item = item;
  jobRecords.set(record.id, record);
  jobEvents.set(record.id, []);
  queueDepth += 1;
  jobQueue.push(item);
  recordJobEvent(record, 'queued');
  pumpJobs();
  return resultPromise;
}
function cancelJob(jobId) {
  const value = typeof jobId === 'string' ? jobId.trim() : '';
  if (!value) return { isError: true, text: 'job_id is required' };
  const record = jobRecords.get(value);
  if (!record) return { isError: true, text: 'job_id is unknown or has expired' };
  if (record.state !== 'queued' && record.state !== 'running') {
    return { isError: false, text: `job_id=${value} is already ${record.state}`, meta: { jobId: value, outcome: record.outcome } };
  }
  const wasCancelRequested = record.cancelRequested === true;
  record.cancelRequested = true;
  if (record.state === 'queued') {
    const index = jobQueue.findIndex((item) => item.record.id === value);
    if (index < 0) return { isError: true, text: 'job_id is no longer queued; inspect reasonix_status' };
    const [item] = jobQueue.splice(index, 1);
    const result = { isError: true, text: `job cancelled before start (job_id=${value})`, meta: { outcome: 'cancelled', exitCode: null, elapsedMs: 0, outputBytes: 0, truncated: false } };
    record.outcome = 'cancelled';
    record.state = 'cancelled';
    record.endedAt = new Date().toISOString();
    record.reclaimedAt = record.endedAt;
    record.reclaimed = true;
    queueDepth -= 1;
    recordJobEvent(record, 'cancelled');
    recordRun({ mode: record.mode, cwdRoot: record.cwdRoot, maxSteps: record.maxSteps, timeoutSeconds: record.timeoutSeconds, outcome: 'cancelled', exitCode: null, elapsedMs: 0, outputBytes: 0, truncated: false });
    item.resolve(attachJobMeta(result, record));
    pumpJobs();
    return { isError: false, text: result.text, meta: { jobId: value, outcome: 'cancelled' } };
  }
  if (typeof record.cancel === 'function') {
    if (!wasCancelRequested) recordJobEvent(record, 'cancellation_requested');
    record.cancel();
    return { isError: false, text: `cancellation requested (job_id=${value})`, meta: { jobId: value, outcome: 'cancellation_requested' } };
  }
  return { isError: true, text: `job_id=${value} is running but cannot be cancelled safely` };
}
function jobStatus() {
  return [...jobRecords.values()].map(jobSummary);
}
function pollJobEvents(args = {}) {
  const jobId = typeof args.job_id === 'string' ? args.job_id.trim() : '';
  if (!jobId) return { isError: true, text: 'job_id is required' };
  const record = jobRecords.get(jobId);
  if (!record) return { isError: true, text: 'job_id is unknown or has expired' };
  const afterSeq = args.after_seq === undefined ? 0 : args.after_seq;
  if (!Number.isInteger(afterSeq) || afterSeq < 0) return { isError: true, text: 'after_seq must be a non-negative integer' };
  const limit = args.limit === undefined ? 32 : args.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 64) return { isError: true, text: 'limit must be an integer between 1 and 64' };
  const events = jobEvents.get(jobId) ?? [];
  const pending = events.filter((event) => event.seq > afterSeq);
  const selected = pending.slice(0, limit);
  const terminal = ['completed', 'failed', 'cancelled'].includes(record.state);
  return {
    isError: false,
    text: JSON.stringify({
      schema: 'qlh.reasonix.events.v1',
      jobId,
      events: selected,
      nextSeq: selected.at(-1)?.seq ?? afterSeq,
      latestSeq: events.at(-1)?.seq ?? 0,
      hasMore: selected.length < pending.length,
      terminal,
      state: record.state,
      eventCount: events.length,
    }, null, 2),
    meta: { jobId, outcome: terminal ? record.outcome : null },
  };
}

function execRequest(args = {}) {
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  if (!command) throw new Error('command is required');
  if (!EXEC_POLICY.enabled) throw new Error('reasonix_exec is disabled; set execPolicy.enabled=true with an explicit command allowlist.');
  if (EXEC_POLICY.errors.length) throw new Error(`reasonix_exec policy is invalid: ${EXEC_POLICY.errors.join('; ')}`);
  const spec = EXEC_POLICY.commands.find((entry) => entry.name === command);
  if (!spec) throw new Error(`reasonix_exec command is not allowlisted: ${command}`);
  const rawArgs = args.args === undefined ? [] : args.args;
  if (!Array.isArray(rawArgs)) throw new Error('args must be an array of strings');
  if (rawArgs.length > spec.maxArgs) throw new Error(`args exceeds command maxArgs=${spec.maxArgs}`);
  if (rawArgs.some((value) => typeof value !== 'string' || value.length > 4096 || value.includes('\0'))) throw new Error('args must contain strings up to 4096 characters without NUL');
  let cwd;
  try {
    const defaultCwd = EXEC_POLICY.allowedPaths[0] ? path.join(WORKSPACE_ROOT, EXEC_POLICY.allowedPaths[0]) : WORKSPACE_ROOT;
    cwd = resolveCwd(args.cwd === undefined ? defaultCwd : args.cwd);
  } catch (error) { throw new Error(`invalid exec cwd: ${error.message}`); }
  if (!execCwdAllowed(cwd)) throw new Error(`exec cwd is outside execPolicy.allowedPaths: ${execPathLabel(cwd)}`);
  const timeoutCap = Math.min(EXEC_POLICY.timeoutSeconds, LIMITS.timeoutSecondsCap, EXEC_HARD_TIMEOUT_SECONDS_CAP);
  const outputCap = Math.min(EXEC_POLICY.outputCharCap, LIMITS.outputCharCap, EXEC_HARD_OUTPUT_CHAR_CAP);
  const timeoutSeconds = clampInteger(args.timeout_seconds, timeoutCap, timeoutCap);
  const outputCharCap = clampInteger(args.output_char_cap, outputCap, outputCap);
  return { cwd, spec, args: [...rawArgs], timeoutSeconds, outputCharCap };
}

async function callTool(name, args) {
  if (name === 'reasonix_resume') {
    const checkpointId = typeof args?.checkpoint_id === 'string' ? args.checkpoint_id.trim() : '';
    return enqueue((cancelRef) => resumeCheckpoint(checkpointId, args, cancelRef), { mode: 'resume', cwdRoot: 'workspace', maxSteps: null, timeoutSeconds: null });
  }
  if (name === 'reasonix_cancel') {
    return cancelJob(args?.job_id);
  }
  if (name === 'reasonix_events') {
    return pollJobEvents(args);
  }
  if (name === 'reasonix_rollback') {
    const rollbackId = typeof args?.rollback_id === 'string' ? args.rollback_id.trim() : '';
    const record = rollbackRecords.get(rollbackId);
    if (!record) return explicitRollback(rollbackId);
    return enqueue(() => explicitRollback(rollbackId), { mode: 'rollback', cwdRoot: cwdRootLabel(record.root), maxSteps: null, timeoutSeconds: null });
  }
  if (name === 'reasonix_exec') {
    const startedAt = Date.now();
    const operation = typeof args?.command === 'string' ? args.command.trim() : null;
    const stageResult = resolveWorkflowStage(args?.stage, 'exec', operation);
    if (stageResult.error) {
      recordRun({ mode: 'exec', stage: 'exec', operation, transport: 'local-exec', cwdRoot: 'unknown', maxSteps: null, timeoutSeconds: null, outcome: 'rejected', exitCode: null, elapsedMs: Date.now() - startedAt, outputBytes: 0, truncated: false });
      return { isError: true, text: stageResult.error, meta: { outcome: 'rejected', stage: 'exec', transport: 'local-exec', exitCode: null, elapsedMs: Date.now() - startedAt, outputBytes: 0, truncated: false } };
    }
    let request;
    try { request = execRequest(args); } catch (error) {
      recordRun({ mode: 'exec', stage: stageResult.stage, operation, transport: 'local-exec', cwdRoot: 'unknown', maxSteps: null, timeoutSeconds: null, outcome: 'rejected', exitCode: null, elapsedMs: Date.now() - startedAt, outputBytes: 0, truncated: false });
      return { isError: true, text: error.message, meta: { outcome: 'rejected', stage: stageResult.stage, transport: 'local-exec', exitCode: null, elapsedMs: Date.now() - startedAt, outputBytes: 0, truncated: false } };
    }
    const meta = { mode: 'exec', stage: stageResult.stage, transport: 'local-exec', cwdRoot: cwdRootLabel(request.cwd), maxSteps: null, timeoutSeconds: request.timeoutSeconds };
    log(`exec command=${request.spec.name} cwd=${request.cwd} timeout=${request.timeoutSeconds}s`);
    return enqueue((cancelRef) => runExec({ ...request, stage: stageResult.stage }, cancelRef), meta, { exclusive: true });
  }
  if (name === 'reasonix_status') return { isError: false, text: JSON.stringify({ cli: CLI_PATH, cliExists: existsSync(CLI_PATH), version: VERSION_CHECK.version, versionCheck: VERSION_CHECK.status, versionMinimum: VERSION_CHECK.minimum, versionCheckError: VERSION_CHECK.error || null, versionCheckWarning: VERSION_CHECK.warning || null, workspaceRoot: WORKSPACE_ROOT, allowedRoots: allowedRoots(), subagent: SUBAGENT_NAME, subagentSource: SUBAGENT.source, subagentRole: SUBAGENT_ROLE.role, subagentRoleSource: SUBAGENT_ROLE.source, modelRef: MODEL_REF, modelRefSource: MODEL_REF_SOURCE, provider: MODEL_CAPABILITIES.provider, model: MODEL_CAPABILITIES.model, contextWindow: MODEL_CAPABILITIES.contextWindow, vision: MODEL_CAPABILITIES.vision, base_url_host: MODEL_CAPABILITIES.base_url_host, providerCapabilities: MODEL_CAPABILITIES, providerSearch: PROVIDER_SEARCH, bridgeConfig: bridgeConfig.path, workerReadOnlyAssumed: SUBAGENT_ROLE.role === 'read', historyMode: TRANSPORT.mode === 'acp' ? 'acp-opt-in-with-per-call-fallback' : 'stateless-per-call', historyHardCapBytes: HISTORY_HARD_CAP_BYTES, transport: { configured: TRANSPORT.mode, source: TRANSPORT.source, error: TRANSPORT.error || null, acp: ACP_TRANSPORT.status }, checkpoint: { enabled: CHECKPOINT_ENABLED, readyCount: CHECKPOINT_ENABLED ? countReadyCheckpoints(CHECKPOINT_DIR) : 0 }, workflow: workflowStatus(jobStatus(), lastRun), modes: Object.keys(MODES), modeDefaults: modeBudgetStatus(), writePolicy: { allowWrite: WRITE_POLICY.allowWrite, enabled: WRITE_POLICY.enabled, allowedPaths: WRITE_POLICY.allowedPaths, cleanTreePolicy: WRITE_POLICY.cleanTreePolicy, cleanTreePolicySource: WRITE_POLICY.cleanTreePolicySource, errors: WRITE_POLICY.errors }, execPolicy: { configured: EXEC_POLICY.configured, enabled: EXEC_POLICY.enabled && EXEC_POLICY.errors.length === 0, allowedPaths: EXEC_POLICY.allowedPaths.map((entry) => entry || '.'), commands: EXEC_POLICY.commands.map((entry) => ({ name: entry.name, argsPrefix: entry.argsPrefix, maxArgs: entry.maxArgs })), requireCleanTree: EXEC_POLICY.requireCleanTree, timeoutSeconds: EXEC_POLICY.timeoutSeconds, outputCharCap: EXEC_POLICY.outputCharCap, errors: EXEC_POLICY.errors }, pendingRollbackCount: rollbackRecords.size, queueDepth, inFlight, parallelActive, exclusiveActive, jobs: jobStatus(), lastRun, limits: { maxStepsCap: LIMITS.maxStepsCap, toolRoundsCap: Math.floor(LIMITS.maxStepsCap / REASONIX_STEPS_PER_TOOL_ROUND), taskCharCap: TASK_CHAR_CAP, timeoutSecondsCap: LIMITS.timeoutSecondsCap, outputCharCap: LIMITS.outputCharCap, queueCap: LIMITS.queueCap } }, null, 2) };
  if (name !== 'reasonix_run') throw new Error(`unknown tool: ${name}`);
  const startedAt = Date.now();
  const mode = args?.mode === undefined ? 'inspect' : String(args.mode);
  const stageResult = resolveWorkflowStage(args?.stage, mode);
  const logRejected = (error) => recordRun({ mode: ['inspect', 'review', 'implement', 'plan'].includes(mode) ? mode : 'invalid', stage: stageResult.stage, cwdRoot: 'unknown', maxSteps: null, timeoutSeconds: null, outcome: 'rejected', exitCode: null, elapsedMs: Date.now() - startedAt, outputBytes: 0, truncated: false, error });
  const task = typeof args?.task === 'string' ? args.task.trim() : '';
  if (!task) { logRejected('task_required'); throw new Error('task is required'); }
  if (task.length > TASK_CHAR_CAP) { logRejected('task_too_long'); throw new Error(`task exceeds ${TASK_CHAR_CAP} chars`); }
  if (stageResult.error) { logRejected('stage_invalid'); throw new Error(stageResult.error); }
  if (mode === 'implement' && !WRITE_POLICY.allowWrite) { logRejected('implement_disabled'); return { isError: true, text: 'mode=implement is disabled; set allowWrite=true in bridge.config.json and pass mode=implement explicitly.' }; }
  if (MODEL_CAPABILITIES.contextWindow !== null) {
    const estimatedTokens = estimateTaskTokens(task);
    if (estimatedTokens > MODEL_CAPABILITIES.contextWindow) {
      logRejected('context_window_exceeded');
      throw new Error(`task exceeds model context window (estimated ${estimatedTokens} tokens; limit ${MODEL_CAPABILITIES.contextWindow} tokens)`);
    }
  }
  const preset = MODES[mode];
  if (!preset) { logRejected('mode_invalid'); throw new Error(`mode must be one of ${Object.keys(MODES).join(', ')}`); }
  if (mode !== 'implement' && SUBAGENT_ROLE.role !== 'read') {
    logRejected('write_profile_not_allowed');
    return { isError: true, text: `mode=${mode} requires a read-role subagent; selected role is ${SUBAGENT_ROLE.role}.` };
  }
  if (mode === 'implement' && SUBAGENT_ROLE.role !== 'write') {
    logRejected('write_profile_required');
    return { isError: true, text: 'mode=implement requires an explicit write-role subagent.' };
  }
  let cwd;
  try { cwd = resolveCwd(args?.cwd); } catch (error) { logRejected('cwd_invalid'); throw error; }
  const maxToolRounds = Math.floor(LIMITS.maxStepsCap / REASONIX_STEPS_PER_TOOL_ROUND);
  const maxSteps = args?.tool_rounds === undefined
    ? clampInteger(args?.max_steps, preset.maxSteps, LIMITS.maxStepsCap)
    : clampInteger(args.tool_rounds, Math.ceil(preset.maxSteps / REASONIX_STEPS_PER_TOOL_ROUND), maxToolRounds) * REASONIX_STEPS_PER_TOOL_ROUND;
  const timeoutSeconds = clampInteger(args?.timeout_seconds, preset.timeoutSeconds, LIMITS.timeoutSecondsCap);
  const parallel = args?.parallel === true;
  if (parallel && mode === 'implement') {
    logRejected('parallel_implement_disallowed');
    return { isError: true, text: 'parallel=true is only available for read-only inspect, review, or plan jobs; implement remains workspace-exclusive.' };
  }
  const useAcp = TRANSPORT.mode === 'acp' && !parallel && mode !== 'implement';
  const transport = useAcp ? 'acp' : 'per-call';
  const meta = { mode, stage: stageResult.stage, transport, cwdRoot: cwdRootLabel(cwd), maxSteps, timeoutSeconds };
  log(`run mode=${mode} cwd=${cwd} steps<=${maxSteps} timeout=${timeoutSeconds}s parallel=${parallel} transport=${transport}`); return enqueue((cancelRef) => useAcp
    ? runAcp({ sessionId: args?.session_id, taskId: args?.session_id, owner: 'mcp-stdio', cwd, profile: SUBAGENT_NAME, model: MODEL_REF, maxSteps, timeoutSeconds, outputCharCap: LIMITS.outputCharCap, task, mode, stage: stageResult.stage }, cancelRef)
    : mode === 'implement'
      ? runImplement({ cwd, maxSteps, timeoutSeconds, outputCharCap: LIMITS.outputCharCap, task, stage: stageResult.stage }, cancelRef)
      : runWorker({ cwd, maxSteps, timeoutSeconds, outputCharCap: LIMITS.outputCharCap, task, mode, stage: stageResult.stage }, { cancelRef }), { ...meta, parallel }, { parallel, exclusive: !parallel });
}
function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
const handlers = { initialize: () => ({ capabilities: { tools: {} }, protocolVersion: '2024-11-05', serverInfo: { name: SERVER_NAME, version: '1.0.0' } }), ping: () => ({}), 'tools/list': () => ({ tools: TOOLS }), 'tools/call': async (params) => { const result = await callTool(params?.name, params?.arguments ?? {}); return { content: [{ type: 'text', text: result.text }], isError: result.isError }; } };
async function handleMessage(message) {
  const { id, method, params } = message ?? {}; const notification = id === undefined || id === null;
  if (notification || typeof method !== 'string' || method.startsWith('notifications/') || method === 'initialized') return;
  const handler = handlers[method]; if (!handler) return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${method}` } });
  try { send({ jsonrpc: '2.0', id, result: await handler(params) }); } catch (error) { const text = error instanceof Error ? error.message : String(error); if (method === 'tools/call') send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } }); else send({ jsonrpc: '2.0', id, error: { code: -32603, message: text } }); }
}
log(`ready: cli=${CLI_PATH} root=${WORKSPACE_ROOT} subagent=${SUBAGENT_NAME} role=${SUBAGENT_ROLE.role} model=${MODEL_REF} source=${MODEL_REF_SOURCE}`);
const reader = createInterface({ input: process.stdin, terminal: false }); const pendingMessages = new Set();
reader.on('line', (line) => { if (!line.trim()) return; let message; try { message = JSON.parse(line); } catch { log(`ignored invalid JSON input: ${line.slice(0, 200)}`); return; } const task = handleMessage(message).catch((error) => log(`message failed: ${error?.message ?? error}`)); pendingMessages.add(task); void task.finally(() => pendingMessages.delete(task)); });
reader.on('close', () => { void Promise.allSettled([...pendingMessages]).then(async () => { await ACP_TRANSPORT.close(); process.exit(0); }); });
