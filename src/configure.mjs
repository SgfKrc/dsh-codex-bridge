#!/usr/bin/env node
/**
 * Configure the Reasonix ↔ Codex bridge without hand-editing JSON or TOML.
 *
 * Everything is derived from this machine (`reasonix doctor --json`) plus an
 * optional, human-editable bridge.config.json / presets.json.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  BRIDGE_CONFIG_PATH,
  BRIDGE_ROOT,
  CODEX_CONFIG_PATH,
  DOCTOR_CACHE_PATH,
  PRESETS_EXAMPLE_PATH,
  PRESETS_PATH,
  REASONIX_SKILLS_PATH,
  buildCodexBlock,
  atomicWriteFile,
  checkCliVersion,
  cliSpawnCommand,
  cliSpawnOptions,
  doctorUnknownToolReferences,
  doctorRefs,
  isFile,
  profileDrift,
  ensureProfileReadOnly,
  ensureProfileWritable,
  parseVersion,
  readSubagentProfile,
  readBridgeConfig,
  readDoctor,
  READ_ONLY_PROFILE_TOOLS,
  WRITE_PROFILE_TOOLS,
  readPresets,
  resolveCliPath,
  resolveModelRef,
  resolveSubagent,
  resolveRoleSubagent,
  resolveWorkspaceRoot,
  upsertReasonixBlock,
  validateModelRef,
  doctorCachePath,
} from './config.mjs';

const USAGE = `Usage: node src/configure.mjs <command>

  list [--refresh]     list every <provider>/<model> ref this machine reports
  show [--refresh]     print the configuration the bridge will use, and each value's source
  use <ref|preset> [--refresh]
                       write modelRef into bridge.config.json (a preset name is accepted)
  presets              list presets from presets.json (copy presets.example.json to create it)
  codex [--write] [--refresh]
                       print the Codex MCP block; --write upserts it into the Codex config (backup first)
  profile [--role read|write] [--create|--sync] [--write] [--refresh]
                       inspect a role profile or print/run a create/edit command, then verify its contract
  verify [--role read|write] [--refresh]
                       check the CLI, the selected model ref, and the requested role profile
  export [--refresh]   print a path-free, redacted environment summary as JSON
  import <file|-> [--refresh]
                       compare a summary file (or stdin) with this machine; never writes config

--refresh             bypass the doctor cache for commands that inspect the machine inventory

Environment overrides: REASONIX_EXE, REASONIX_MODEL_REF, REASONIX_SUBAGENT, REASONIX_ROOT,
REASONIX_WRITE_SUBAGENT, REASONIX_MIN_VERSION, BRIDGE_CONFIG, BRIDGE_PRESETS, CODEX_CONFIG, CODEX_HOME.`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function loadContext({ refresh = false } = {}) {
  let cliPath = '';
  let cliError = '';
  try { cliPath = resolveCliPath(); } catch (error) { cliError = error.message; }
  const bridgeConfig = readBridgeConfig();
  const resolution = resolveModelRef({ cliPath, bridgeConfig, doctorOptions: { refresh } });
  const doctor = refresh && cliPath && !resolution.doctor
    ? readDoctor(cliPath, 30_000, { refresh: true, cachePath: doctorCachePath(bridgeConfig.path) })
    : null;
  return {
    cliPath,
    cliError,
    bridgeConfig,
    resolution,
    doctor,
    subagent: resolveSubagent(bridgeConfig),
    root: resolveWorkspaceRoot(bridgeConfig),
    doctorOptions: { refresh },
  };
}

function doctorFor(context) {
  if (context.doctor) return context.doctor;
  if (context.resolution.doctor) return context.resolution.doctor;
  if (!context.cliPath) return { ok: false, error: context.cliError || 'reasonix CLI is not available', data: null };
  return readDoctor(context.cliPath, 30_000, context.doctorOptions);
}

const SAFE_PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function safeSegment(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= 200 && !/[\s\\/]/u.test(text) && !/:\/\//u.test(text) ? text : null;
}

function safeModelRef(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 400 || /[\s\\]/u.test(text) || /:\/\//u.test(text)) return null;
  const separator = text.indexOf('/');
  if (separator <= 0 || separator === text.length - 1 || text.indexOf('/', separator + 1) !== -1) return null;
  return safeSegment(text.slice(0, separator)) && safeSegment(text.slice(separator + 1)) ? text : null;
}

function safeProfileName(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return SAFE_PROFILE_NAME.test(text) ? text : null;
}

function modelSourceLabel(source, bridgeConfig) {
  if (source === 'REASONIX_MODEL_REF environment variable') return 'environment';
  if (source === 'reasonix default_model (auto fallback)') return 'reasonix default';
  if (source && bridgeConfig?.path && path.resolve(source) === path.resolve(bridgeConfig.path)) return 'bridge.config.json';
  return source ? 'configured' : null;
}

function summaryProviders(doctor) {
  if (!doctor?.ok) return [];
  const grouped = new Map();
  for (const item of doctorRefs(doctor.data).refs) {
    const provider = safeSegment(item.provider);
    const model = safeSegment(item.model);
    if (!provider || !model) continue;
    if (!grouped.has(provider)) grouped.set(provider, new Set());
    grouped.get(provider).add(model);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, models]) => ({ name, models: [...models].sort() }));
}

function summaryProfile(context) {
  const name = safeProfileName(context.subagent.name);
  if (!name) return { name: null, exists: false, status: 'invalid', model: null, readOnly: null, tools: [] };
  let profile;
  try { profile = readSubagentProfile(name); } catch { profile = { exists: false, frontmatter: null }; }
  const frontmatter = profile.frontmatter;
  return {
    name,
    exists: profile.exists === true,
    status: !profile.exists ? 'missing' : frontmatter?.exists ? 'ok' : 'invalid',
    model: safeModelRef(frontmatter?.model),
    readOnly: typeof frontmatter?.readOnly === 'boolean' ? frontmatter.readOnly : null,
    tools: frontmatter?.toolsKnown && Array.isArray(frontmatter.tools)
      ? frontmatter.tools.map(safeSegment).filter(Boolean).sort()
      : [],
  };
}

function environmentSummary(context, doctor) {
  const versionCheck = context.cliPath ? checkCliVersion(context.cliPath) : { status: 'unknown', version: null };
  const doctorVersion = parseVersion(doctor?.data?.version)?.normalized ?? null;
  const profile = summaryProfile(context);
  return {
    schema: 1,
    platform: { os: process.platform, arch: process.arch },
    nodeMajor: Number(process.versions.node.split('.')[0]),
    reasonix: { version: versionCheck.version ?? doctorVersion, versionCheck: versionCheck.status },
    providers: summaryProviders(doctor),
    current: {
      modelRef: safeModelRef(context.resolution.ref),
      modelSource: modelSourceLabel(context.resolution.source, context.bridgeConfig),
      profile: profile.name,
      profileExists: profile.exists,
      profileStatus: profile.status,
      profileModel: profile.model,
      profileReadOnly: profile.readOnly,
      profileTools: profile.tools,
    },
  };
}

function normalizeSummary(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.schema !== 1) throw new Error('schema must be 1');
  const platform = input.platform;
  if (!platform || typeof platform !== 'object' || !safeSegment(platform.os) || !safeSegment(platform.arch)) throw new Error('platform is invalid');
  if (!Number.isInteger(input.nodeMajor) || input.nodeMajor < 1) throw new Error('nodeMajor is invalid');
  const reasonix = input.reasonix;
  if (!reasonix || typeof reasonix !== 'object' || (reasonix.version !== null && typeof reasonix.version !== 'string')
    || (reasonix.version !== null && !parseVersion(reasonix.version))
    || !['ok', 'fail', 'unknown', 'unavailable'].includes(reasonix.versionCheck)) throw new Error('reasonix is invalid');
  if (!Array.isArray(input.providers)) throw new Error('providers is invalid');
  const providers = input.providers.map((provider) => {
    if (!provider || typeof provider !== 'object' || !safeSegment(provider.name) || !Array.isArray(provider.models)
      || provider.models.some((model) => !safeSegment(model))) throw new Error('providers contains invalid fields');
    return { name: provider.name.trim(), models: [...new Set(provider.models.map((model) => model.trim()))].sort() };
  }).sort((left, right) => left.name.localeCompare(right.name));
  const current = input.current;
  if (!current || typeof current !== 'object') throw new Error('current is invalid');
  if (current.modelRef !== null && !safeModelRef(current.modelRef)) throw new Error('current.modelRef is invalid');
  if (current.modelSource !== null && !safeSegment(current.modelSource)) throw new Error('current.modelSource is invalid');
  if (current.profile !== null && !safeProfileName(current.profile)) throw new Error('current.profile is invalid');
  if (typeof current.profileExists !== 'boolean' || !['ok', 'missing', 'invalid'].includes(current.profileStatus)) throw new Error('current profile status is invalid');
  if (current.profileModel !== null && !safeModelRef(current.profileModel)) throw new Error('current.profileModel is invalid');
  if (current.profileReadOnly !== null && typeof current.profileReadOnly !== 'boolean') throw new Error('current.profileReadOnly is invalid');
  if (!Array.isArray(current.profileTools) || current.profileTools.some((tool) => !safeSegment(tool))) throw new Error('current.profileTools is invalid');
  return {
    schema: 1,
    platform: { os: platform.os.trim(), arch: platform.arch.trim() },
    nodeMajor: input.nodeMajor,
    reasonix: { version: reasonix.version === null ? null : parseVersion(reasonix.version).normalized, versionCheck: reasonix.versionCheck },
    providers,
    current: {
      modelRef: current.modelRef === null ? null : current.modelRef.trim(),
      modelSource: current.modelSource === null ? null : current.modelSource.trim(),
      profile: current.profile === null ? null : current.profile.trim(),
      profileExists: current.profileExists,
      profileStatus: current.profileStatus,
      profileModel: current.profileModel === null ? null : current.profileModel.trim(),
      profileReadOnly: current.profileReadOnly,
      profileTools: [...new Set(current.profileTools.map((tool) => tool.trim()))].sort(),
    },
  };
}

function summaryDifferences(local, imported) {
  const fields = [
    ['platform', local.platform, imported.platform],
    ['nodeMajor', local.nodeMajor, imported.nodeMajor],
    ['reasonix', local.reasonix, imported.reasonix],
    ['providers', local.providers, imported.providers],
    ['current', local.current, imported.current],
  ];
  return fields.filter(([, left, right]) => JSON.stringify(left) !== JSON.stringify(right))
    .map(([field, left, right]) => ({ field, local: left, imported: right }));
}

function exportCommand(args = []) {
  const context = loadContext({ refresh: args.includes('--refresh') });
  const doctor = doctorFor(context);
  process.stdout.write(`${JSON.stringify(environmentSummary(context, doctor), null, 2)}\n`);
}

function importCommand(args = []) {
  const source = args.find((arg) => arg !== '--refresh');
  if (!source) fail('usage: node src/configure.mjs import <summary.json|-> [--refresh]');
  let text;
  try {
    text = source === '-' ? readFileSync(0, 'utf8') : readFileSync(path.resolve(source), 'utf8');
  } catch {
    fail(`cannot read environment summary: ${source === '-' ? 'stdin' : path.basename(source)}`);
  }
  let imported;
  try { imported = normalizeSummary(JSON.parse(text)); } catch (error) { fail(`invalid environment summary: ${error.message}`); }
  const context = loadContext({ refresh: args.includes('--refresh') });
  const local = normalizeSummary(environmentSummary(context, doctorFor(context)));
  const differences = summaryDifferences(local, imported);
  if (differences.length === 0) {
    process.stdout.write('no differences\n');
    return;
  }
  for (const difference of differences) process.stdout.write(`DIFF ${difference.field}: local=${JSON.stringify(difference.local)} imported=${JSON.stringify(difference.imported)}\n`);
}

function listCommand(args = []) {
  const context = loadContext({ refresh: args.includes('--refresh') });
  if (!context.cliPath) fail(`[bridge] ${context.cliError}`);
  const doctor = doctorFor(context);
  if (!doctor.ok) fail(`[bridge] ${doctor.error}`);
  const { refs, defaultRef } = doctorRefs(doctor.data);
  const current = context.resolution.ref;
  process.stdout.write(`reasonix CLI           : ${context.cliPath}\n`);
  process.stdout.write(`reasonix version       : ${doctor.data?.version ?? 'unknown'}\n`);
  process.stdout.write(`doctor inventory       : ${doctor.cache === 'hit' ? 'cache hit' : doctor.cache === 'refreshed' ? 'refreshed' : 'live'}\n`);
  process.stdout.write(`reasonix default_model : ${defaultRef || '(none reported)'}\n\n`);
  if (refs.length === 0) {
    process.stdout.write('this machine reports no providers; run `reasonix doctor` to inspect the Reasonix config\n');
    return;
  }
  for (const item of refs) {
    const marks = [
      item.ref === current ? 'current' : '',
      item.isReasonixDefault ? 'reasonix default' : '',
      item.keyPresent ? '' : 'no api key',
    ].filter(Boolean);
    const host = item.baseHost ? `  ${item.baseHost}` : '';
    process.stdout.write(`${item.ref === current ? '*' : ' '} ${item.ref}${marks.length ? `  [${marks.join(', ')}]` : ''}${host}\n`);
  }
  process.stdout.write('\nselect one with: node src/configure.mjs use <ref>\n');
}

function showCommand(args = []) {
  const context = loadContext({ refresh: args.includes('--refresh') });
  const lines = [];
  lines.push(`bridge config  : ${context.bridgeConfig.path}${context.bridgeConfig.exists ? '' : ' (not created yet)'}`);
  lines.push(`reasonix CLI   : ${context.cliPath || `UNRESOLVED - ${context.cliError}`}`);
  lines.push(`codex config   : ${CODEX_CONFIG_PATH}${isFile(CODEX_CONFIG_PATH) ? '' : ' (missing)'}`);
  lines.push(`doctor cache   : ${doctorCachePath()}${isFile(DOCTOR_CACHE_PATH) ? '' : ' (missing)'}`);
  if (args.includes('--refresh')) {
    const doctor = context.doctor ?? context.resolution.doctor;
    lines.push(`doctor inventory: ${doctor?.cache === 'refreshed' ? 'refreshed' : doctor?.cache === 'hit' ? 'cache hit' : 'live/unavailable'}`);
  }
  lines.push(`workspace root : ${context.root}`);
  lines.push(`subagent       : ${context.subagent.name}  (source: ${context.subagent.source})`);
  if (context.resolution.ref) {
    lines.push(`model ref      : ${context.resolution.ref}  (source: ${context.resolution.source})`);
  } else {
    lines.push(`model ref      : UNRESOLVED - ${context.resolution.error ?? 'no source'}`);
    lines.push('                 fix with: node src/configure.mjs use <provider>/<model>');
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function useCommand(target, args = []) {
  const wanted = (target ?? '').trim();
  if (!wanted) fail('usage: node src/configure.mjs use <provider>/<model>|<preset-name>');
  const presets = readPresets();
  const preset = presets.presets.find((item) => item.name === wanted);
  const modelRef = preset ? preset.modelRef : wanted;
  const problem = validateModelRef(modelRef);
  if (problem) fail(`invalid model reference "${modelRef}": ${problem}`);
  const config = readBridgeConfig();
  writeFileSync(BRIDGE_CONFIG_PATH, `${JSON.stringify({ ...config.data, modelRef }, null, 2)}\n`, 'utf8');
  process.stdout.write(`wrote ${BRIDGE_CONFIG_PATH}\n  modelRef = ${modelRef}${preset ? `  (preset "${preset.name}")` : ''}\n`);
  try {
    const doctor = readDoctor(resolveCliPath(), 30_000, { refresh: args.includes('--refresh') });
    if (doctor.ok) {
      const { refs } = doctorRefs(doctor.data);
      if (refs.length > 0 && !refs.some((item) => item.ref === modelRef)) {
        process.stdout.write(`warning: "${modelRef}" is not among the providers this machine reports; check with: node src/configure.mjs list\n`);
      }
    }
  } catch {
    // CLI unavailable: keep the write, the bridge reports it at startup.
  }
}

function presetsCommand() {
  const presets = readPresets();
  if (!presets.exists) {
    process.stdout.write(`no presets file at ${PRESETS_PATH}\n`);
    process.stdout.write(`copy the example to create one:\n  cp "${PRESETS_EXAMPLE_PATH}" "${PRESETS_PATH}"\n`);
    return;
  }
  if (presets.presets.length === 0) {
    process.stdout.write(`${presets.path} contains no usable preset (each needs a name and a modelRef with "/")\n`);
    return;
  }
  for (const item of presets.presets) {
    process.stdout.write(`  ${item.name.padEnd(20)} ${item.modelRef}${item.note ? `  - ${item.note}` : ''}\n`);
  }
  process.stdout.write('\napply one with: node src/configure.mjs use <name>\n');
}

function codexCommand(args) {
  const write = args.includes('--write');
  const context = loadContext({ refresh: args.includes('--refresh') });
  if (!context.resolution.ref) {
    fail(`no model ref resolved (${context.resolution.error ?? 'no source'}); run: node src/configure.mjs use <provider>/<model>`);
  }
  const block = buildCodexBlock({
    modelRef: context.resolution.ref,
    subagent: context.subagent.name,
    root: context.root,
    cliPath: context.cliPath,
  });
  if (!write) {
    process.stdout.write(`# paste into ${CODEX_CONFIG_PATH}, or re-run with --write\n${block}`);
    return;
  }
  if (isFile(CODEX_CONFIG_PATH)) {
    const backup = `${CODEX_CONFIG_PATH}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(CODEX_CONFIG_PATH, backup);
    process.stdout.write(`backup: ${backup}\n`);
  } else {
    mkdirSync(path.dirname(CODEX_CONFIG_PATH), { recursive: true });
  }
  const existing = isFile(CODEX_CONFIG_PATH) ? readFileSync(CODEX_CONFIG_PATH, 'utf8') : '';
  let updated;
  try {
    updated = upsertReasonixBlock(existing, block);
    atomicWriteFile(CODEX_CONFIG_PATH, updated);
  } catch (error) {
    fail(error.message);
  }
  process.stdout.write(`updated ${CODEX_CONFIG_PATH}\n${block}`);
}

function quoteCommandArg(value) {
  const text = String(value);
  return /[\s"']/u.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function optionValue(args, option) {
  const index = args.findIndex((arg) => arg === option || arg.startsWith(`${option}=`));
  if (index < 0) return '';
  if (args[index].startsWith(`${option}=`)) return args[index].slice(option.length + 1).trim();
  return String(args[index + 1] ?? '').trim();
}

function profileRole(args) {
  const hasRole = args.some((arg) => arg === '--role' || arg.startsWith('--role='));
  const value = hasRole ? optionValue(args, '--role') : 'read';
  if (!value) fail('profile role is required after --role; expected read or write');
  if (!['read', 'write'].includes(value)) fail(`invalid profile role: ${value}; expected read or write`);
  return value;
}

function roleProfile(context, role) {
  const resolved = resolveRoleSubagent(context.bridgeConfig, role);
  const promptName = role === 'write' ? 'deepseek-worker-write' : 'deepseek-worker';
  return {
    ...resolved,
    promptFile: path.join(BRIDGE_ROOT, 'prompts', `${promptName}-prompt.md`),
    tools: role === 'write' ? WRITE_PROFILE_TOOLS : READ_ONLY_PROFILE_TOOLS,
  };
}

function profileCommand(args) {
  const create = args.includes('--create');
  const sync = args.includes('--sync');
  const write = args.includes('--write');
  const role = profileRole(args);
  if (create && sync) fail('profile accepts only one of --create or --sync');
  if (write && !create && !sync) fail('profile --write requires --create or --sync');
  const context = loadContext({ refresh: args.includes('--refresh') });
  const target = roleProfile(context, role);
  const name = target.name;
  const profile = readSubagentProfile(name);
  if (profile.error && !profile.exists && profile.path === '') fail(profile.error);
  const modelRef = context.resolution.ref;
  if (sync && profile.frontmatter?.exists && profile.frontmatter.toolsKnown === false) {
    fail(`cannot sync profile with an unparseable allowed-tools field at ${profile.path}; repair it manually first`);
  }
  const tools = target.tools;
  const description = profile.frontmatter?.fields?.description || (role === 'write'
    ? 'Controlled implementation worker invoked by the bridge after explicit authorization.'
    : 'Read-only reconnaissance and failure analysis subagent.');
  const commandArgs = create
    ? ['subagent', 'create', name, '--description', description, '--scope', 'global', '--model', modelRef || '<provider>/<model>', '--prompt-file', target.promptFile, '--tools', tools.join(',')]
    : ['subagent', 'edit', name, '--model', modelRef || '<provider>/<model>', '--prompt-file', target.promptFile, '--tools', tools.join(',')];
  const command = `reasonix ${commandArgs.map(quoteCommandArg).join(' ')}`;
  const issues = profileDrift(profile, modelRef, tools, role);
  process.stdout.write(`profile role : ${role}\nprofile name : ${name}\nprofile path : ${profile.path}\nmodel ref    : ${modelRef || '(unresolved)'}\n`);
  if (profile.exists && profile.frontmatter?.exists) {
    process.stdout.write(`profile model: ${profile.frontmatter.model || '(missing)'}\nread-only    : ${profile.frontmatter.readOnly === true ? 'true' : profile.frontmatter.readOnly === false ? 'false' : 'missing'}\n`);
    process.stdout.write(`tools       : ${profile.frontmatter.toolsKnown ? profile.frontmatter.tools.join(',') : '(unknown)'}\n`);
  }
  if (!create && !sync) {
    process.stdout.write(`${issues.length ? `DRIFT       : ${issues.join('; ')}\n` : 'consistency  : OK\n'}`);
    if (issues.length) process.exit(1);
    return;
  }
  if (!modelRef) fail(`cannot prepare profile command: model ref unresolved (${context.resolution.error ?? 'no source'})`);
  if (!isFile(target.promptFile)) fail(`profile prompt file is missing: ${target.promptFile}`);
  if (create && profile.exists) fail(`profile already exists at ${profile.path}; use --sync or inspect it first`);
  if (sync && !profile.exists) fail(`cannot sync missing profile at ${profile.path}; use --create first`);
  process.stdout.write(`command      : ${command}\n`);
  if (!write) {
    process.stdout.write('write        : not requested (add --write to execute the CLI command)\n');
    return;
  }
  if (!context.cliPath) fail(`cannot execute profile command: ${context.cliError}`);
  const invocation = cliSpawnCommand(context.cliPath, commandArgs, {
    cwd: context.root,
    env: process.env,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (invocation.error) fail(invocation.error);
  const result = spawnSync(invocation.file, invocation.args, invocation.options);
  if (result.error) fail(`profile command failed to start: ${result.error.message}`);
  if (result.status !== 0) fail(`profile command failed with code ${result.status}\n${String(result.stderr ?? '').trim()}`);
  let updated = readSubagentProfile(name);
  if (updated.exists && ((role === 'read' && updated.frontmatter?.readOnly !== true)
    || (role === 'write' && updated.frontmatter?.readOnly !== null))) {
    try {
      if (role === 'read') ensureProfileReadOnly(updated.path);
      else ensureProfileWritable(updated.path);
      updated = readSubagentProfile(name);
    } catch (error) {
      fail(`profile command completed but role guard could not be normalized: ${error.message}`);
    }
  }
  const updatedIssues = profileDrift(updated, modelRef, tools, role);
  if (updatedIssues.length) fail(`profile command completed but consistency check failed at ${updated.path}: ${updatedIssues.join('; ')}`);
  process.stdout.write(`verified     : ${updated.path} (model and ${role === 'read' ? 'read-only' : 'write-role'} contract are consistent)\n`);
}

function verifyCommand(args = []) {
  const role = profileRole(args);
  const context = loadContext({ refresh: args.includes('--refresh') });
  const target = roleProfile(context, role);
  const results = [];
  let doctorDiagnostics = null;
  if (context.cliPath) {
    const version = checkCliVersion(context.cliPath);
    if (version.status === 'fail') {
      results.push(['fail', `reasonix CLI: ${context.cliPath} (${version.error}); upgrade Reasonix or deliberately set REASONIX_MIN_VERSION below the installed version`]);
    } else if (version.status === 'unknown') {
      results.push(['warn', `reasonix CLI: ${context.cliPath} (version unknown: ${version.error})`]);
    } else if (version.warning) {
      results.push(['warn', `reasonix CLI: ${context.cliPath} (${version.version}; ${version.warning})`]);
    } else {
      results.push(['ok', `reasonix CLI: ${context.cliPath} (${version.version}; minimum ${version.minimum})`]);
    }
  } else {
    results.push(['fail', `reasonix CLI: ${context.cliError}`]);
  }

  if (!context.resolution.ref) {
    results.push(['fail', `model ref: unresolved (${context.resolution.error ?? 'no source'}) - run: node src/configure.mjs use <ref>`]);
  } else if (validateModelRef(context.resolution.ref)) {
    results.push(['fail', `model ref: ${validateModelRef(context.resolution.ref)}`]);
  } else {
    const doctor = doctorFor(context);
    doctorDiagnostics = doctor;
    if (!doctor.ok) {
      results.push(['warn', `model ref: ${context.resolution.ref} (could not verify against this machine: ${doctor.error})`]);
    } else {
      const { refs } = doctorRefs(doctor.data);
      const hit = refs.find((item) => item.ref === context.resolution.ref);
      if (refs.length === 0) results.push(['warn', `model ref: ${context.resolution.ref} (this machine reports no providers)`]);
      else if (!hit) results.push(['warn', `model ref: ${context.resolution.ref} is not among this machine's providers - run: node src/configure.mjs list`]);
      else if (!hit.keyPresent) results.push(['warn', `model ref: ${context.resolution.ref} (provider "${hit.provider}" reports no API key here)`]);
      else results.push(['ok', `model ref: ${context.resolution.ref} (provider ${hit.provider}, key present)`]);
    }
  }

  if (context.cliPath) {
    const invocation = cliSpawnCommand(context.cliPath, ['subagent', 'list'], { encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    const listed = invocation.error
      ? { status: 1, stdout: '', stderr: invocation.error }
      : spawnSync(invocation.file, invocation.args, invocation.options);
    const text = `${listed.stdout ?? ''}\n${listed.stderr ?? ''}`;
    const name = target.name;
    const present = listed.status === 0 && text.split('\n').some((line) => line.trim().split(/\s+/)[0] === name);
    const profile = readSubagentProfile(name);
    const issues = context.resolution.ref ? profileDrift(profile, context.resolution.ref, target.tools, role) : [];
    const unknownToolWarnings = doctorDiagnostics?.ok ? doctorUnknownToolReferences(doctorDiagnostics.data, name) : [];
    if (unknownToolWarnings.length) {
      results.push(['fail', `Reasonix capability diagnostics: ${unknownToolWarnings.join('; ')}`]);
    } else if (doctorDiagnostics?.ok) {
      results.push(['ok', `Reasonix capability diagnostics: no unknown allowed-tools identities for ${name}`]);
    }
    results.push(!present ? ['fail', `subagent profile: ${name} missing - create it with: node src/configure.mjs profile --role ${role} --create --write`]
      : !profile.exists ? ['fail', `subagent profile: ${name} is listed but SKILL.md is missing at ${profile.path || REASONIX_SKILLS_PATH}`]
        : issues.length ? ['fail', `subagent profile drift: ${issues.join('; ')} (${profile.path})`]
          : ['ok', `subagent profile: ${name} is installed and consistent (model + ${role === 'read' ? 'read-only' : 'write-role'} + tools: ${profile.frontmatter.tools.join(',')})`]);
  }

  for (const [state, message] of results) process.stdout.write(`${state === 'ok' ? 'OK  ' : state === 'warn' ? 'WARN' : 'FAIL'} ${message}\n`);
  if (results.some(([state]) => state === 'fail')) process.exit(1);
}

const [command = '', ...args] = process.argv.slice(2);
if (!command || command === 'help' || command === '--help' || command === '-h') {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
if (command === 'list') listCommand(args);
else if (command === 'show') showCommand(args);
else if (command === 'use') useCommand(args[0], args);
else if (command === 'presets') presetsCommand();
else if (command === 'codex') codexCommand(args);
else if (command === 'profile') profileCommand(args);
else if (command === 'verify') verifyCommand(args);
else if (command === 'export') exportCommand(args);
else if (command === 'import') importCommand(args);
else fail(`unknown command "${command}"\n\n${USAGE}`);
