/**
 * Shared configuration resolution for the Reasonix ↔ Codex bridge.
 *
 * Zero runtime dependencies.  The model reference is never hard-coded:
 *   REASONIX_MODEL_REF (env) → bridge.config.json → `reasonix doctor --json`
 *   reported default_model → refuse to start.
 * The CLI path is probed (see README) and can be pinned with REASONIX_EXE.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_NAME = 'reasonix-local-bridge';
export const DEFAULT_SUBAGENT = 'deepseek-worker';
export const DEFAULT_MIN_REASONIX_VERSION = '1.38.6';
// Keep this list aligned with Reasonix's actual tool identities. Git history/diff
// inspection belongs to the host's MCP/exec surface until the CLI exposes names
// that it recognizes in subagent profiles. web_fetch remains Reasonix-owned; the
// bridge does not expose a URL/network tool or implement a second network stack.
export const READ_ONLY_PROFILE_TOOLS = Object.freeze(['read_file', 'grep', 'glob', 'ls', 'code_index', 'web_fetch']);
export const WRITE_PROFILE_TOOLS = Object.freeze([...READ_ONLY_PROFILE_TOOLS, 'edit_file', 'write_file']);
export const DEFAULT_WRITE_SUBAGENT_SUFFIX = '-write';
export const EXEC_HARD_TIMEOUT_SECONDS_CAP = 1800;
export const EXEC_HARD_OUTPUT_CHAR_CAP = 24000;
export const BRIDGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SERVER_PATH = path.join(BRIDGE_ROOT, 'src', 'server.mjs');

function envPath(name, fallback) {
  const value = (process.env[name] ?? '').trim();
  return value ? path.resolve(value) : fallback;
}

export const BRIDGE_CONFIG_PATH = envPath('BRIDGE_CONFIG', path.join(BRIDGE_ROOT, 'bridge.config.json'));
export const DOCTOR_CACHE_PATH = `${BRIDGE_CONFIG_PATH}.doctor-cache.json`;
export const DEFAULT_DOCTOR_CACHE_TTL_MS = 10 * 60 * 1000;
export const PRESETS_PATH = envPath('BRIDGE_PRESETS', path.join(BRIDGE_ROOT, 'presets.json'));
export const PRESETS_EXAMPLE_PATH = path.join(BRIDGE_ROOT, 'presets.example.json');
export const CODEX_HOME = envPath('CODEX_HOME', path.join(os.homedir(), '.codex'));
export const CODEX_CONFIG_PATH = envPath('CODEX_CONFIG', path.join(CODEX_HOME, 'config.toml'));
const REASONIX_HOME = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'reasonix')
  : path.join(os.homedir(), '.config', 'reasonix');
export const REASONIX_SKILLS_PATH = envPath('REASONIX_SKILLS_DIR', path.join(REASONIX_HOME, 'skills'));

export class ConfigError extends Error {}

/** Parse the numeric portion of a Reasonix/semver-like version string. */
export function parseVersion(value) {
  const match = String(value ?? '').match(/\bv?(\d+)\.(\d+)(?:\.(\d+))?(?:[-+][0-9A-Za-z.-]+)?\b/i);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
    normalized: `${Number(match[1])}.${Number(match[2])}.${Number(match[3] ?? 0)}`,
  };
}

export function compareVersions(left, right) {
  const a = typeof left === 'string' ? parseVersion(left) : left;
  const b = typeof right === 'string' ? parseVersion(right) : right;
  if (!a || !b) return null;
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  return 0;
}

export function resolveMinReasonixVersion() {
  const configured = (process.env.REASONIX_MIN_VERSION ?? '').trim();
  if (!configured) return { version: DEFAULT_MIN_REASONIX_VERSION, source: 'bridge default', warning: '' };
  const parsed = parseVersion(configured);
  if (!parsed) {
    return {
      version: DEFAULT_MIN_REASONIX_VERSION,
      source: 'bridge default',
      warning: `REASONIX_MIN_VERSION is invalid (${configured}); using ${DEFAULT_MIN_REASONIX_VERSION}`,
    };
  }
  const version = parsed.normalized;
  return {
    version,
    source: 'REASONIX_MIN_VERSION',
    warning: compareVersions(version, DEFAULT_MIN_REASONIX_VERSION) < 0
      ? `REASONIX_MIN_VERSION=${version} relaxes the documented minimum ${DEFAULT_MIN_REASONIX_VERSION}`
      : '',
  };
}

const WINDOWS_CMD_SHIM = /\.(?:cmd|bat)$/i;
const WINDOWS_CMD_META = /["&|<>^()%!\r\n]/u;

/** Spawn options shared by doctor/version/worker calls; shell execution is never implicit. */
export function cliSpawnOptions(_cliPath, options = {}) {
  return { ...options, shell: false };
}

function quoteWindowsCmdArg(value) {
  const text = String(value);
  return text === '' || /\s/u.test(text) ? `"${text}"` : text;
}

/** Resolve a CLI invocation without passing user-controlled arguments through a shell. */
export function cliSpawnCommand(cliPath, args = [], options = {}) {
  const safeOptions = cliSpawnOptions(cliPath, options);
  if (process.platform !== 'win32' || !WINDOWS_CMD_SHIM.test(String(cliPath))) {
    return { file: cliPath, args, options: safeOptions, error: '' };
  }
  const unsafeIndex = args.findIndex((value) => WINDOWS_CMD_META.test(String(value)));
  if (unsafeIndex >= 0 || WINDOWS_CMD_META.test(String(cliPath))) {
    return {
      file: '',
      args: [],
      options: safeOptions,
      error: `Windows command shim arguments cannot contain cmd metacharacters (argument ${unsafeIndex >= 0 ? unsafeIndex : 'path'})`,
    };
  }
  const commandBody = [cliPath, ...args].map(quoteWindowsCmdArg).join(' ');
  const command = /\s/u.test(String(cliPath)) ? `"${commandBody}"` : commandBody;
  return {
    file: process.env.ComSpec || process.env.COMSPEC || 'cmd.exe',
    args: ['/d', '/s', '/c', command],
    options: { ...safeOptions, shell: false },
    error: '',
  };
}

export function readCliVersion(cliPath, timeoutMs = 30_000) {
  if (!cliPath) return { status: 'unknown', version: null, raw: '', error: 'reasonix CLI is not available' };
  const invocation = cliSpawnCommand(cliPath, ['--version'], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (invocation.error) return { status: 'unknown', version: null, raw: '', error: invocation.error };
  const result = spawnSync(invocation.file, invocation.args, invocation.options);
  const raw = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  if (result.error) return { status: 'unknown', version: null, raw, error: `cannot run reasonix --version: ${result.error.message}` };
  if (result.status !== 0) return { status: 'unknown', version: null, raw, error: `reasonix --version exited with code ${result.status}` };
  const parsed = parseVersion(raw);
  if (!parsed) return { status: 'unknown', version: null, raw, error: 'reasonix --version output has no parseable semver' };
  return { status: 'ok', version: parsed.normalized, raw, error: '' };
}

export function checkCliVersion(cliPath, { minimum } = {}) {
  const configured = minimum ? { version: String(minimum), source: 'argument', warning: '' } : resolveMinReasonixVersion();
  const minimumParsed = parseVersion(configured.version) ?? parseVersion(DEFAULT_MIN_REASONIX_VERSION);
  const observed = readCliVersion(cliPath);
  const base = {
    ...observed,
    minimum: minimumParsed.normalized,
    minimumSource: configured.source,
    warning: configured.warning,
  };
  if (observed.status !== 'ok') return base;
  if (compareVersions(observed.version, minimumParsed) < 0) {
    return { ...base, status: 'fail', error: `Reasonix ${observed.version} is below minimum ${minimumParsed.normalized}` };
  }
  return base;
}

export function isFile(candidate) {
  try { return statSync(candidate).isFile(); } catch { return false; }
}

/** Explicit REASONIX_EXE wins; otherwise probe standard install locations and PATH. */
export function resolveCliPath() {
  const configured = (process.env.REASONIX_EXE ?? '').trim();
  if (configured) {
    const explicit = path.resolve(configured);
    if (isFile(explicit)) return explicit;
    throw new ConfigError(`REASONIX_EXE is set but is not a readable file: ${explicit}`);
  }
  const candidates = cliCandidates();
  for (const candidate of candidates) if (isFile(candidate)) return candidate;
  throw new ConfigError(`reasonix CLI not found and REASONIX_EXE is unset (probed ${candidates.length} standard location(s))`);
}

function cliCandidates() {
  if (process.platform !== 'win32') {
    return ['/usr/local/bin/reasonix-cli', '/usr/bin/reasonix-cli', '/opt/reasonix/reasonix-cli', ...pathCandidates(['reasonix-cli'])];
  }
  const programs = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Reasonix') : '';
  const candidates = [];
  if (programs) {
    candidates.push(path.join(programs, 'reasonix-cli.exe'));
    const versionsRoot = path.join(programs, 'versions');
    let entries = [];
    try { entries = readdirSync(versionsRoot, { withFileTypes: true }); } catch { entries = []; }
    const versions = entries
      .filter((entry) => entry.isDirectory() && /^v?\d+(?:\.\d+)*$/.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareVersions)
      .reverse();
    for (const version of versions) candidates.push(path.join(versionsRoot, version, 'reasonix-cli.exe'));
  }
  return [...candidates, ...pathCandidates(['reasonix-cli.exe'])];
}

function pathCandidates(names) {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return dirs.flatMap((dir) => names.map((name) => path.join(dir, name)));
}

export function doctorCachePath(configPath = BRIDGE_CONFIG_PATH) {
  return `${path.resolve(configPath)}.doctor-cache.json`;
}

function cliMtimeMs(cliPath) {
  try {
    const stats = statSync(cliPath);
    return stats.isFile() ? stats.mtimeMs : null;
  } catch {
    return null;
  }
}

function cacheableDoctorData(data) {
  const providers = Array.isArray(data?.providers) ? data.providers.flatMap((provider) => {
    if (!provider || typeof provider.name !== 'string' || !provider.name.trim()) return [];
    const safe = { name: provider.name.trim() };
    if (Array.isArray(provider.models)) safe.models = provider.models.filter((model) => typeof model === 'string' && model.trim()).map((model) => model.trim());
    else if (typeof provider.model === 'string' && provider.model.trim()) safe.model = provider.model.trim();
    if (typeof provider.key_present === 'boolean') safe.key_present = provider.key_present;
    if (typeof provider.base_url_host === 'string') safe.base_url_host = provider.base_url_host;
    if (typeof provider.context_window === 'number' && Number.isFinite(provider.context_window)) safe.context_window = provider.context_window;
    if (typeof provider.vision === 'boolean') safe.vision = provider.vision;
    return [safe];
  }) : [];
  return {
    version: typeof data?.version === 'string' ? data.version : null,
    config: { default_model: typeof data?.config?.default_model === 'string' ? data.config.default_model.trim() : '' },
    providers,
    warnings: Array.isArray(data?.warnings)
      ? data.warnings.filter((warning) => typeof warning === 'string' && warning.trim()).map((warning) => warning.trim()).slice(0, 128)
      : [],
  };
}

function isCacheableDoctorData(data) {
  if (!data || typeof data !== 'object' || (data.version !== null && typeof data.version !== 'string')
    || !data.config || typeof data.config !== 'object' || typeof data.config.default_model !== 'string'
    || !Array.isArray(data.providers) || !Array.isArray(data.warnings)) return false;
  return data.providers.every((provider) => {
    if (!provider || typeof provider !== 'object' || typeof provider.name !== 'string') return false;
    if (provider.models !== undefined && (!Array.isArray(provider.models) || provider.models.some((model) => typeof model !== 'string'))) return false;
    if (provider.model !== undefined && typeof provider.model !== 'string') return false;
    if (provider.key_present !== undefined && typeof provider.key_present !== 'boolean') return false;
    if (provider.base_url_host !== undefined && typeof provider.base_url_host !== 'string') return false;
    if (provider.context_window !== undefined && (typeof provider.context_window !== 'number' || !Number.isFinite(provider.context_window))) return false;
    return provider.vision === undefined || typeof provider.vision === 'boolean';
  });
}

function readDoctorCache(cliPath, cachePath, ttlMs) {
  const currentMtimeMs = cliMtimeMs(cliPath);
  if (currentMtimeMs === null || !isFile(cachePath)) return null;
  try {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    const fetchedAt = Number(cached?.fetchedAt);
    const age = Date.now() - fetchedAt;
    if (cached?.schema !== 1 || path.resolve(String(cached.cliPath ?? '')) !== path.resolve(cliPath)
      || cached.cliMtimeMs !== currentMtimeMs || !Number.isFinite(fetchedAt) || age < 0 || age >= ttlMs
      || !isCacheableDoctorData(cached.data)) return null;
    return { ok: true, error: '', data: cached.data, cache: 'hit', cachePath, fetchedAt };
  } catch {
    return null;
  }
}

function writeDoctorCache(cliPath, cachePath, data) {
  const currentMtimeMs = cliMtimeMs(cliPath);
  if (currentMtimeMs === null) return;
  const payload = {
    schema: 1,
    cliPath: path.resolve(cliPath),
    cliMtimeMs: currentMtimeMs,
    fetchedAt: Date.now(),
    data: cacheableDoctorData(data),
  };
  try { atomicWriteFile(cachePath, `${JSON.stringify(payload, null, 2)}\n`); } catch { /* cache is an optimization; live doctor already succeeded */ }
}

/** Redacted machine inventory straight from the CLI: providers, models, default_model. */
export function readDoctor(cliPath, timeoutMs = 30_000, options = {}) {
  if (typeof timeoutMs === 'object') {
    options = timeoutMs;
    timeoutMs = 30_000;
  }
  if (!options || typeof options !== 'object') options = {};
  if (!cliPath) return { ok: false, error: 'reasonix CLI is not available', data: null };
  const cachePath = path.resolve(options.cachePath ?? DOCTOR_CACHE_PATH);
  const ttlMs = Number.isFinite(options.ttlMs) ? Math.max(0, Number(options.ttlMs)) : DEFAULT_DOCTOR_CACHE_TTL_MS;
  if (!options.refresh) {
    const cached = readDoctorCache(cliPath, cachePath, ttlMs);
    if (cached) return cached;
  }
  const invocation = cliSpawnCommand(cliPath, ['doctor', '--json'], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (invocation.error) return { ok: false, error: invocation.error, data: null, cache: 'live' };
  const result = spawnSync(invocation.file, invocation.args, invocation.options);
  if (result.error) return { ok: false, error: `cannot run reasonix doctor: ${result.error.message}`, data: null, cache: 'live' };
  if (result.status !== 0) return { ok: false, error: `reasonix doctor exited with code ${result.status}`, data: null, cache: 'live' };
  try {
    const data = JSON.parse(result.stdout);
    if (options.writeCache !== false) writeDoctorCache(cliPath, cachePath, data);
    return { ok: true, error: '', data, cache: options.refresh ? 'refreshed' : 'miss', cachePath, fetchedAt: Date.now() };
  } catch (error) {
    return { ok: false, error: `cannot parse reasonix doctor output: ${error.message}`, data: null, cache: 'live' };
  }
}

/** Flatten doctor output into selectable `<provider>/<model>` refs. */
export function doctorRefs(doctor) {
  const defaultRef = typeof doctor?.config?.default_model === 'string' ? doctor.config.default_model.trim() : '';
  const refs = [];
  for (const provider of Array.isArray(doctor?.providers) ? doctor.providers : []) {
    if (!provider || typeof provider.name !== 'string' || !provider.name.trim()) continue;
    const models = Array.isArray(provider.models) && provider.models.length
      ? provider.models
      : (typeof provider.model === 'string' ? [provider.model] : []);
    for (const model of models) {
      if (typeof model !== 'string' || !model.trim()) continue;
      const ref = `${provider.name.trim()}/${model.trim()}`;
      refs.push({
        ref,
        provider: provider.name.trim(),
        model: model.trim(),
        keyPresent: provider.key_present === true,
        baseHost: typeof provider.base_url_host === 'string' ? provider.base_url_host : '',
        contextWindow: typeof provider.context_window === 'number' ? provider.context_window : null,
        vision: typeof provider.vision === 'boolean' ? provider.vision : null,
        isReasonixDefault: ref === defaultRef,
      });
    }
  }
  return { refs, defaultRef };
}

/**
 * Detect only an explicit provider-native web_search declaration. An absent
 * declaration is deliberately unavailable: the bridge must not infer search
 * support from a model name or fabricate a backend.
 */
export function resolveProviderSearchCapability(doctor, modelRef = '') {
  const selectedProvider = typeof modelRef === 'string' && modelRef.includes('/') ? modelRef.slice(0, modelRef.indexOf('/')).trim() : '';
  const providers = Array.isArray(doctor?.providers) ? doctor.providers : [];
  for (const provider of providers) {
    if (!provider || typeof provider !== 'object') continue;
    if (selectedProvider && provider.name !== selectedProvider) continue;
    const declarations = [
      provider.web_search,
      provider.webSearch,
      provider.capabilities?.web_search,
      provider.capabilities?.webSearch,
      provider.tools?.web_search,
      provider.tools?.webSearch,
    ];
    const explicit = declarations.find((value) => typeof value === 'boolean');
    if (explicit === true) return { owner: 'provider', tool: 'web_search', available: true, status: 'available', reason: null };
    if (explicit === false) return { owner: 'provider', tool: 'web_search', available: false, status: 'unavailable', reason: 'provider_reported_unavailable' };
  }
  return { owner: 'provider', tool: 'web_search', available: false, status: 'unavailable', reason: 'provider_capability_not_advertised' };
}

export function readBridgeConfig(configPath = BRIDGE_CONFIG_PATH) {
  if (!isFile(configPath)) return { path: configPath, exists: false, data: {} };
  let text;
  try { text = readFileSync(configPath, 'utf8'); } catch (error) { throw new ConfigError(`cannot read ${configPath}: ${error.message}`); }
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('expected a JSON object');
    return { path: configPath, exists: true, data };
  } catch (error) {
    throw new ConfigError(`invalid bridge config ${configPath}: ${error.message}`);
  }
}

export function doctorWarnings(doctor) {
  return Array.isArray(doctor?.warnings)
    ? doctor.warnings.filter((warning) => typeof warning === 'string' && warning.trim()).map((warning) => warning.trim())
    : [];
}

/** Return only profile tool identity warnings for the selected profile. */
export function doctorUnknownToolReferences(doctor, profileName = '') {
  const name = typeof profileName === 'string' ? profileName.trim() : '';
  return doctorWarnings(doctor).filter((warning) => {
    if (!/allowed-tools reference .* is not a known tool identity/u.test(warning)) return false;
    return !name || new RegExp(`^skill "${name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}" `, 'u').test(warning);
  });
}

/** Resolve the explicit transport switch; invalid values fail closed to per-call. */
export function resolveTransport(bridgeConfig) {
  const raw = bridgeConfig?.data?.transport;
  if (raw === undefined || raw === null || String(raw).trim() === '') return { mode: 'per-call', source: 'bridge default', error: '' };
  const mode = String(raw).trim().toLowerCase();
  if (mode === 'per-call' || mode === 'acp') return { mode, source: bridgeConfig.path || 'bridge.config.json', error: '' };
  return { mode: 'per-call', source: 'bridge default', error: `transport must be "per-call" or "acp" (received ${String(raw)})` };
}

/** Resolves the subagent model ref, recording where it came from. */
export function resolveModelRef({ cliPath, bridgeConfig, doctorOptions } = {}) {
  const fromEnv = (process.env.REASONIX_MODEL_REF ?? '').trim();
  if (fromEnv) return { ref: fromEnv, source: 'REASONIX_MODEL_REF environment variable', doctor: null };
  const fromFile = typeof bridgeConfig?.data?.modelRef === 'string' ? bridgeConfig.data.modelRef.trim() : '';
  if (fromFile) return { ref: fromFile, source: bridgeConfig.path, doctor: null };
  const resolvedDoctorOptions = doctorOptions?.cachePath
    ? doctorOptions
    : { ...(doctorOptions ?? {}), cachePath: doctorCachePath(bridgeConfig?.path ?? BRIDGE_CONFIG_PATH) };
  const doctor = readDoctor(cliPath, 30_000, resolvedDoctorOptions);
  if (doctor.ok) {
    const ref = typeof doctor.data?.config?.default_model === 'string' ? doctor.data.config.default_model.trim() : '';
    if (ref) return { ref, source: 'reasonix default_model (auto fallback)', doctor };
  }
  return { ref: '', source: '', doctor, error: doctor.error || 'reasonix reported no default_model' };
}

export function validateModelRef(ref) {
  const value = (ref ?? '').trim();
  if (!value) return 'model reference is empty';
  if (/\s/.test(value)) return 'model reference must not contain whitespace';
  if (!value.includes('/')) return 'model reference must look like <provider>/<model>';
  return '';
}

export function resolveSubagent(bridgeConfig) {
  const fromEnv = (process.env.REASONIX_SUBAGENT ?? '').trim();
  if (fromEnv) return { name: fromEnv, source: 'REASONIX_SUBAGENT environment variable' };
  const fromFile = typeof bridgeConfig?.data?.subagent === 'string' ? bridgeConfig.data.subagent.trim() : '';
  if (fromFile) return { name: fromFile, source: bridgeConfig.path };
  return { name: DEFAULT_SUBAGENT, source: 'bridge default' };
}

export function resolveRoleSubagent(bridgeConfig, role = 'read') {
  const base = resolveSubagent(bridgeConfig);
  if (role === 'read') return { ...base, role };
  if (role !== 'write') throw new ConfigError(`invalid profile role: ${role}`);
  if (base.name.endsWith(DEFAULT_WRITE_SUBAGENT_SUFFIX)) return { ...base, role };
  const fromEnv = (process.env.REASONIX_WRITE_SUBAGENT ?? '').trim();
  if (fromEnv) return { name: fromEnv, source: 'REASONIX_WRITE_SUBAGENT environment variable', role };
  const fromFile = typeof bridgeConfig?.data?.writeSubagent === 'string' ? bridgeConfig.data.writeSubagent.trim() : '';
  if (fromFile) return { name: fromFile, source: bridgeConfig.path, role };
  return { name: `${base.name}${DEFAULT_WRITE_SUBAGENT_SUFFIX}`, source: 'derived from read profile', role };
}

export function resolveSubagentRole(bridgeConfig, subagent = resolveSubagent(bridgeConfig)) {
  const configured = (process.env.REASONIX_SUBAGENT_ROLE ?? '').trim().toLowerCase()
    || (typeof bridgeConfig?.data?.subagentRole === 'string' ? bridgeConfig.data.subagentRole.trim().toLowerCase() : '');
  if (configured && !['read', 'write'].includes(configured)) throw new ConfigError(`invalid subagent role: ${configured}`);
  const writeName = resolveRoleSubagent(bridgeConfig, 'write').name;
  if (configured) {
    if (configured === 'read' && subagent.name === writeName) {
      throw new ConfigError(`subagent role read conflicts with selected write profile: ${subagent.name}`);
    }
    return {
      role: configured,
      name: resolveRoleSubagent(bridgeConfig, configured).name,
      source: configured === (process.env.REASONIX_SUBAGENT_ROLE ?? '').trim().toLowerCase() ? 'REASONIX_SUBAGENT_ROLE environment variable' : bridgeConfig.path,
    };
  }
  return {
    role: subagent.name === writeName ? 'write' : 'read',
    name: subagent.name,
    source: subagent.name === writeName ? 'write profile name' : 'default read role',
  };
}

export function resolveWorkspaceRoot(bridgeConfig) {
  const fromEnv = (process.env.REASONIX_ROOT ?? '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  const fromFile = typeof bridgeConfig?.data?.root === 'string' ? bridgeConfig.data.root.trim() : '';
  if (fromFile) return path.resolve(fromFile);
  return process.cwd();
}

function normalizeAllowedPath(value) {
  if (typeof value !== 'string' || !value.trim()) return { path: '', error: 'allowedPaths entries must be non-empty strings' };
  const original = value.trim().replaceAll('\\', '/');
  if (original.startsWith('/') || /^[A-Za-z]:\//.test(original)) return { path: '', error: `allowed path must be relative: ${value}` };
  const normalized = path.posix.normalize(original);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    return { path: '', error: `allowed path escapes the workspace: ${value}` };
  }
  return { path: normalized.replace(/\/$/, ''), error: '' };
}

/** Resolve the opt-in write policy. Every write setting is fail-closed by default. */
export function resolveWritePolicy(bridgeConfig) {
  const data = bridgeConfig?.data && typeof bridgeConfig.data === 'object' ? bridgeConfig.data : {};
  const allowWrite = data.allowWrite === true;
  const allowWriteTypeError = Object.hasOwn(data, 'allowWrite') && typeof data.allowWrite !== 'boolean';
  const rawPaths = data.allowedPaths;
  const allowedPaths = [];
  const errors = [];
  // cleanTreePolicy controls the pre-write tree gate:
  //   'snapshot' (default, dev-friendly): dirty trees are accepted; the pre-existing
  //     dirty state of allowed paths is snapshotted so rollback restores it verbatim
  //     instead of HEAD.
  //   'strict' (production): the historical gate — the whole tree must be clean.
  // requireCleanTree stays as a compatibility alias: true -> strict, false -> snapshot.
  let cleanTreePolicy = 'snapshot';
  let cleanTreePolicySource = 'default';
  if (Object.hasOwn(data, 'cleanTreePolicy')) {
    if (data.cleanTreePolicy === 'snapshot' || data.cleanTreePolicy === 'strict') {
      cleanTreePolicy = data.cleanTreePolicy;
      cleanTreePolicySource = 'config';
    } else {
      errors.push('cleanTreePolicy must be "snapshot" or "strict"');
    }
  }
  if (Object.hasOwn(data, 'requireCleanTree')) {
    if (typeof data.requireCleanTree !== 'boolean') {
      errors.push('requireCleanTree must be boolean true or false');
    } else {
      const mapped = data.requireCleanTree ? 'strict' : 'snapshot';
      if (cleanTreePolicySource === 'config') {
        if (mapped !== cleanTreePolicy) errors.push('requireCleanTree conflicts with cleanTreePolicy');
      } else {
        cleanTreePolicy = mapped;
        cleanTreePolicySource = 'requireCleanTree';
      }
    }
  }
  if (rawPaths !== undefined && !Array.isArray(rawPaths)) errors.push('allowedPaths must be an array');
  if (Array.isArray(rawPaths)) {
    for (const value of rawPaths) {
      const normalized = normalizeAllowedPath(value);
      if (normalized.error) errors.push(normalized.error);
      else if (!allowedPaths.includes(normalized.path)) allowedPaths.push(normalized.path);
    }
  }
  if (allowWriteTypeError) errors.push('allowWrite must be boolean true or false');
  return Object.freeze({
    allowWrite,
    allowedPaths: Object.freeze(allowedPaths),
    cleanTreePolicy,
    cleanTreePolicySource,
    requireCleanTree: cleanTreePolicy === 'strict',
    errors: Object.freeze(errors),
    enabled: allowWrite && errors.length === 0 && allowedPaths.length > 0,
  });
}

const EXEC_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const EXEC_META = /[\0\r\n]/u;

function resolveExecInteger(raw, fallback, cap, label, errors) {
  if (raw === undefined) return fallback;
  const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(parsed) || parsed < 1) {
    errors.push(`${label} must be a positive integer`);
    return fallback;
  }
  if (parsed > cap) return cap;
  return parsed;
}

function normalizeExecAllowedPath(value) {
  if (typeof value !== 'string' || !value.trim()) return { path: '', error: 'execPolicy.allowedPaths entries must be non-empty strings' };
  const original = value.trim().replaceAll('\\', '/');
  if (original.startsWith('/') || /^[A-Za-z]:\//u.test(original)) return { path: '', error: `exec allowed path must be relative: ${value}` };
  const normalized = path.posix.normalize(original);
  if (normalized === '..' || normalized.startsWith('../')) return { path: '', error: `exec allowed path escapes the workspace: ${value}` };
  return { path: normalized === '.' ? '' : normalized.replace(/\/$/u, ''), error: '' };
}

/** Resolve the opt-in command runner policy. Commands are named profiles, never caller-provided executables. */
export function resolveExecPolicy(bridgeConfig) {
  const raw = bridgeConfig?.data?.execPolicy;
  const defaults = {
    configured: raw !== undefined,
    enabled: false,
    allowedPaths: Object.freeze([]),
    commands: Object.freeze([]),
    requireCleanTree: true,
    timeoutSeconds: 300,
    outputCharCap: EXEC_HARD_OUTPUT_CHAR_CAP,
    errors: Object.freeze([]),
  };
  if (raw === undefined) return Object.freeze(defaults);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return Object.freeze({ ...defaults, errors: Object.freeze(['execPolicy must be an object']) });
  }
  const errors = [];
  const enabled = raw.enabled === true;
  if (Object.hasOwn(raw, 'enabled') && typeof raw.enabled !== 'boolean') errors.push('execPolicy.enabled must be boolean');
  const requireCleanTree = Object.hasOwn(raw, 'requireCleanTree') ? raw.requireCleanTree === true : true;
  if (Object.hasOwn(raw, 'requireCleanTree') && typeof raw.requireCleanTree !== 'boolean') errors.push('execPolicy.requireCleanTree must be boolean');
  if (raw.requireCleanTree === false) errors.push('execPolicy.requireCleanTree=false is unsupported; use an isolated clean worktree');

  const allowedPaths = [];
  if (!Array.isArray(raw.allowedPaths)) errors.push('execPolicy.allowedPaths must be an array');
  else {
    for (const value of raw.allowedPaths) {
      const normalized = normalizeExecAllowedPath(value);
      if (normalized.error) errors.push(normalized.error);
      else if (!allowedPaths.includes(normalized.path)) allowedPaths.push(normalized.path);
    }
  }
  if (!allowedPaths.length) errors.push('execPolicy.allowedPaths must contain at least one repository-relative path');

  const commands = [];
  if (!Array.isArray(raw.commands)) errors.push('execPolicy.commands must be an array');
  else {
    for (const item of raw.commands) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        errors.push('execPolicy.commands entries must be objects');
        continue;
      }
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      const executable = typeof item.executable === 'string' ? item.executable.trim() : '';
      if (!EXEC_NAME.test(name)) errors.push(`exec command name is invalid: ${name || '(empty)'}`);
      if (!executable || executable.length > 512 || EXEC_META.test(executable)) errors.push(`exec command executable is invalid: ${name || '(unnamed)'}`);
      if (commands.some((entry) => entry.name === name)) errors.push(`exec command name is duplicated: ${name}`);
      const argsPrefix = item.argsPrefix === undefined ? [] : item.argsPrefix;
      if (!Array.isArray(argsPrefix) || argsPrefix.some((arg) => typeof arg !== 'string' || arg.length > 4096 || EXEC_META.test(arg))) {
        errors.push(`exec command argsPrefix is invalid: ${name || '(unnamed)'}`);
      }
      const maxArgs = resolveExecInteger(item.maxArgs, 32, 128, `exec command ${name || '(unnamed)'}.maxArgs`, errors);
      if (EXEC_NAME.test(name) && executable && executable.length <= 512 && !EXEC_META.test(executable)
        && Array.isArray(argsPrefix) && argsPrefix.every((arg) => typeof arg === 'string' && arg.length <= 4096 && !EXEC_META.test(arg))) {
        commands.push(Object.freeze({ name, executable, argsPrefix: Object.freeze([...argsPrefix]), maxArgs }));
      }
    }
  }
  const timeoutSeconds = resolveExecInteger(raw.timeoutSeconds, 300, EXEC_HARD_TIMEOUT_SECONDS_CAP, 'execPolicy.timeoutSeconds', errors);
  const outputCharCap = resolveExecInteger(raw.outputCharCap, EXEC_HARD_OUTPUT_CHAR_CAP, EXEC_HARD_OUTPUT_CHAR_CAP, 'execPolicy.outputCharCap', errors);
  return Object.freeze({
    configured: true,
    enabled,
    allowedPaths: Object.freeze(allowedPaths),
    commands: Object.freeze(commands),
    requireCleanTree,
    timeoutSeconds,
    outputCharCap,
    errors: Object.freeze(errors),
  });
}

export function readPresets(presetsPath = PRESETS_PATH) {
  if (!isFile(presetsPath)) return { path: presetsPath, exists: false, presets: [] };
  let data;
  try { data = JSON.parse(readFileSync(presetsPath, 'utf8')); } catch (error) { throw new ConfigError(`invalid presets file ${presetsPath}: ${error.message}`); }
  const presets = Array.isArray(data?.presets) ? data.presets : [];
  return {
    path: presetsPath,
    exists: true,
    presets: presets.filter((item) => item && typeof item.name === 'string' && typeof item.modelRef === 'string' && item.modelRef.includes('/')),
  };
}

function validProfileName(name) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(name ?? '').trim());
}

export function profilePath(name, skillsPath = REASONIX_SKILLS_PATH) {
  const value = String(name ?? '').trim();
  if (!validProfileName(value)) throw new ConfigError(`invalid subagent profile name: ${value || '(empty)'}`);
  return path.join(path.resolve(skillsPath), value, 'SKILL.md');
}

function scalarValue(value) {
  const trimmed = String(value ?? '').trim();
  if (trimmed.startsWith('"')) {
    const end = trimmed.lastIndexOf('"');
    if (end > 0) return trimmed.slice(1, end);
  }
  if (trimmed.startsWith("'")) {
    const end = trimmed.lastIndexOf("'");
    if (end > 0) return trimmed.slice(1, end);
  }
  return trimmed.replace(/\s+#.*$/, '');
}

/** Parse the small YAML frontmatter contract used by Reasonix profiles. */
export function parseProfileFrontmatter(text) {
  const lines = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { exists: false, fields: {}, error: 'profile has no YAML frontmatter' };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end === -1) return { exists: false, fields: {}, error: 'profile frontmatter is not closed' };
  const fields = {};
  let blockListKey = '';
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (match) {
      const [, key, raw] = match;
      const trimmedRaw = raw.trim();
      if ((key === 'allowed-tools' || key === 'allowed_tools') && trimmedRaw === '') {
        fields[key] = [];
        blockListKey = key;
      } else {
        fields[key] = scalarValue(raw);
        blockListKey = '';
      }
      continue;
    }
    const item = line.match(/^\s+-\s*(.+)$/);
    if (item && blockListKey) fields[blockListKey].push(scalarValue(item[1]));
    else if (line.trim()) blockListKey = '';
  }
  const model = typeof fields.model === 'string' ? fields.model : '';
  const readOnlyRaw = fields['read-only'] ?? fields.read_only ?? fields.readOnly;
  const readOnly = typeof readOnlyRaw === 'string' ? /^(true|yes)$/i.test(readOnlyRaw) : null;
  const toolsKey = Object.prototype.hasOwnProperty.call(fields, 'allowed-tools') ? 'allowed-tools' : 'allowed_tools';
  const toolsRaw = fields[toolsKey] ?? '';
  let tools = [];
  let toolsKnown = Object.prototype.hasOwnProperty.call(fields, toolsKey);
  if (Array.isArray(toolsRaw)) {
    tools = toolsRaw;
  } else if (typeof toolsRaw === 'string' && toolsRaw.startsWith('[') && toolsRaw.endsWith(']')) {
    tools = toolsRaw.slice(1, -1).split(',').map((item) => scalarValue(item)).filter(Boolean);
  } else if (typeof toolsRaw === 'string' && toolsRaw !== '') {
    toolsKnown = false;
  }
  return { exists: true, fields, model, readOnly, tools, toolsKnown, error: '' };
}

export function readSubagentProfile(name, skillsPath = REASONIX_SKILLS_PATH) {
  let filePath;
  try {
    filePath = profilePath(name, skillsPath);
  } catch (error) {
    return { path: '', exists: false, frontmatter: null, error: error.message };
  }
  if (!isFile(filePath)) return { path: filePath, exists: false, frontmatter: null, error: 'profile file is missing' };
  try {
    const frontmatter = parseProfileFrontmatter(readFileSync(filePath, 'utf8'));
    return { path: filePath, exists: true, frontmatter, error: frontmatter.error };
  } catch (error) {
    return { path: filePath, exists: true, frontmatter: null, error: `cannot read profile: ${error.message}` };
  }
}

/** Add or normalize the read-only guard only after an explicit profile --write. */
export function ensureProfileReadOnly(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') throw new ConfigError('profile has no YAML frontmatter');
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end === -1) throw new ConfigError('profile frontmatter is not closed');
  const readOnlyIndex = lines.findIndex((line, index) => index > 0 && index < end && /^\s*(read-only|read_only|readOnly)\s*:/i.test(line));
  if (readOnlyIndex >= 0) lines[readOnlyIndex] = 'read-only: true';
  else lines.splice(end, 0, 'read-only: true');
  writeFileSync(filePath, `${lines.join('\n').replace(/\n+$/, '')}\n`, 'utf8');
}

/** Remove every read-only guard from an explicitly selected write profile. */
export function ensureProfileWritable(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') throw new ConfigError('profile has no YAML frontmatter');
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end === -1) throw new ConfigError('profile frontmatter is not closed');
  const filtered = lines.filter((line, index) => index >= end || !(index > 0 && index < end && /^\s*(read-only|read_only|readOnly)\s*:/i.test(line)));
  writeFileSync(filePath, `${filtered.join('\n').replace(/\n+$/, '')}\n`, 'utf8');
}

export function profileDrift(profile, modelRef, expectedTools = READ_ONLY_PROFILE_TOOLS, role = 'read') {
  const issues = [];
  if (!profile?.exists) return [profile?.error || 'profile file is missing'];
  if (!profile.frontmatter?.exists) return [profile.error || 'profile frontmatter is invalid'];
  if (modelRef && profile.frontmatter.model !== modelRef) issues.push(`model=${profile.frontmatter.model || '(missing)'} expected ${modelRef}`);
  if (role === 'read' && profile.frontmatter.readOnly !== true) issues.push('read-only: true is missing');
  if (role === 'write' && profile.frontmatter.readOnly !== null) issues.push('read-only must be absent for write role');
  if (!['read', 'write'].includes(role)) issues.push(`profile role is invalid: ${role}`);
  if (profile.frontmatter.toolsKnown !== true) issues.push('allowed-tools is missing or unparseable');
  else {
    const actual = [...new Set(profile.frontmatter.tools)].sort();
    const expected = [...new Set(expectedTools)].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) issues.push(`allowed-tools=${actual.join(',') || '(none)'} expected ${expected.join(',')}`);
  }
  return issues;
}

/** TOML-safe value: forward slashes avoid the `\U` escape trap on Windows paths. */
function tomlValue(value) {
  return String(value).replace(/\\/g, '/').replace(/"/g, '\\"');
}

export function buildCodexBlock({ modelRef, subagent, root, cliPath }) {
  const lines = [
    '[mcp_servers.reasonix_local]',
    'command = "node"',
    `args = ["${tomlValue(SERVER_PATH)}"]`,
    'startup_timeout_sec = 30',
    '',
    '[mcp_servers.reasonix_local.env]',
  ];
  if (cliPath) lines.push(`REASONIX_EXE = "${tomlValue(cliPath)}"`);
  lines.push(
    `REASONIX_ROOT = "${tomlValue(root)}"`,
    `REASONIX_SUBAGENT = "${tomlValue(subagent)}"`,
    `REASONIX_MODEL_REF = "${tomlValue(modelRef)}"`,
  );
  return `${lines.join('\n')}\n`;
}

export function validateCodexBlock(block) {
  const lines = String(block ?? '').split(/\r?\n/).map((line) => line.trim());
  const sections = new Map();
  let section = '';
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      section = header[1];
      if (!sections.has(section)) sections.set(section, new Set());
      continue;
    }
    const key = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (key && section) sections.get(section).add(key[1]);
  }
  if (!sections.has('mcp_servers.reasonix_local')) return 'missing [mcp_servers.reasonix_local] section';
  if (!sections.has('mcp_servers.reasonix_local.env')) return 'missing [mcp_servers.reasonix_local.env] section';
  for (const key of ['command', 'args', 'startup_timeout_sec']) {
    if (!sections.get('mcp_servers.reasonix_local').has(key)) return `missing ${key} in [mcp_servers.reasonix_local]`;
  }
  for (const key of ['REASONIX_ROOT', 'REASONIX_SUBAGENT', 'REASONIX_MODEL_REF']) {
    if (!sections.get('mcp_servers.reasonix_local.env').has(key)) return `missing ${key} in [mcp_servers.reasonix_local.env]`;
  }
  return '';
}

function isReasonixSection(line) {
  const match = String(line).trim().match(/^\[([^\]]+)\]$/);
  return match && (match[1] === 'mcp_servers.reasonix_local' || match[1].startsWith('mcp_servers.reasonix_local.'));
}

function isSectionHeader(line) {
  return /^\s*\[[^\]]+\]\s*$/.test(String(line));
}

/** Replace all existing `[mcp_servers.reasonix_local*]` sections, or append one canonical block. */
export function upsertReasonixBlock(text, block) {
  const validation = validateCodexBlock(block);
  if (validation) throw new ConfigError(`invalid Codex bridge block: ${validation}`);
  const original = String(text ?? '');
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === '[mcp_servers.reasonix_local]');
  const blockLines = block.replace(/\s*$/, '').split(/\r?\n/);
  if (start === -1) {
    const base = lines.join('\n').replace(/\s*$/, '');
    const result = base ? `${base}\n\n${blockLines.join('\n')}\n` : `${blockLines.join('\n')}\n`;
    return result.replace(/\n/g, newline);
  }
  const targetRanges = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!isReasonixSection(lines[index])) continue;
    let end = index + 1;
    while (end < lines.length && !isSectionHeader(lines[end])) end += 1;
    targetRanges.push([index, end]);
  }
  const first = targetRanges[0]?.[0] ?? start;
  const remove = new Set(targetRanges.flatMap(([from, to]) => Array.from({ length: to - from }, (_, offset) => from + offset)));
  const retained = lines.filter((_, index) => !remove.has(index));
  let insertion = 0;
  for (let index = 0; index < first; index += 1) if (!remove.has(index)) insertion += 1;
  retained.splice(insertion, 0, ...blockLines);
  const result = retained.join('\n').replace(/^\s*\n/, '').replace(/\s*$/, '');
  return `${result}\n`.replace(/\n/g, newline);
}

/** Write through a same-directory temporary and replace the destination, restoring it on failure. */
export function atomicWriteFile(filePath, content) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const displacedPath = `${filePath}.old-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, content, 'utf8');
  let displaced = false;
  try {
    if (process.platform === 'win32' && existsSync(filePath)) {
      renameSync(filePath, displacedPath);
      displaced = true;
    }
    renameSync(tempPath, filePath);
    if (displaced && existsSync(displacedPath)) unlinkSync(displacedPath);
  } catch (error) {
    if (existsSync(tempPath)) unlinkSync(tempPath);
    if (displaced && !existsSync(filePath) && existsSync(displacedPath)) renameSync(displacedPath, filePath);
    throw new ConfigError(`cannot atomically replace ${filePath}: ${error.message}`);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}
