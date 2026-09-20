import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import {
  DEFAULT_MIN_REASONIX_VERSION,
  DEFAULT_DOCTOR_CACHE_TTL_MS,
  atomicWriteFile,
  checkCliVersion,
  compareVersions,
  cliSpawnCommand,
  doctorCachePath,
  doctorRefs,
  doctorUnknownToolReferences,
  doctorWarnings,
  parseProfileFrontmatter,
  parseVersion,
  READ_ONLY_PROFILE_TOOLS,
  WRITE_PROFILE_TOOLS,
  readDoctor,
  resolveExecPolicy,
  resolveModelRef,
  resolveProviderSearchCapability,
  resolveSubagentRole,
  resolveTransport,
  upsertReasonixBlock,
  validateCodexBlock,
  validateModelRef,
} from '../src/config.mjs';
import {
  ACP_COMPACT_TRIGGER_RATIO,
  ACP_HISTORY_HARD_CAP_BYTES,
  compactHistory,
  historyBytes,
  prepareSessionContinuation,
} from '../src/acp-prototype.mjs';
import { AcpClient, collectAcpText } from '../src/acp-client.mjs';
import { AcpSessionCoordinator, summarizeAcpMessages } from '../src/acp-session.mjs';
import { ACP_REGISTRY_SCHEMA, AcpSessionRegistry } from '../src/acp-registry.mjs';
import { AcpSecurityPolicy, normalizeSessionScope, scrubAcpContent, scrubAcpMessages } from '../src/acp-security.mjs';
import { AcpTransportManager } from '../src/acp-transport.mjs';
import { WORKFLOW_STAGES, resolveWorkflowStage, stageForMode, workflowStatus } from '../src/workflow.mjs';

const BRIDGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_PATH = path.join(BRIDGE_ROOT, 'src', 'server.mjs');
const CONFIGURE_PATH = path.join(BRIDGE_ROOT, 'src', 'configure.mjs');
const CHECK_LINKS_PATH = path.join(BRIDGE_ROOT, 'scripts', 'check-readme-links.mjs');
const ACP_ACCEPTANCE_PATH = path.join(BRIDGE_ROOT, 'scripts', 'acp-acceptance.mjs');
const PACKAGE_PATH = path.join(BRIDGE_ROOT, 'package.json');
const CHANGELOG_PATH = path.join(BRIDGE_ROOT, 'CHANGELOG.md');
const PROJECT_TEST_ROOT = path.resolve(BRIDGE_ROOT, '..', '..', 'build', 'bridge-test');
const tempRoots = new Set();
const tempArtifacts = new Set();

function testArtifactRoot() {
  try {
    mkdirSync(PROJECT_TEST_ROOT, { recursive: true });
    return PROJECT_TEST_ROOT;
  } catch {
    return tmpdir();
  }
}

function tempRoot() {
  const root = mkdtempSync(path.join(testArtifactRoot(), 'case-'));
  tempRoots.add(root);
  return root;
}

function envFor(root, overrides = {}) {
  const checkpointPath = path.join(testArtifactRoot(), 'checkpoints', path.basename(root));
  tempArtifacts.add(checkpointPath);
  return {
    ...process.env,
    BRIDGE_CONFIG: path.join(root, 'bridge.config.json'),
    BRIDGE_PRESETS: path.join(root, 'presets.json'),
    CODEX_CONFIG: path.join(root, 'codex.config.toml'),
    BRIDGE_CHECKPOINT_DIR: checkpointPath,
    REASONIX_EXE: process.execPath,
    REASONIX_ROOT: root,
    REASONIX_MODEL_REF: 'fixture/provider',
    ...overrides,
  };
}

function writeCliFiles(root, { version = '1.38.7', contextWindow = 4096, vision = true, warnings = [] } = {}) {
  writeFileSync(path.join(root, 'doctor'), `
const args = process.argv.slice(2);
if (args.includes('--json')) {
  process.stdout.write(JSON.stringify({ version: ${JSON.stringify(version)}, config: { default_model: 'fixture/provider' }, providers: [{ name: 'fixture', models: ['provider'], key_present: true, base_url_host: 'fixture.invalid', context_window: ${contextWindow}, vision: ${vision} }], warnings: ${JSON.stringify(warnings)} }));
}
`, 'utf8');
  writeFileSync(path.join(root, 'subagent'), `
const fs = require('node:fs');
const args = process.argv.slice(2);
if ((args[0] === 'edit' || args[0] === 'create') && process.env.PROFILE_TARGET) {
  const modelIndex = args.indexOf('--model');
  const model = modelIndex >= 0 ? args[modelIndex + 1] : (process.env.PROFILE_MODEL || 'fixture/provider');
  const name = args[2] || 'deepseek-worker';
  const toolsIndex = args.indexOf('--tools');
  const tools = toolsIndex >= 0 ? args[toolsIndex + 1].split(',').join(', ') : 'read_file, grep, glob, ls, code_index, web_fetch';
  const lines = ['---', 'name: ' + name, 'description: Fixture worker', 'model: ' + model, 'allowed-tools: [' + tools + ']'];
  if ((!name.endsWith('-write') && process.env.PROFILE_READ_ONLY !== '0') || (name.endsWith('-write') && process.env.PROFILE_WRITE_READ_ONLY === '1')) lines.push('read-only: true');
  lines.push('---', '', '# fixture');
  fs.writeFileSync(process.env.PROFILE_TARGET, lines.join('\\n'));
} else {
  process.stdout.write('deepseek-worker  read-only\\ndeepseek-worker-write  write\\n');
}
`, 'utf8');
}

function writeProfile(root, model = 'fixture/provider', readOnly = true) {
  const dir = path.join(root, 'skills', 'deepseek-worker');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), ['---', 'name: deepseek-worker', 'description: Fixture worker', `model: ${model}`, `allowed-tools: [${READ_ONLY_PROFILE_TOOLS.join(', ')}]`, `read-only: ${readOnly}`, '---', '', '# fixture'].join('\n'), 'utf8');
  return path.join(dir, 'SKILL.md');
}

function writeRoleProfile(root, model = 'fixture/provider', readOnly = null) {
  const dir = path.join(root, 'skills', 'deepseek-worker-write');
  mkdirSync(dir, { recursive: true });
  const lines = ['---', 'name: deepseek-worker-write', 'description: Fixture write worker', `model: ${model}`, `allowed-tools: [${WRITE_PROFILE_TOOLS.join(', ')}]`];
  if (readOnly !== null) lines.push(`read-only: ${readOnly}`);
  lines.push('---', '', '# fixture');
  writeFileSync(path.join(dir, 'SKILL.md'), lines.join('\n'), 'utf8');
  return path.join(dir, 'SKILL.md');
}

function commitFixture(root) {
  const init = spawnSync('git', ['-C', root, 'init', '-q'], { encoding: 'utf8', windowsHide: true });
  assert.equal(init.status, 0, init.stderr);
  for (const [key, value] of [['user.email', 'fixture@example.invalid'], ['user.name', 'fixture']]) {
    const config = spawnSync('git', ['-C', root, 'config', key, value], { encoding: 'utf8', windowsHide: true });
    assert.equal(config.status, 0, config.stderr);
  }
  const add = spawnSync('git', ['-C', root, 'add', '.'], { encoding: 'utf8', windowsHide: true });
  assert.equal(add.status, 0, add.stderr);
  const commit = spawnSync('git', ['-C', root, 'commit', '-qm', 'fixture'], { encoding: 'utf8', windowsHide: true });
  assert.equal(commit.status, 0, commit.stderr);
}

function writeVersionStub(root, version) {
  if (process.platform === 'win32') {
    const file = path.join(root, 'reasonix-stub.cmd');
    const body = [
      '@echo off',
      `if "%1"=="--version" (echo Reasonix ${version} & exit /b 0)`,
      'if "%1"=="doctor" (echo {"version":"1.38.7","config":{"default_model":"fixture/provider"},"providers":[{"name":"fixture","models":["provider"],"key_present":true}]} & exit /b 0)',
      'if "%1"=="subagent" (echo deepseek-worker read-only & exit /b 0)',
      'exit /b 0',
    ].join('\r\n');
    writeFileSync(file, body, 'utf8');
    return file;
  }
  const file = path.join(root, 'reasonix-stub');
  writeFileSync(file, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "Reasonix ${version}"; exit 0; fi
if [ "$1" = "doctor" ]; then echo '{"version":"1.38.7","config":{"default_model":"fixture/provider"},"providers":[{"name":"fixture","models":["provider"],"key_present":true}]}' ; exit 0; fi
if [ "$1" = "subagent" ]; then echo 'deepseek-worker read-only'; exit 0; fi
exit 0
`, 'utf8');
  // chmod is intentionally avoided in the Windows test path; POSIX runners use a shell script.
  spawnSync('chmod', ['+x', file]);
  return file;
}

function writeAcpCli(root, { failStart = false } = {}) {
  writeFileSync(path.join(root, 'acp'), `
const readline = require('node:readline');
if (${JSON.stringify(failStart)} && process.argv[1].endsWith('acp')) process.exit(17);
let nextSession = 1;
const input = readline.createInterface({ input: process.stdin, terminal: false });
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
input.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {}, delete: {} } } } });
  else if (message.method === 'session/new') send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'server-fixture-' + nextSession++ } });
  else if (message.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'acp-server-answer' } } } });
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
  } else if (message.method === 'session/close' || message.method === 'session/delete' || message.method === 'session/cancel') send({ jsonrpc: '2.0', id: message.id, result: {} });
});
`, 'utf8');
}

function acpFixtureSpawn() {
  const child = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const received = [];
  let buffer = '';
  let nextSession = 1;
  const send = (message) => setTimeout(() => stdout.write(`${JSON.stringify(message)}\n`), 0);
  const respond = (message, result) => send({ jsonrpc: '2.0', id: message.id, result });
  const handle = (message) => {
    received.push(message);
    if (message.method === 'initialize') {
      respond(message, { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {}, delete: {} } } });
    } else if (message.method === 'session/new') {
      respond(message, { sessionId: `fixture-session-${nextSession++}` });
    } else if (message.method === 'session/load' || message.method === 'session/resume') {
      respond(message, { sessionId: message.params.sessionId });
    } else if (message.method === 'session/prompt') {
      if (message.params.prompt?.[0]?.text === 'hang') return;
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fixture-' } } } });
      send({ jsonrpc: '2.0', id: 77, method: 'session/request_permission', params: { sessionId: message.params.sessionId, toolCall: { title: 'fixture' } } });
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } } } });
      setTimeout(() => respond(message, { stopReason: 'end_turn' }), 5);
    } else if (message.method === 'session/cancel' || message.method === 'session/close' || message.method === 'session/delete') {
      respond(message, {});
    }
  };
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) handle(JSON.parse(line));
      }
      callback();
    },
  });
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal = 'SIGTERM') => {
    if (child.exitCode !== null || child.signalCode) return false;
    child.signalCode = signal;
    stdout.end();
    stderr.end();
    child.emit('close', null, signal);
    return true;
  };
  return { child, received, spawnImpl: () => child };
}

function runNode(args, root, overrides = {}) {
  return spawnSync(process.execPath, args, {
    cwd: root,
    env: envFor(root, overrides),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function readMcpSession(child, requests) {
  let buffer = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); waiter(message); }
    }
  });
  const request = (id, method, params = {}) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP request ${id} timed out`)); }, 5000);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const responses = [];
  for (const item of requests) responses.push(await request(item.id, item.method, item.params));
  child.stdin.end();
  return responses;
}

function mcpClient(child) {
  let buffer = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); waiter(message); }
    }
  });
  return {
    request(id, method, params = {}) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP request ${id} timed out`)); }, 5000);
        pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
  };
}

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  for (const artifact of tempArtifacts) rmSync(artifact, { recursive: true, force: true });
});

describe('configuration pure functions', () => {
  test('release metadata uses semver and documents the package version', () => {
    const packageData = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'));
    assert.match(packageData.version, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/);
    const changelog = readFileSync(CHANGELOG_PATH, 'utf8');
    const escapedVersion = packageData.version.replaceAll('.', '\\.');
    assert.match(changelog, new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm'));
  });

  test('parses and compares version gates', () => {
    assert.deepEqual(parseVersion('Reasonix CLI v1.38.7'), { major: 1, minor: 38, patch: 7, normalized: '1.38.7' });
    assert.equal(compareVersions('1.38.5', DEFAULT_MIN_REASONIX_VERSION), -1);
    assert.equal(compareVersions('1.38.6', DEFAULT_MIN_REASONIX_VERSION), 0);
    assert.equal(compareVersions('1.39', DEFAULT_MIN_REASONIX_VERSION), 1);
    assert.equal(parseVersion('development build'), null);
  });

  test('Windows command shims never enable a shell and reject cmd metacharacters', () => {
    const safe = cliSpawnCommand('reasonix.cmd', ['subagent', 'run', 'deepseek-worker', '--', 'review task'], { shell: true });
    if (process.platform !== 'win32') {
      assert.equal(safe.file, 'reasonix.cmd');
      assert.equal(safe.error, '');
      return;
    }
    assert.equal(safe.file.toLowerCase().endsWith('cmd.exe'), true);
    assert.equal(safe.options.shell, false);
    assert.equal(safe.error, '');
    const unsafe = cliSpawnCommand('reasonix.cmd', ['subagent', 'run', 'deepseek-worker', '--', 'review & echo injected | %PATH%!'], {});
    assert.match(unsafe.error, /cmd metacharacters/);
    assert.deepEqual(unsafe.args, []);
  });

  test('keeps model resolution order and validates refs', () => {
    const old = process.env.REASONIX_MODEL_REF;
    try {
      process.env.REASONIX_MODEL_REF = 'env/provider';
      assert.equal(resolveModelRef({ cliPath: '', bridgeConfig: { path: 'fixture.json', data: { modelRef: 'file/provider' } } }).ref, 'env/provider');
      delete process.env.REASONIX_MODEL_REF;
      assert.equal(resolveModelRef({ cliPath: '', bridgeConfig: { path: 'fixture.json', data: { modelRef: 'file/provider' } } }).ref, 'file/provider');
      assert.equal(validateModelRef('provider/model'), '');
      assert.match(validateModelRef('provider model'), /whitespace/);
      assert.match(validateModelRef('model-only'), /look like/);
    } finally {
      if (old === undefined) delete process.env.REASONIX_MODEL_REF;
      else process.env.REASONIX_MODEL_REF = old;
    }
  });

  test('normalizes doctor model[] and single model forms', () => {
    const result = doctorRefs({
      config: { default_model: 'alpha/one' },
      providers: [
        { name: 'alpha', models: ['one', 'two'], key_present: true, base_url_host: 'alpha.invalid', context_window: 8192, vision: true },
        { name: 'beta', model: 'solo', key_present: false },
      ],
    });
    assert.deepEqual(result.refs.map((item) => item.ref), ['alpha/one', 'alpha/two', 'beta/solo']);
    assert.equal(result.refs[0].isReasonixDefault, true);
    assert.equal(result.refs[0].baseHost, 'alpha.invalid');
    assert.equal(result.refs[0].contextWindow, 8192);
    assert.equal(result.refs[0].vision, true);
    assert.equal(result.refs[2].keyPresent, false);
  });

  test('preserves and scopes Reasonix unknown-tool diagnostics', () => {
    const doctor = {
      warnings: [
        'skill "deepseek-worker" allowed-tools reference "git_log" is not a known tool identity',
        'skill "deepseek-worker-write" allowed-tools reference "git_diff" is not a known tool identity',
        'unrelated warning',
      ],
    };
    assert.equal(doctorWarnings(doctor).length, 3);
    assert.deepEqual(doctorUnknownToolReferences(doctor, 'deepseek-worker'), [doctor.warnings[0]]);
    assert.deepEqual(doctorUnknownToolReferences(doctor, 'deepseek-worker-write'), [doctor.warnings[1]]);
    assert.deepEqual(doctorUnknownToolReferences(doctor, 'other'), []);
  });

  test('caches doctor inventory, expires it, and invalidates on CLI changes', () => {
    const root = tempRoot();
    const cli = writeVersionStub(root, '1.38.7');
    const cachePath = doctorCachePath(path.join(root, 'bridge.config.json'));
    const first = readDoctor(cli, 30_000, { cachePath });
    assert.equal(first.cache, 'miss');
    assert.equal(JSON.parse(readFileSync(cachePath, 'utf8')).schema, 1);
    assert.equal(JSON.parse(readFileSync(cachePath, 'utf8')).data.providers[0].name, 'fixture');
    assert.deepEqual(JSON.parse(readFileSync(cachePath, 'utf8')).data.warnings, []);
    const second = readDoctor(cli, 30_000, { cachePath });
    assert.equal(second.cache, 'hit');

    writeFileSync(cachePath, '{broken', 'utf8');
    const recovered = readDoctor(cli, 30_000, { cachePath });
    assert.equal(recovered.cache, 'miss');
    const malformed = JSON.parse(readFileSync(cachePath, 'utf8'));
    malformed.data = { providers: 'not-an-array' };
    writeFileSync(cachePath, JSON.stringify(malformed), 'utf8');
    assert.equal(readDoctor(cli, 30_000, { cachePath }).cache, 'miss');
    const expired = JSON.parse(readFileSync(cachePath, 'utf8'));
    expired.fetchedAt = Date.now() - DEFAULT_DOCTOR_CACHE_TTL_MS - 1;
    writeFileSync(cachePath, JSON.stringify(expired), 'utf8');
    const refreshedAfterExpiry = readDoctor(cli, 30_000, { cachePath });
    assert.equal(refreshedAfterExpiry.cache, 'miss');

    const changedAt = new Date(Date.now() + 20_000);
    utimesSync(cli, changedAt, changedAt);
    const refreshedAfterCliChange = readDoctor(cli, 30_000, { cachePath });
    assert.equal(refreshedAfterCliChange.cache, 'miss');
    assert.equal(readDoctor(cli, 30_000, { cachePath, refresh: true }).cache, 'refreshed');
  });

  test('parses profile model, read-only and tool frontmatter', () => {
    const profile = parseProfileFrontmatter('---\nmodel: "fixture/provider"\nread-only: true\nallowed-tools: [read_file, grep]\n---\n');
    assert.equal(profile.model, 'fixture/provider');
    assert.equal(profile.readOnly, true);
    assert.deepEqual(profile.tools, ['read_file', 'grep']);
    assert.equal(parseProfileFrontmatter('---\ndescription: "workers #1"\nallowed-tools:\n  - read_file\n  - grep\n---\n').fields.description, 'workers #1');
    assert.deepEqual(parseProfileFrontmatter('---\ndescription: "workers #1"\nallowed-tools:\n  - read_file\n  - grep\n---\n').tools, ['read_file', 'grep']);
    assert.deepEqual(READ_ONLY_PROFILE_TOOLS, ['read_file', 'grep', 'glob', 'ls', 'code_index', 'web_fetch']);
    assert.deepEqual(WRITE_PROFILE_TOOLS, [...READ_ONLY_PROFILE_TOOLS, 'edit_file', 'write_file']);
    assert.deepEqual(resolveProviderSearchCapability({ providers: [{ name: 'fixture', models: ['provider'] }] }), {
      owner: 'provider',
      tool: 'web_search',
      available: false,
      status: 'unavailable',
      reason: 'provider_capability_not_advertised',
    });
    assert.equal(resolveProviderSearchCapability({ providers: [{ name: 'fixture', web_search: true }] }).available, true);
    assert.equal(resolveProviderSearchCapability({ providers: [{ name: 'fixture', capabilities: { web_search: false } }] }).reason, 'provider_reported_unavailable');
  });

  test('keeps workflow stages explicit and fail-closed', () => {
    assert.deepEqual(WORKFLOW_STAGES, ['plan', 'implement', 'exec', 'review']);
    assert.equal(stageForMode('plan'), 'plan');
    assert.equal(stageForMode('inspect'), null);
    assert.deepEqual(resolveWorkflowStage(undefined, 'review'), { stage: 'review', error: null });
    assert.deepEqual(resolveWorkflowStage(undefined, 'exec', 'node-test'), { stage: 'exec', error: null });
    assert.deepEqual(resolveWorkflowStage('exec', 'review'), { stage: null, error: 'stage=exec is reserved for reasonix_exec' });
    assert.deepEqual(resolveWorkflowStage('plan', 'implement'), { stage: null, error: 'mode=implement only supports stage=implement' });
    assert.deepEqual(workflowStatus([{ state: 'running', stage: 'plan' }, { state: 'running', stage: 'plan' }], { stage: 'review' }), {
      template: ['plan', 'implement', 'exec', 'review'],
      activeStages: ['plan'],
      lastStage: 'review',
    });
  });

  test('resolves a fail-closed named execution policy', () => {
    assert.equal(resolveExecPolicy({ data: {} }).enabled, false);
    const policy = resolveExecPolicy({ data: { execPolicy: {
      enabled: true,
      allowedPaths: ['.', 'tools'],
      commands: [{ name: 'node-test', executable: 'node', argsPrefix: ['--test'], maxArgs: 4 }],
      timeoutSeconds: 12,
      outputCharCap: 800,
    } } });
    assert.equal(policy.enabled, true);
    assert.deepEqual(policy.allowedPaths, ['', 'tools']);
    assert.deepEqual(policy.commands[0], { name: 'node-test', executable: 'node', argsPrefix: ['--test'], maxArgs: 4 });
    assert.equal(policy.timeoutSeconds, 12);
    assert.equal(policy.outputCharCap, 800);
    const unsafe = resolveExecPolicy({ data: { execPolicy: { enabled: true, allowedPaths: ['..'], commands: [], requireCleanTree: false } } });
    assert.equal(unsafe.enabled, true);
    assert.match(unsafe.errors.join('; '), /escapes the workspace/);
    assert.match(unsafe.errors.join('; '), /requireCleanTree=false/);
  });

  test('worker prompts require opaque continuation cursors', () => {
    const readPrompt = readFileSync(path.join(BRIDGE_ROOT, 'prompts', 'deepseek-worker-prompt.md'), 'utf8');
    const writePrompt = readFileSync(path.join(BRIDGE_ROOT, 'prompts', 'deepseek-worker-write-prompt.md'), 'utf8');
    assert.match(readPrompt, /allowed-tools.*web_fetch/u);
    assert.match(readPrompt, /bridge.*不提供任意 URL MCP 工具/isu);
    assert.match(readPrompt, /web_search.*provider.*unavailable/isu);
    assert.match(writePrompt, /native `web_fetch`/iu);
    assert.match(writePrompt, /web_search.*provider-owned.*unavailable/iu);
    assert.match(readPrompt, /continuation cursor.*不透明值/isu);
    assert.match(readPrompt, /逐字原样传回/isu);
    assert.match(readPrompt, /重新调用 `read_file`/u);
    assert.match(readPrompt, /--prompt-file prompts\/deepseek-worker-prompt\.md/u);
    assert.match(writePrompt, /continuation cursor is opaque state/iu);
    assert.match(writePrompt, /Pass the exact value returned by the tool/iu);
  });

  test('upserts bridge blocks at append, first and last boundaries', () => {
    const block = '[mcp_servers.reasonix_local]\ncommand = "node"\nargs = ["server.mjs"]\nstartup_timeout_sec = 30\n\n[mcp_servers.reasonix_local.env]\nREASONIX_ROOT = "root"\nREASONIX_SUBAGENT = "worker"\nREASONIX_MODEL_REF = "fixture/provider"\n';
    assert.match(upsertReasonixBlock('title = "x"\n', block), /title = "x"[\s\S]*\[mcp_servers\.reasonix_local\]/);
    assert.match(upsertReasonixBlock('[mcp_servers.reasonix_local]\nold = true\n\n[other]\nvalue = 1\n', block), /command = "node"[\s\S]*\[other\]/);
    assert.match(upsertReasonixBlock('[other]\nvalue = 1\n\n[mcp_servers.reasonix_local]\nold = true\n', block), /\[other\][\s\S]*command = "node"/);
  });

  test('validates required Codex keys and merges duplicate bridge sections', () => {
    const block = '[mcp_servers.reasonix_local]\ncommand = "node"\nargs = ["server.mjs"]\nstartup_timeout_sec = 30\n\n[mcp_servers.reasonix_local.env]\nREASONIX_ROOT = "root"\nREASONIX_SUBAGENT = "worker"\nREASONIX_MODEL_REF = "fixture/provider"\n';
    assert.equal(validateCodexBlock(block), '');
    assert.match(validateCodexBlock('[mcp_servers.reasonix_local]\ncommand = "node"\n'), /missing \[mcp_servers\.reasonix_local\.env\] section/);
    const merged = upsertReasonixBlock([
      '[mcp_servers.reasonix_local]', 'old = 1', '[other]', 'value = 1',
      '[mcp_servers.reasonix_local.env]', 'REASONIX_ROOT = "old"',
      '[mcp_servers.reasonix_local]', 'old = 2', '[tail]', 'value = 2',
    ].join('\n'), block);
    assert.equal((merged.match(/^\[mcp_servers\.reasonix_local\]$/gm) ?? []).length, 1);
    assert.equal((merged.match(/^\[mcp_servers\.reasonix_local\.env\]$/gm) ?? []).length, 1);
    assert.match(merged, /\[other\][\s\S]*\[tail\]/);
  });

  test('preserves CRLF output for mixed-line-ending input and atomically replaces files', () => {
    const block = '[mcp_servers.reasonix_local]\ncommand = "node"\nargs = ["server.mjs"]\nstartup_timeout_sec = 30\n\n[mcp_servers.reasonix_local.env]\nREASONIX_ROOT = "root"\nREASONIX_SUBAGENT = "worker"\nREASONIX_MODEL_REF = "fixture/provider"\n';
    const updated = upsertReasonixBlock('[tool]\r\nvalue = 1\n[mcp_servers.reasonix_local]\r\nold = true\r\n', block);
    assert.match(updated, /\r\n/);
    assert.match(updated, /\[tool\]\r\nvalue = 1/);
    const root = tempRoot();
    const target = path.join(root, 'config.toml');
    writeFileSync(target, 'old', 'utf8');
    atomicWriteFile(target, 'new');
    assert.equal(readFileSync(target, 'utf8'), 'new');
    assert.equal(readdirSync(root).filter((name) => name.includes('.tmp-') || name.includes('.old-')).length, 0);
  });
});

describe('offline command contracts', () => {
  test('README link checker validates local links without network access', () => {
    const valid = spawnSync(process.execPath, [CHECK_LINKS_PATH], {
      cwd: BRIDGE_ROOT,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /README\.md: local links OK/);

    const root = tempRoot();
    writeFileSync(path.join(root, 'README.md'), '[missing](docs/nope.md)\n[external](https://example.invalid/docs)\n#anchor\n', 'utf8');
    const broken = spawnSync(process.execPath, [CHECK_LINKS_PATH, 'README.md'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /missing local link target docs\/nope\.md/);
    assert.doesNotMatch(broken.stderr, /example\.invalid/);
  });

  test('configure use and codex --write only touch temporary files', () => {
    const root = tempRoot();
    writeCliFiles(root);
    const use = runNode([CONFIGURE_PATH, 'use', 'fixture/provider'], root);
    assert.equal(use.status, 0, use.stderr);
    assert.equal(JSON.parse(readFileSync(path.join(root, 'bridge.config.json'), 'utf8')).modelRef, 'fixture/provider');
    writeFileSync(path.join(root, 'codex.config.toml'), [
      '[tool]', 'value = 1', '[mcp_servers.reasonix_local]', 'old = 1',
      '[mcp_servers.reasonix_local.env]', 'REASONIX_ROOT = "old"',
      '[mcp_servers.reasonix_local]', 'old = 2', '[tail]', 'value = 2',
    ].join('\n'), 'utf8');
    const codex = runNode([CONFIGURE_PATH, 'codex', '--write'], root);
    assert.equal(codex.status, 0, codex.stderr);
    const written = readFileSync(path.join(root, 'codex.config.toml'), 'utf8');
    assert.match(written, /\[mcp_servers\.reasonix_local\]/);
    assert.match(written, /REASONIX_MODEL_REF = "fixture\/provider"/);
    assert.equal((written.match(/^\[mcp_servers\.reasonix_local\]$/gm) ?? []).length, 1);
    assert.equal((written.match(/^\[mcp_servers\.reasonix_local\.env\]$/gm) ?? []).length, 1);
    assert.equal(readdirSync(root).filter((name) => name.includes('codex.config.toml.bak-')).length, 1);
  });

  test('configure list reuses doctor cache and --refresh bypasses it', () => {
    const root = tempRoot();
    const cli = writeVersionStub(root, '1.38.7');
    const first = runNode([CONFIGURE_PATH, 'list'], root, { REASONIX_EXE: cli });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /doctor inventory\s+: live/);
    const second = runNode([CONFIGURE_PATH, 'list'], root, { REASONIX_EXE: cli });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /doctor inventory\s+: cache hit/);
    const forced = runNode([CONFIGURE_PATH, 'list', '--refresh'], root, { REASONIX_EXE: cli });
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(forced.stdout, /doctor inventory\s+: refreshed/);
    const shown = runNode([CONFIGURE_PATH, 'show', '--refresh'], root, { REASONIX_EXE: cli });
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /doctor inventory: refreshed/);
  });

  test('configure export is redacted and import only prints safe differences', () => {
    const root = tempRoot();
    writeCliFiles(root);
    writeProfile(root);
    writeFileSync(path.join(root, 'bridge.config.json'), JSON.stringify({ modelRef: 'fixture/provider' }), 'utf8');
    const profileEnv = { REASONIX_SKILLS_DIR: path.join(root, 'skills') };
    const exported = runNode([CONFIGURE_PATH, 'export'], root, profileEnv);
    assert.equal(exported.status, 0, exported.stderr);
    const summary = JSON.parse(exported.stdout);
    assert.equal(summary.schema, 1);
    assert.equal(summary.current.modelRef, 'fixture/provider');
    assert.equal(summary.current.profile, 'deepseek-worker');
    assert.equal(summary.current.profileReadOnly, true);
    assert.equal(summary.providers[0].name, 'fixture');
    assert.equal(Object.hasOwn(summary.providers[0], 'key_present'), false);
    assert.equal(Object.hasOwn(summary.providers[0], 'base_url_host'), false);
    const rootPattern = new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    assert.doesNotMatch(exported.stdout, rootPattern);

    const imported = {
      ...summary,
      platform: { ...summary.platform, os: summary.platform.os === 'win32' ? 'linux' : 'win32' },
      providers: [{ name: 'other', models: ['other-model'] }],
      current: { ...summary.current, modelRef: 'other/provider' },
    };
    const summaryPath = path.join(root, 'peer-summary.json');
    writeFileSync(summaryPath, JSON.stringify(imported), 'utf8');
    const bridgePath = path.join(root, 'bridge.config.json');
    const bridgeBefore = readFileSync(bridgePath, 'utf8');
    const compared = runNode([CONFIGURE_PATH, 'import', summaryPath], root, profileEnv);
    assert.equal(compared.status, 0, compared.stderr);
    assert.match(compared.stdout, /DIFF platform/);
    assert.match(compared.stdout, /DIFF current/);
    assert.doesNotMatch(compared.stdout, rootPattern);
    assert.equal(readFileSync(bridgePath, 'utf8'), bridgeBefore);
    assert.equal(readdirSync(root).some((name) => name === 'codex.config.toml'), false);

    const unsafe = { ...summary, current: { ...summary.current, modelRef: 'https://secret.example/token' } };
    writeFileSync(summaryPath, JSON.stringify(unsafe), 'utf8');
    const rejected = runNode([CONFIGURE_PATH, 'import', summaryPath], root, profileEnv);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /current\.modelRef is invalid/);
    assert.doesNotMatch(rejected.stderr, /secret\.example/);

    const unsafeVersion = { ...summary, reasonix: { ...summary.reasonix, version: 'C:\\Users\\secret\\version' } };
    writeFileSync(summaryPath, JSON.stringify(unsafeVersion), 'utf8');
    const rejectedVersion = runNode([CONFIGURE_PATH, 'import', summaryPath], root, profileEnv);
    assert.equal(rejectedVersion.status, 1);
    assert.match(rejectedVersion.stderr, /reasonix is invalid/);
    assert.doesNotMatch(rejectedVersion.stderr, /Users\\secret/);
  });

  test('verify fails below the default version and downgrades only with an explicit override', () => {
    const root = tempRoot();
    const cli = writeVersionStub(root, '1.38.5');
    writeFileSync(path.join(root, 'bridge.config.json'), JSON.stringify({ modelRef: 'fixture/provider' }), 'utf8');
    writeProfile(root);
    const failed = runNode([CONFIGURE_PATH, 'verify'], root, { REASONIX_EXE: cli, REASONIX_SKILLS_DIR: path.join(root, 'skills') });
    assert.equal(failed.status, 1);
    assert.match(failed.stdout, /FAIL reasonix CLI/);
    const relaxed = runNode([CONFIGURE_PATH, 'verify'], root, { REASONIX_EXE: cli, REASONIX_MIN_VERSION: '1.0', REASONIX_SKILLS_DIR: path.join(root, 'skills') });
    assert.equal(relaxed.status, 0, relaxed.stderr);
    assert.match(relaxed.stdout, /WARN reasonix CLI/);
  });

  test('profile preview is read-only and profile --sync --write repairs model drift', () => {
    const root = tempRoot();
    writeCliFiles(root);
    const profileFile = writeProfile(root, 'old/provider');
    writeFileSync(path.join(root, 'bridge.config.json'), JSON.stringify({ modelRef: 'fixture/provider' }), 'utf8');
    const profileEnv = { REASONIX_SKILLS_DIR: path.join(root, 'skills') };
    const verify = runNode([CONFIGURE_PATH, 'verify'], root, profileEnv);
    assert.equal(verify.status, 1);
    assert.match(verify.stdout, /subagent profile drift/);
    const preview = runNode([CONFIGURE_PATH, 'profile', '--sync'], root, profileEnv);
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /write        : not requested/);
    assert.match(readFileSync(profileFile, 'utf8'), /old\/provider/);
    const synced = runNode([CONFIGURE_PATH, 'profile', '--sync', '--write'], root, {
      ...profileEnv,
      PROFILE_TARGET: profileFile,
      PROFILE_MODEL: 'fixture/provider',
    });
    assert.equal(synced.status, 0, synced.stderr);
    assert.match(synced.stdout, /verified/);
    assert.match(readFileSync(profileFile, 'utf8'), /model: fixture\/provider/);
    const after = runNode([CONFIGURE_PATH, 'verify'], root, profileEnv);
    assert.equal(after.status, 0, after.stderr);
    assert.match(after.stdout, /installed and consistent/);
    assert.match(after.stdout, /tools: read_file,grep,glob,ls,code_index,web_fetch/);
  });

  test('verify fails when Reasonix doctor reports an unknown tool for the selected profile', () => {
    const root = tempRoot();
    writeCliFiles(root, {
      warnings: ['skill "deepseek-worker" allowed-tools reference "git_log" is not a known tool identity'],
    });
    writeFileSync(path.join(root, 'bridge.config.json'), JSON.stringify({ modelRef: 'fixture/provider' }), 'utf8');
    writeProfile(root);
    const result = runNode([CONFIGURE_PATH, 'verify'], root, { REASONIX_SKILLS_DIR: path.join(root, 'skills') });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL Reasonix capability diagnostics: .*git_log/);
    assert.match(result.stdout, /OK   subagent profile: deepseek-worker/);
  });

  test('write profile is separate, explicit, and has no read-only guard', () => {
    const root = tempRoot();
    writeCliFiles(root);
    writeFileSync(path.join(root, 'bridge.config.json'), JSON.stringify({ modelRef: 'fixture/provider' }), 'utf8');
    const writeProfilePath = path.join(root, 'skills', 'deepseek-worker-write', 'SKILL.md');
    mkdirSync(path.dirname(writeProfilePath), { recursive: true });
    const created = runNode([CONFIGURE_PATH, 'profile', '--role', 'write', '--create', '--write'], root, {
      REASONIX_SKILLS_DIR: path.join(root, 'skills'),
      PROFILE_TARGET: writeProfilePath,
    });
    assert.equal(created.status, 0, created.stderr);
    assert.match(created.stdout, /profile role : write/);
    assert.match(created.stdout, /profile name : deepseek-worker-write/);
    assert.match(created.stdout, /write-role contract are consistent/);
    const profileText = readFileSync(writeProfilePath, 'utf8');
    assert.doesNotMatch(profileText, /read-only\s*:/i);
    assert.match(profileText, /edit_file/);
    assert.match(profileText, /write_file/);
    const verified = runNode([CONFIGURE_PATH, 'verify', '--role', 'write'], root, { REASONIX_SKILLS_DIR: path.join(root, 'skills') });
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /subagent profile: deepseek-worker-write .*write-role/);
    const readVerified = runNode([CONFIGURE_PATH, 'verify'], root, { REASONIX_SKILLS_DIR: path.join(root, 'skills') });
    assert.equal(readVerified.status, 1);
    assert.match(readVerified.stdout, /subagent profile: deepseek-worker .*SKILL\.md is missing/);
  });

  test('write profile sync removes a stale read-only guard without changing read profile', () => {
    const root = tempRoot();
    writeCliFiles(root);
    const readProfilePath = writeProfile(root);
    const writeProfilePath = writeRoleProfile(root, 'old/provider', true);
    writeFileSync(path.join(root, 'bridge.config.json'), JSON.stringify({ modelRef: 'fixture/provider' }), 'utf8');
    const synced = runNode([CONFIGURE_PATH, 'profile', '--role=write', '--sync', '--write'], root, {
      REASONIX_SKILLS_DIR: path.join(root, 'skills'),
      PROFILE_TARGET: writeProfilePath,
      PROFILE_MODEL: 'fixture/provider',
      PROFILE_WRITE_READ_ONLY: '1',
    });
    assert.equal(synced.status, 0, synced.stderr);
    assert.doesNotMatch(readFileSync(writeProfilePath, 'utf8'), /read-only\s*:/i);
    assert.match(readFileSync(writeProfilePath, 'utf8'), /model: fixture\/provider/);
    assert.match(readFileSync(readProfilePath, 'utf8'), /read-only: true/);
  });

  test('verify fails when the profile tool set drifts from the read-only contract', () => {
    const root = tempRoot();
    writeCliFiles(root);
    const profileFile = writeProfile(root);
    writeFileSync(profileFile, readFileSync(profileFile, 'utf8').replace(', code_index', ''), 'utf8');
    const result = runNode([CONFIGURE_PATH, 'verify'], root, { REASONIX_SKILLS_DIR: path.join(root, 'skills') });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /subagent profile drift: allowed-tools=.*expected .*code_index/);
  });

  test('profile --create --write adds the read-only guard after CLI creation', () => {
    const root = tempRoot();
    writeCliFiles(root);
    const skillDir = path.join(root, 'skills', 'deepseek-worker');
    mkdirSync(skillDir, { recursive: true });
    const profileFile = path.join(skillDir, 'SKILL.md');
    writeFileSync(path.join(root, 'bridge.config.json'), JSON.stringify({ modelRef: 'fixture/provider' }), 'utf8');
    const result = runNode([CONFIGURE_PATH, 'profile', '--create', '--write'], root, {
      REASONIX_SKILLS_DIR: path.join(root, 'skills'),
      PROFILE_TARGET: profileFile,
      PROFILE_READ_ONLY: '0',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /verified/);
    assert.match(readFileSync(profileFile, 'utf8'), /read-only: true/);
  });

  test('verify fails closed when the listed profile has no SKILL.md', () => {
    const root = tempRoot();
    const stub = writeVersionStub(root, '1.38.7');
    writeFileSync(path.join(root, 'bridge.config.json'), JSON.stringify({ modelRef: 'fixture/provider' }), 'utf8');
    const result = runNode([CONFIGURE_PATH, 'verify'], root, { REASONIX_EXE: stub, REASONIX_SKILLS_DIR: path.join(root, 'skills') });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL subagent profile: deepseek-worker/);
    assert.match(result.stdout, /SKILL\.md is missing/);
  });

  test('invalid profile names fail with a concise diagnostic', () => {
    const root = tempRoot();
    const stub = writeVersionStub(root, '1.38.7');
    writeFileSync(path.join(root, 'bridge.config.json'), JSON.stringify({ modelRef: 'fixture/provider', subagent: '../escape' }), 'utf8');
    const result = runNode([CONFIGURE_PATH, 'profile'], root, { REASONIX_EXE: stub, REASONIX_SKILLS_DIR: path.join(root, 'skills') });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid subagent profile name/);
    assert.doesNotMatch(result.stderr, /at .*configure\.mjs/);
  });

  test('MCP session exposes tools and a structured version status without a model call', async () => {
    const root = tempRoot();
    writeCliFiles(root);
    const child = spawn(process.execPath, [SERVER_PATH], { cwd: root, env: envFor(root, { BRIDGE_LOG: '' }), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const responses = await readMcpSession(child, [
      { id: 1, method: 'initialize' },
      { id: 2, method: 'tools/list' },
      { id: 3, method: 'tools/call', params: { name: 'reasonix_status', arguments: {} } },
    ]);
    const exit = await new Promise((resolve) => child.once('close', resolve));
    assert.equal(exit, 0);
    assert.equal(responses[0].result.serverInfo.name, 'reasonix-local-bridge');
    assert.deepEqual(responses[1].result.tools.map((tool) => tool.name), ['reasonix_run', 'reasonix_resume', 'reasonix_cancel', 'reasonix_events', 'reasonix_rollback', 'reasonix_exec', 'reasonix_status']);
    const status = JSON.parse(responses[2].result.content[0].text);
    assert.equal(status.versionCheck, 'ok');
    assert.equal(status.workerReadOnlyAssumed, true);
    assert.equal(status.subagentRole, 'read');
    assert.deepEqual(status.checkpoint, { enabled: true, readyCount: 0 });
    assert.equal(status.historyHardCapBytes, 128 * 1024 * 1024);
    assert.equal(status.contextWindow, 4096);
    assert.equal(status.vision, true);
    assert.equal(status.execPolicy.enabled, false);
    assert.deepEqual(status.execPolicy.commands, []);
    assert.equal(status.base_url_host, 'fixture.invalid');
    assert.deepEqual(status.providerSearch, {
      owner: 'provider',
      tool: 'web_search',
      available: false,
      status: 'unavailable',
      reason: 'provider_capability_not_advertised',
    });
    assert.deepEqual(status.workflow, { template: ['plan', 'implement', 'exec', 'review'], activeStages: [], lastStage: null });
    assert.deepEqual(status.modeDefaults, {
      inspect: { maxSteps: 80, toolRounds: 40, timeoutSeconds: 600 },
      review: { maxSteps: 96, toolRounds: 48, timeoutSeconds: 900 },
      plan: { maxSteps: 96, toolRounds: 48, timeoutSeconds: 900 },
      implement: { maxSteps: 96, toolRounds: 48, timeoutSeconds: 900 },
    });
    assert.deepEqual(status.providerCapabilities, {
      available: true,
      provider: 'fixture',
      model: 'provider',
      contextWindow: 4096,
      vision: true,
      base_url_host: 'fixture.invalid',
      error: null,
    });
    assert.equal(readdirSync(root).some((name) => name.endsWith('.jsonl')), false);
  });

  test('reasonix_exec is fail-closed until a named command policy is enabled', async () => {
    const root = tempRoot();
    writeCliFiles(root);
    commitFixture(root);
    const child = spawn(process.execPath, [SERVER_PATH], { cwd: root, env: envFor(root), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const response = await mcpClient(child).request(1, 'tools/call', { name: 'reasonix_exec', arguments: { command: 'node-test' } });
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /reasonix_exec is disabled/);
    child.stdin.end();
    assert.equal(await new Promise((resolve) => child.once('close', resolve)), 0);
  });

  test('workflow stage mismatch is rejected before spawning a worker', async () => {
    const root = tempRoot();
    writeCliFiles(root);
    const marker = path.join(root, 'spawned');
    writeFileSync(path.join(root, 'subagent'), `
const fs = require('node:fs');
fs.writeFileSync(process.env.MARKER, 'spawned');
`, 'utf8');
    const child = spawn(process.execPath, [SERVER_PATH], { cwd: root, env: envFor(root, { MARKER: marker }), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const client = mcpClient(child);
    try {
      const response = await client.request(1, 'tools/call', { name: 'reasonix_run', arguments: { task: 'invalid stage', mode: 'plan', stage: 'review' } });
      assert.equal(response.result.isError, true);
      assert.match(response.result.content[0].text, /mode=plan only supports stage=plan/);
      assert.equal(existsSync(marker), false);
    } finally {
      child.stdin.end();
      await new Promise((resolve) => child.once('close', resolve));
    }
  });

  test('reasonix_exec runs an allowlisted argv command and detects workspace mutations', async () => {
    const root = tempRoot();
    writeCliFiles(root);
    const script = path.join(root, 'exec-fixture.js');
    const mutation = path.join(root, 'exec-dirty.txt');
    writeFileSync(script, `
const fs = require('node:fs');
if (process.argv.includes('mutate')) fs.writeFileSync(${JSON.stringify(mutation)}, 'dirty');
process.stdout.write('exec-ok TOKEN=secret ' + process.argv.slice(2).join(','));
process.stderr.write(${JSON.stringify(root)});
`, 'utf8');
    writeFileSync(path.join(root, 'bridge.config.json'), JSON.stringify({
      modelRef: 'fixture/provider',
      execPolicy: {
        enabled: true,
        allowedPaths: ['.'],
        commands: [{ name: 'node-fixture', executable: process.execPath, argsPrefix: [script], maxArgs: 2 }],
        timeoutSeconds: 5,
        outputCharCap: 120,
      },
    }), 'utf8');
    commitFixture(root);
    const child = spawn(process.execPath, [SERVER_PATH], { cwd: root, env: envFor(root), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const client = mcpClient(child);
    try {
      const success = await client.request(1, 'tools/call', { name: 'reasonix_exec', arguments: { command: 'node-fixture', stage: 'exec', args: ['hello'] } });
      assert.equal(success.result.isError, false);
      const payload = JSON.parse(success.result.content[0].text);
      assert.equal(payload.schema, 'qlh.reasonix.exec.v1');
      assert.equal(payload.outcome, 'success');
      assert.equal(payload.exitCode, 0);
      assert.equal(payload.cwd, '.');
      assert.match(payload.stdout, /exec-ok/);
      assert.doesNotMatch(payload.stdout, /TOKEN=secret/);
      assert.equal(payload.stderr.includes(root), false);
      const mutationResult = await client.request(2, 'tools/call', { name: 'reasonix_exec', arguments: { command: 'node-fixture', args: ['mutate'] } });
      assert.equal(mutationResult.result.isError, true);
      const mutationPayload = JSON.parse(mutationResult.result.content[0].text);
      assert.equal(mutationPayload.outcome, 'workspace_modified');
      assert.deepEqual(mutationPayload.changedPaths, ['exec-dirty.txt']);
      rmSync(mutation, { force: true });
      const status = JSON.parse((await client.request(3, 'tools/call', { name: 'reasonix_status', arguments: {} })).result.content[0].text);
      assert.equal(status.lastRun.outcome, 'workspace_modified');
      assert.equal(status.lastRun.operation, 'node-fixture');
      assert.equal(status.lastRun.stage, 'exec');
    } finally {
      rmSync(mutation, { force: true });
      child.stdin.end();
      await new Promise((resolve) => child.once('close', resolve));
    }
  });

  test('reasonix_exec bounds cwd, arguments, dirty trees, output, and timeouts', async () => {
    const root = tempRoot();
    writeCliFiles(root);
    const script = path.join(root, 'exec-boundary.js');
    const dirtyTarget = path.join(root, 'dirty-target.txt');
    writeFileSync(dirtyTarget, 'clean\n', 'utf8');
    writeFileSync(script, `
const mode = process.argv[2];
if (mode === 'spam') process.stdout.write('x'.repeat(256));
else if (mode === 'sleep') setTimeout(() => process.stdout.write('late'), 5000);
else process.stdout.write('ok');
`, 'utf8');
    writeFileSync(path.join(root, 'bridge.config.json'), JSON.stringify({
      modelRef: 'fixture/provider',
      execPolicy: {
        enabled: true,
        allowedPaths: ['.'],
        commands: [{ name: 'node-boundary', executable: process.execPath, argsPrefix: [script], maxArgs: 2 }],
        timeoutSeconds: 1,
        outputCharCap: 32,
      },
    }), 'utf8');
    commitFixture(root);
    const child = spawn(process.execPath, [SERVER_PATH], { cwd: root, env: envFor(root), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const client = mcpClient(child);
    try {
      const outside = await client.request(1, 'tools/call', { name: 'reasonix_exec', arguments: { command: 'node-boundary', cwd: '..' } });
      assert.equal(outside.result.isError, true);
      assert.match(outside.result.content[0].text, /outside allowed workspace|outside execPolicy/);
      const tooMany = await client.request(2, 'tools/call', { name: 'reasonix_exec', arguments: { command: 'node-boundary', args: ['a', 'b', 'c'] } });
      assert.equal(tooMany.result.isError, true);
      assert.match(tooMany.result.content[0].text, /exceeds command maxArgs=2/);
      const spam = await client.request(3, 'tools/call', { name: 'reasonix_exec', arguments: { command: 'node-boundary', args: ['spam'] } });
      const spamPayload = JSON.parse(spam.result.content[0].text);
      assert.equal(spam.result.isError, false);
      assert.equal(spamPayload.outcome, 'success');
      assert.equal(spamPayload.truncated, true);
      assert.equal(spamPayload.stdoutChars, 256);
      assert.ok(spamPayload.stdout.length <= 64);
      const timeout = await client.request(4, 'tools/call', { name: 'reasonix_exec', arguments: { command: 'node-boundary', args: ['sleep'], timeout_seconds: 1 } });
      const timeoutPayload = JSON.parse(timeout.result.content[0].text);
      assert.equal(timeout.result.isError, true);
      assert.equal(timeoutPayload.outcome, 'timeout');
      writeFileSync(dirtyTarget, 'dirty\n', 'utf8');
      const dirty = await client.request(5, 'tools/call', { name: 'reasonix_exec', arguments: { command: 'node-boundary', args: ['ok'] } });
      assert.equal(dirty.result.isError, true);
      assert.match(dirty.result.content[0].text, /requires a clean Git workspace/);
    } finally {
      child.stdin.end();
      await new Promise((resolve) => child.once('close', resolve));
    }
  });

  test('reasonix_exec cancellation terminates the process and reclaims its exclusive slot', async () => {
    const root = tempRoot();
    writeCliFiles(root);
    const script = path.join(root, 'exec-cancel.js');
    const startedPath = path.join(root, 'exec-cancel-started');
    writeFileSync(script, `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(startedPath)}, 'started');
setTimeout(() => process.stdout.write('should-not-finish'), 5000);
`, 'utf8');
    writeFileSync(path.join(root, 'bridge.config.json'), JSON.stringify({
      modelRef: 'fixture/provider',
      execPolicy: {
        enabled: true,
        allowedPaths: ['.'],
        commands: [{ name: 'node-cancel', executable: process.execPath, argsPrefix: [script], maxArgs: 1 }],
        timeoutSeconds: 5,
        outputCharCap: 200,
      },
    }), 'utf8');
    commitFixture(root);
    const child = spawn(process.execPath, [SERVER_PATH], { cwd: root, env: envFor(root), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const client = mcpClient(child);
    try {
      const run = client.request(1, 'tools/call', { name: 'reasonix_exec', arguments: { command: 'node-cancel' } });
      const during = await new Promise((resolve, reject) => {
        const deadline = Date.now() + 3000;
        const poll = () => {
          if (existsSync(startedPath)) {
            client.request(2, 'tools/call', { name: 'reasonix_status', arguments: {} }).then(resolve, reject);
          } else if (Date.now() >= deadline) reject(new Error('exec worker did not start'));
          else setTimeout(poll, 10);
        };
        poll();
      });
      const status = JSON.parse(during.result.content[0].text);
      const job = status.jobs.find((entry) => entry.state === 'running' && entry.mode === 'exec');
      assert.ok(job?.jobId);
      const cancelled = await client.request(3, 'tools/call', { name: 'reasonix_cancel', arguments: { job_id: job.jobId } });
      assert.equal(cancelled.result.isError, false);
      assert.match(cancelled.result.content[0].text, /cancellation requested/);
      const result = await run;
      const payload = JSON.parse(result.result.content[0].text);
      assert.equal(result.result.isError, true);
      assert.equal(payload.outcome, 'cancelled');
      const after = await client.request(4, 'tools/call', { name: 'reasonix_status', arguments: {} });
      const afterStatus = JSON.parse(after.result.content[0].text);
      const finished = afterStatus.jobs.find((entry) => entry.jobId === job.jobId);
      assert.equal(finished.state, 'cancelled');
      assert.equal(afterStatus.exclusiveActive, 0);
      assert.equal(afterStatus.inFlight, 0);
    } finally {
      child.stdin.end();
      await new Promise((resolve) => child.once('close', resolve));
    }
  });

  test('explicit ACP transport reuses a session and reports bounded transport status', async () => {
    const root = tempRoot();
    writeCliFiles(root);
    writeAcpCli(root);
    writeFileSync(path.join(root, 'bridge.config.json'), JSON.stringify({ modelRef: 'fixture/provider', transport: 'acp' }), 'utf8');
    const child = spawn(process.execPath, [SERVER_PATH], { cwd: root, env: envFor(root), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const responses = await readMcpSession(child, [
      { id: 1, method: 'tools/call', params: { name: 'reasonix_run', arguments: { task: 'first', mode: 'inspect', session_id: 'demo-session' } } },
      { id: 2, method: 'tools/call', params: { name: 'reasonix_run', arguments: { task: 'second', mode: 'review', session_id: 'demo-session' } } },
      { id: 3, method: 'tools/call', params: { name: 'reasonix_status', arguments: {} } },
    ]);
    child.stdin.end();
    const exit = await new Promise((resolve) => child.once('close', resolve));
    assert.equal(exit, 0);
    assert.equal(responses[0].result.isError, false);
    assert.match(responses[0].result.content[0].text, /transport=acp/);
    assert.equal(responses[1].result.isError, false);
    const status = JSON.parse(responses[2].result.content[0].text);
    assert.equal(status.transport.configured, 'acp');
    assert.equal(status.transport.acp.persistentSessions, 1);
    assert.equal(status.transport.acp.fallbackCount, 0);
  });

  test('ACP startup failure degrades to the existing per-call worker', async () => {
    const root = tempRoot();
    writeCliFiles(root);
    writeAcpCli(root, { failStart: true });
    writeFileSync(path.join(root, 'bridge.config.json'), JSON.stringify({ modelRef: 'fixture/provider', transport: 'acp' }), 'utf8');
    const child = spawn(process.execPath, [SERVER_PATH], { cwd: root, env: envFor(root), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const responses = await readMcpSession(child, [
      { id: 1, method: 'tools/call', params: { name: 'reasonix_run', arguments: { task: 'fallback', mode: 'inspect', session_id: 'broken-session' } } },
      { id: 2, method: 'tools/call', params: { name: 'reasonix_status', arguments: {} } },
    ]);
    child.stdin.end();
    const exit = await new Promise((resolve) => child.once('close', resolve));
    assert.equal(exit, 0);
    assert.equal(responses[0].result.isError, false);
    const status = JSON.parse(responses[1].result.content[0].text);
    assert.equal(status.transport.acp.degraded, true);
    assert.equal(status.transport.acp.fallbackCount, 1);
    assert.equal(status.lastRun.transport, 'per-call');
    assert.equal(status.lastRun.transportFallback, 'acp_process_exit');
  });

  test('ACP-06 offline acceptance drill covers crash resume, bounded history, and cleanup', () => {
    const result = spawnSync(process.execPath, [ACP_ACCEPTANCE_PATH], { cwd: BRIDGE_ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1));
    assert.equal(report.schema, 'qlh.reasonix.acp.acceptance.v1');
    assert.equal(report.status, 'passed');
    assert.equal(report.resume.orphanDetected, true);
    assert.equal(report.resume.resumed, true);
    assert.equal(report.compact.action, 'compact');
    assert.equal(report.compact.rotate, 'rotate');
    assert.equal(report.transport.serialized, true);
    assert.equal(report.transport.cancelled, true);
    assert.equal(report.realClient.childClosed, true);
  });

  test('rejects a task over the reported context window before spawning the worker', async () => {
    const root = tempRoot();
    writeCliFiles(root, { contextWindow: 4 });
    const marker = path.join(root, 'worker-called');
    writeFileSync(path.join(root, 'subagent'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called');`, 'utf8');
    const child = spawn(process.execPath, [SERVER_PATH], {
      cwd: root,
      env: envFor(root),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const responses = await readMcpSession(child, [
      { id: 1, method: 'tools/call', params: { name: 'reasonix_run', arguments: { task: 'x'.repeat(100), mode: 'inspect' } } },
    ]);
    const exit = await new Promise((resolve) => child.once('close', resolve));
    assert.equal(exit, 0);
    assert.equal(responses[0].result.isError, true);
    assert.match(responses[0].result.content[0].text, /estimated \d+ tokens; limit 4 tokens/);
    assert.equal(existsSync(marker), false);
  });

  test('status identifies the explicit write profile without treating it as read-only', async () => {
    const root = tempRoot();
    writeCliFiles(root);
    const child = spawn(process.execPath, [SERVER_PATH], {
      cwd: root,
      env: envFor(root, { REASONIX_SUBAGENT: 'deepseek-worker-write' }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const responses = await readMcpSession(child, [
      { id: 1, method: 'tools/call', params: { name: 'reasonix_status', arguments: {} } },
    ]);
    assert.equal(responses[0].result.isError, false);
    const status = JSON.parse(responses[0].result.content[0].text);
    assert.equal(status.subagent, 'deepseek-worker-write');
    assert.equal(status.subagentRole, 'write');
    assert.equal(status.workerReadOnlyAssumed, false);
  });

  test('write role environment selects the derived write profile', async () => {
    const root = tempRoot();
    writeCliFiles(root);
    const child = spawn(process.execPath, [SERVER_PATH], {
      cwd: root,
      env: envFor(root, { REASONIX_SUBAGENT_ROLE: 'write' }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const responses = await readMcpSession(child, [{ id: 1, method: 'tools/call', params: { name: 'reasonix_status', arguments: {} } }]);
    assert.equal(responses[0].result.isError, false);
    const status = JSON.parse(responses[0].result.content[0].text);
    assert.equal(status.subagent, 'deepseek-worker-write');
    assert.equal(status.subagentRole, 'write');
    assert.equal(status.workerReadOnlyAssumed, false);
  });

  test('write profile is rejected for read-only modes', async () => {
    const root = tempRoot();
    writeCliFiles(root);
    const marker = path.join(root, 'write-marker');
    writeFileSync(path.join(root, 'subagent'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'must not run');`, 'utf8');
    const child = spawn(process.execPath, [SERVER_PATH], {
      cwd: root,
      env: envFor(root, { REASONIX_SUBAGENT: 'deepseek-worker-write' }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const responses = await readMcpSession(child, [{ id: 1, method: 'tools/call', params: { name: 'reasonix_run', arguments: { task: 'review only', mode: 'review' } } }]);
    const exit = await new Promise((resolve) => child.once('close', resolve));
    assert.equal(exit, 0);
    assert.equal(responses[0].result.isError, true);
    assert.match(responses[0].result.content[0].text, /requires a read-role/);
    assert.equal(existsSync(marker), false);
  });

  test('implement requires an explicit write-role subagent', async () => {
    const root = tempRoot();
    writeCliFiles(root);
    writeFileSync(path.join(root, 'bridge.config.json'), JSON.stringify({ modelRef: 'fixture/provider', allowWrite: true, allowedPaths: ['allowed.txt'] }), 'utf8');
    const marker = path.join(root, 'write-marker');
    writeFileSync(path.join(root, 'subagent'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'must not run');`, 'utf8');
    const child = spawn(process.execPath, [SERVER_PATH], { cwd: root, env: envFor(root), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const responses = await readMcpSession(child, [{ id: 1, method: 'tools/call', params: { name: 'reasonix_run', arguments: { task: 'write', mode: 'implement' } } }]);
    const exit = await new Promise((resolve) => child.once('close', resolve));
    assert.equal(exit, 0);
    assert.equal(responses[0].result.isError, true);
    assert.match(responses[0].result.content[0].text, /requires an explicit write-role/);
    assert.equal(existsSync(marker), false);
  });

  test('explicit read role cannot downgrade the canonical write profile', () => {
    const previous = process.env.REASONIX_SUBAGENT_ROLE;
    process.env.REASONIX_SUBAGENT_ROLE = 'read';
    try {
      assert.throws(() => resolveSubagentRole({ data: {}, path: 'fixture' }, { name: 'deepseek-worker-write' }), /conflicts with selected write profile/);
    } finally {
      if (previous === undefined) delete process.env.REASONIX_SUBAGENT_ROLE;
      else process.env.REASONIX_SUBAGENT_ROLE = previous;
    }
  });

  test('implement stays disabled until the bridge config opts in', async () => {
    const root = tempRoot();
    writeCliFiles(root);
    const child = spawn(process.execPath, [SERVER_PATH], { cwd: root, env: envFor(root), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const responses = await readMcpSession(child, [
      { id: 1, method: 'tools/call', params: { name: 'reasonix_status', arguments: {} } },
      { id: 2, method: 'tools/call', params: { name: 'reasonix_run', arguments: { task: 'must not write', mode: 'implement' } } },
    ]);
    const exit = await new Promise((resolve) => child.once('close', resolve));
    assert.equal(exit, 0);
    const status = JSON.parse(responses[0].result.content[0].text);
    assert.equal(status.writePolicy.allowWrite, false);
    assert.equal(status.writePolicy.enabled, false);
    assert.equal(responses[1].result.isError, true);
    assert.match(responses[1].result.content[0].text, /allowWrite=true/);
  });

  test('implement allows a whitelisted change only after a clean-tree check', async () => {
    const root = tempRoot();
    writeCliFiles(root);
    writeFileSync(path.join(root, 'bridge.config.json'), JSON.stringify({ modelRef: 'fixture/provider', allowWrite: true, allowedPaths: ['allowed.txt'] }), 'utf8');
    writeFileSync(path.join(root, 'allowed.txt'), 'before', 'utf8');
    writeFileSync(path.join(root, 'subagent'), `
const fs = require('node:fs');
fs.writeFileSync(process.env.WRITE_TARGET, 'after');
process.stdout.write('implemented');
`, 'utf8');
    commitFixture(root);
    const child = spawn(process.execPath, [SERVER_PATH], { cwd: root, env: envFor(root, { REASONIX_SUBAGENT: 'deepseek-worker-write', WRITE_TARGET: path.join(root, 'allowed.txt') }), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const client = mcpClient(child);
    const writeResponse = await client.request(1, 'tools/call', { name: 'reasonix_run', arguments: { task: 'write allowed file', mode: 'implement' } });
    const changeSet = JSON.parse(writeResponse.result.content[0].text);
    assert.equal(writeResponse.result.isError, false);
    assert.equal(changeSet.schema, 'qlh.reasonix.changes.v1');
    assert.match(changeSet.rollback_id, /^[0-9a-f-]{36}$/);
    assert.equal(changeSet.changes.length, 1);
    assert.equal(changeSet.changes[0].path, 'allowed.txt');
    assert.equal(changeSet.changes[0].hash_status, 'readable');
    assert.match(changeSet.changes[0].sha256, /^[0-9a-f]{64}$/);
    assert.equal(changeSet.changes[0].additions, 1);
    assert.equal(changeSet.changes[0].deletions, 1);
    assert.doesNotMatch(writeResponse.result.content[0].text, /implemented|after/);
    const rollbackResponse = await client.request(2, 'tools/call', { name: 'reasonix_rollback', arguments: { rollback_id: changeSet.rollback_id } });
    const rollbackSet = JSON.parse(rollbackResponse.result.content[0].text);
    assert.equal(rollbackResponse.result.isError, false);
    assert.equal(rollbackSet.status, 'rolled_back');
    child.stdin.end();
    const exit = await new Promise((resolve) => child.once('close', resolve));
    assert.equal(exit, 0);
    assert.equal(readFileSync(path.join(root, 'allowed.txt'), 'utf8'), 'before');
    const status = spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    assert.equal(status.stdout.trim(), '');
  });

  test('implement preserves step-limit diagnostics in the redacted run log', async () => {
    const root = tempRoot();
    writeCliFiles(root);
    writeFileSync(path.join(root, 'bridge.config.json'), JSON.stringify({ modelRef: 'fixture/provider', allowWrite: true, allowedPaths: ['allowed.txt'] }), 'utf8');
    writeFileSync(path.join(root, 'allowed.txt'), 'before', 'utf8');
    writeFileSync(path.join(root, 'subagent'), `
process.stderr.write('sub-agent: paused after 5 tool-call rounds (max_steps) — work saved');
process.exit(1);
`, 'utf8');
    commitFixture(root);
    const logPath = path.join(root, 'calls.jsonl');
    const child = spawn(process.execPath, [SERVER_PATH], {
      cwd: root,
      env: envFor(root, { BRIDGE_LOG: logPath, REASONIX_SUBAGENT: 'deepseek-worker-write' }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const response = await mcpClient(child).request(1, 'tools/call', { name: 'reasonix_run', arguments: { task: 'step-limit write', mode: 'implement', max_steps: 10, timeout_seconds: 120 } });
    child.stdin.end();
    const exit = await new Promise((resolve) => child.once('close', resolve));
    assert.equal(exit, 0);
    assert.equal(response.result.isError, true);
    const changeSet = JSON.parse(response.result.content[0].text);
    assert.equal(changeSet.outcome, 'step_limit');
    const record = JSON.parse(readFileSync(logPath, 'utf8').trim());
    assert.equal(record.outcome, 'step_limit');
    assert.equal(record.stepLimitRounds, 5);
  });

  test('implement refuses a dirty tree under cleanTreePolicy=strict', async () => {
    const root = tempRoot();
    writeCliFiles(root);
    writeFileSync(path.join(root, 'bridge.config.json'), JSON.stringify({ modelRef: 'fixture/provider', allowWrite: true, allowedPaths: ['allowed.txt'], cleanTreePolicy: 'strict' }), 'utf8');
    writeFileSync(path.join(root, 'allowed.txt'), 'before', 'utf8');
    const marker = path.join(root, 'worker-called');
    writeFileSync(path.join(root, 'subagent'), `
const fs = require('node:fs');
fs.writeFileSync(process.env.WORKER_MARKER, 'called');
`, 'utf8');
    commitFixture(root);
    writeFileSync(path.join(root, 'unrelated.txt'), 'dirty', 'utf8');
    const child = spawn(process.execPath, [SERVER_PATH], { cwd: root, env: envFor(root, { REASONIX_SUBAGENT: 'deepseek-worker-write', WORKER_MARKER: marker }), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const responses = await readMcpSession(child, [{ id: 1, method: 'tools/call', params: { name: 'reasonix_run', arguments: { task: 'must wait for clean tree', mode: 'implement' } } }]);
    const exit = await new Promise((resolve) => child.once('close', resolve));
    assert.equal(exit, 0);
    assert.equal(responses[0].result.isError, true);
    assert.match(responses[0].result.content[0].text, /clean Git workspace/);
    assert.equal(existsSync(marker), false);
  });

  test('requireCleanTree=false maps to the snapshot policy, writes through a dirty tree, and rollback restores the user edit', async () => {
    const root = tempRoot();
    writeCliFiles(root);
    writeFileSync(path.join(root, 'bridge.config.json'), JSON.stringify({ modelRef: 'fixture/provider', allowWrite: true, allowedPaths: ['allowed.txt'], requireCleanTree: false }), 'utf8');
    writeFileSync(path.join(root, 'allowed.txt'), 'before', 'utf8');
    const artifactRoot = testArtifactRoot();
    const marker = path.join(artifactRoot, `worker-called-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
    tempArtifacts.add(marker);
    writeFileSync(path.join(root, 'subagent'), `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(marker)}, 'called');
fs.writeFileSync(process.env.WRITE_TARGET, 'after');
`, 'utf8');
    commitFixture(root);
    writeFileSync(path.join(root, 'allowed.txt'), 'user edit before worker', 'utf8');
    const child = spawn(process.execPath, [SERVER_PATH], { cwd: root, env: envFor(root, { REASONIX_SUBAGENT: 'deepseek-worker-write', WRITE_TARGET: path.join(root, 'allowed.txt') }), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const client = mcpClient(child);
    const writeResponse = await client.request(1, 'tools/call', { name: 'reasonix_run', arguments: { task: 'snapshot policy write', mode: 'implement' } });
    assert.equal(writeResponse.result.isError, false, writeResponse.result.content[0].text);
    assert.equal(existsSync(marker), true);
    assert.equal(readFileSync(path.join(root, 'allowed.txt'), 'utf8'), 'after');
    const changeSet = JSON.parse(writeResponse.result.content[0].text);
    const rollbackResponse = await client.request(2, 'tools/call', { name: 'reasonix_rollback', arguments: { rollback_id: changeSet.rollback_id } });
    assert.equal(rollbackResponse.result.isError, false, rollbackResponse.result.content[0].text);
    // The write baseline restores the user's uncommitted content, not HEAD.
    assert.equal(readFileSync(path.join(root, 'allowed.txt'), 'utf8'), 'user edit before worker');
    child.stdin.end();
    await new Promise((resolve) => child.once('close', resolve));
  });

  test('snapshot policy allows a second implement call on an already dirty tree', async () => {
    const root = tempRoot();
    writeCliFiles(root);
    writeFileSync(path.join(root, 'bridge.config.json'), JSON.stringify({ modelRef: 'fixture/provider', allowWrite: true, allowedPaths: ['first.txt', 'second.txt'] }), 'utf8');
    writeFileSync(path.join(root, 'first.txt'), 'base-1', 'utf8');
    writeFileSync(path.join(root, 'second.txt'), 'base-2', 'utf8');
    writeFileSync(path.join(root, 'subagent'), `
const fs = require('node:fs');
fs.writeFileSync(process.env.WRITE_TARGET, 'written by worker');
`, 'utf8');
    commitFixture(root);
    const child = spawn(process.execPath, [SERVER_PATH], { cwd: root, env: envFor(root, { REASONIX_SUBAGENT: 'deepseek-worker-write', WRITE_TARGET: path.join(root, 'first.txt') }), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const client = mcpClient(child);
    const first = await client.request(1, 'tools/call', { name: 'reasonix_run', arguments: { task: 'first write', mode: 'implement' } });
    assert.equal(first.result.isError, false);
    const second = await client.request(2, 'tools/call', { name: 'reasonix_run', arguments: { task: 'second write', mode: 'implement' } });
    assert.equal(second.result.isError, false);
    child.stdin.end();
    await new Promise((resolve) => child.once('close', resolve));
  });

  test('status reports the clean-tree policy and its source', async () => {
    const root = tempRoot();
    writeCliFiles(root);
    writeFileSync(path.join(root, 'bridge.config.json'), JSON.stringify({ modelRef: 'fixture/provider', allowWrite: true, allowedPaths: ['allowed.txt'] }), 'utf8');
    const child = spawn(process.execPath, [SERVER_PATH], { cwd: root, env: envFor(root, { REASONIX_SUBAGENT: 'deepseek-worker-write' }), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const responses = await readMcpSession(child, [{ id: 1, method: 'tools/call', params: { name: 'reasonix_status', arguments: {} } }]);
    const status = JSON.parse(responses[0].result.content[0].text);
    assert.equal(status.writePolicy.cleanTreePolicy, 'snapshot');
    assert.equal(status.writePolicy.cleanTreePolicySource, 'default');
    await new Promise((resolve) => child.once('close', resolve));
  });

  test('rollback refuses to overwrite a later manual edit', async () => {
    const root = tempRoot();
    writeCliFiles(root);
    writeFileSync(path.join(root, 'bridge.config.json'), JSON.stringify({ modelRef: 'fixture/provider', allowWrite: true, allowedPaths: ['allowed.txt'] }), 'utf8');
    writeFileSync(path.join(root, 'allowed.txt'), 'before', 'utf8');
    writeFileSync(path.join(root, 'subagent'), `
const fs = require('node:fs');
fs.writeFileSync(process.env.WRITE_TARGET, 'after');
`, 'utf8');
    commitFixture(root);
    const child = spawn(process.execPath, [SERVER_PATH], { cwd: root, env: envFor(root, { REASONIX_SUBAGENT: 'deepseek-worker-write', WRITE_TARGET: path.join(root, 'allowed.txt') }), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const client = mcpClient(child);
    const writeResponse = await client.request(1, 'tools/call', { name: 'reasonix_run', arguments: { task: 'write once', mode: 'implement' } });
    const changeSet = JSON.parse(writeResponse.result.content[0].text);
    writeFileSync(path.join(root, 'allowed.txt'), 'manual edit after worker', 'utf8');
    const rollbackResponse = await client.request(2, 'tools/call', { name: 'reasonix_rollback', arguments: { rollback_id: changeSet.rollback_id } });
    assert.equal(rollbackResponse.result.isError, true);
    assert.match(rollbackResponse.result.content[0].text, /changed after the implement call/);
    assert.equal(readFileSync(path.join(root, 'allowed.txt'), 'utf8'), 'manual edit after worker');
    child.stdin.end();
    await new Promise((resolve) => child.once('close', resolve));
  });

  test('rollback is serialized behind an in-flight implement in the same workspace', async () => {
    const root = tempRoot();
    writeCliFiles(root);
    writeFileSync(path.join(root, 'bridge.config.json'), JSON.stringify({ modelRef: 'fixture/provider', allowWrite: true, allowedPaths: ['first.txt', 'second.txt'] }), 'utf8');
    const artifactRoot = testArtifactRoot();
    const callCount = path.join(artifactRoot, `call-count-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
    const secondStarted = path.join(artifactRoot, `second-started-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
    tempArtifacts.add(callCount);
    tempArtifacts.add(secondStarted);
    writeFileSync(path.join(root, 'subagent'), `
const fs = require('node:fs');
const path = require('node:path');
const count = fs.existsSync(process.env.CALL_COUNT) ? Number(fs.readFileSync(process.env.CALL_COUNT, 'utf8')) : 0;
fs.writeFileSync(process.env.CALL_COUNT, String(count + 1));
if (count === 0) {
  fs.writeFileSync(path.join(process.env.WORKSPACE, 'first.txt'), 'first');
  process.stdout.write('first');
} else {
  fs.writeFileSync(process.env.SECOND_STARTED, 'started');
  setTimeout(() => {
    fs.writeFileSync(path.join(process.env.WORKSPACE, 'first.txt'), 'second');
    fs.writeFileSync(path.join(process.env.WORKSPACE, 'second.txt'), 'second');
    process.stdout.write('second');
  }, 250);
}
`, 'utf8');
    commitFixture(root);
    const child = spawn(process.execPath, [SERVER_PATH], {
      cwd: root,
      env: envFor(root, { REASONIX_SUBAGENT: 'deepseek-worker-write', CALL_COUNT: callCount, SECOND_STARTED: secondStarted, WORKSPACE: root }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const client = mcpClient(child);
    try {
      const firstResponse = await client.request(1, 'tools/call', { name: 'reasonix_run', arguments: { task: 'first write', mode: 'implement' } });
      const firstSet = JSON.parse(firstResponse.result.content[0].text);
      assert.equal(firstResponse.result.isError, false);
      assert.equal(firstSet.changes[0].path, 'first.txt');
      const commit = spawnSync('git', ['-C', root, 'add', 'first.txt'], { encoding: 'utf8', windowsHide: true });
      assert.equal(commit.status, 0, commit.stderr);
      const saved = spawnSync('git', ['-C', root, 'commit', '-qm', 'save first implement'], { encoding: 'utf8', windowsHide: true });
      assert.equal(saved.status, 0, saved.stderr);

      const secondPromise = client.request(2, 'tools/call', { name: 'reasonix_run', arguments: { task: 'second write', mode: 'implement' } });
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 3000;
        const poll = () => {
          if (existsSync(secondStarted)) resolve();
          else if (Date.now() >= deadline) reject(new Error('second implement did not start'));
          else setTimeout(poll, 10);
        };
        poll();
      });
      const rollbackPromise = client.request(3, 'tools/call', { name: 'reasonix_rollback', arguments: { rollback_id: firstSet.rollback_id } });
      const [secondResponse, rollbackResponse] = await Promise.all([secondPromise, rollbackPromise]);
      assert.equal(secondResponse.result.isError, false);
      assert.equal(rollbackResponse.result.isError, true);
      assert.match(rollbackResponse.result.content[0].text, /changed after the implement call/);
      assert.equal(readFileSync(path.join(root, 'first.txt'), 'utf8'), 'second');
      assert.equal(readFileSync(path.join(root, 'second.txt'), 'utf8'), 'second');
    } finally {
      child.stdin.end();
      await new Promise((resolve) => child.once('close', resolve));
      rmSync(callCount, { force: true });
      rmSync(secondStarted, { force: true });
    }
  });

  test('rollback refuses a non-regular target instead of treating it as missing', async () => {
    const root = tempRoot();
    writeCliFiles(root);
    writeFileSync(path.join(root, 'bridge.config.json'), JSON.stringify({ modelRef: 'fixture/provider', allowWrite: true, allowedPaths: ['non-file'] }), 'utf8');
    writeFileSync(path.join(root, 'subagent'), `
const fs = require('node:fs');
fs.writeFileSync(process.env.WRITE_TARGET, 'regular file');
process.stdout.write('implemented');
`, 'utf8');
    commitFixture(root);
    const target = path.join(root, 'non-file');
    const child = spawn(process.execPath, [SERVER_PATH], { cwd: root, env: envFor(root, { REASONIX_SUBAGENT: 'deepseek-worker-write', WRITE_TARGET: target }), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const client = mcpClient(child);
    try {
      const writeResponse = await client.request(1, 'tools/call', { name: 'reasonix_run', arguments: { task: 'create non-regular target', mode: 'implement' } });
      const changeSet = JSON.parse(writeResponse.result.content[0].text);
      assert.equal(writeResponse.result.isError, false);
      assert.equal(changeSet.changes.length, 1);
      assert.equal(changeSet.changes[0].hash_status, 'readable');
      rmSync(target, { force: true });
      mkdirSync(target);
      const rollbackResponse = await client.request(2, 'tools/call', { name: 'reasonix_rollback', arguments: { rollback_id: changeSet.rollback_id } });
      assert.equal(rollbackResponse.result.isError, true);
      assert.match(rollbackResponse.result.content[0].text, /files are unreadable/);
      assert.equal(existsSync(target), true);
      rmSync(target, { recursive: true, force: true });
      const missingResponse = await client.request(3, 'tools/call', { name: 'reasonix_rollback', arguments: { rollback_id: changeSet.rollback_id } });
      assert.equal(missingResponse.result.isError, true);
      assert.match(missingResponse.result.content[0].text, /files are missing/);
    } finally {
      child.stdin.end();
      await new Promise((resolve) => child.once('close', resolve));
    }
  });

  test('rollback restores a staged rename without treating its destination as modified', async () => {
    const root = tempRoot();
    writeCliFiles(root);
    writeFileSync(path.join(root, 'bridge.config.json'), JSON.stringify({ modelRef: 'fixture/provider', allowWrite: true, allowedPaths: ['source.txt', 'renamed.txt'] }), 'utf8');
    writeFileSync(path.join(root, 'source.txt'), 'rename me', 'utf8');
    writeFileSync(path.join(root, 'subagent'), `
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = process.env.WORKSPACE;
const rename = spawnSync('git', ['-C', root, 'mv', 'source.txt', 'renamed.txt'], { encoding: 'utf8' });
if (rename.status !== 0) { process.stderr.write(rename.stderr || 'git mv failed'); process.exit(rename.status || 1); }
process.stdout.write('renamed');
`, 'utf8');
    commitFixture(root);
    const child = spawn(process.execPath, [SERVER_PATH], {
      cwd: root,
      env: envFor(root, { REASONIX_SUBAGENT: 'deepseek-worker-write', WORKSPACE: root }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const client = mcpClient(child);
    try {
      const writeResponse = await client.request(1, 'tools/call', { name: 'reasonix_run', arguments: { task: 'rename source.txt to renamed.txt', mode: 'implement' } });
      const changeSet = JSON.parse(writeResponse.result.content[0].text);
      assert.equal(writeResponse.result.isError, false);
      assert.deepEqual(changeSet.changes.map((change) => [change.path, change.kind]), [['renamed.txt', 'added'], ['source.txt', 'deleted']]);
      const rollbackResponse = await client.request(2, 'tools/call', { name: 'reasonix_rollback', arguments: { rollback_id: changeSet.rollback_id } });
      assert.equal(rollbackResponse.result.isError, false, rollbackResponse.result.content[0].text);
      assert.equal(readFileSync(path.join(root, 'source.txt'), 'utf8'), 'rename me');
      assert.equal(existsSync(path.join(root, 'renamed.txt')), false);
    } finally {
      child.stdin.end();
      await new Promise((resolve) => child.once('close', resolve));
    }
  });

  test('implement rolls back a change outside the whitelist', async () => {
    const root = tempRoot();
    writeCliFiles(root);
    writeFileSync(path.join(root, 'bridge.config.json'), JSON.stringify({ modelRef: 'fixture/provider', allowWrite: true, allowedPaths: ['allowed.txt'] }), 'utf8');
    writeFileSync(path.join(root, 'subagent'), `
const fs = require('node:fs');
fs.writeFileSync(process.env.WRITE_TARGET, 'must be removed');
process.stdout.write('implemented');
`, 'utf8');
    commitFixture(root);
    const target = path.join(root, 'outside.txt');
    const child = spawn(process.execPath, [SERVER_PATH], { cwd: root, env: envFor(root, { REASONIX_SUBAGENT: 'deepseek-worker-write', WRITE_TARGET: target }), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const responses = await readMcpSession(child, [{ id: 1, method: 'tools/call', params: { name: 'reasonix_run', arguments: { task: 'write outside file', mode: 'implement' } } }]);
    const exit = await new Promise((resolve) => child.once('close', resolve));
    assert.equal(exit, 0);
    assert.equal(responses[0].result.isError, true);
    assert.match(responses[0].result.content[0].text, /outside allowedPaths/);
    assert.equal(existsSync(target), false);
    const status = spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    assert.equal(status.stdout.trim(), '');
  });
});

describe('ACP client transport', () => {
  test('performs handshake, session lifecycle, update aggregation, and safe permission rejection', async () => {
    const fixture = acpFixtureSpawn();
    const updates = [];
    const client = new AcpClient({
      cliPath: 'reasonix-fixture',
      modelRef: 'fixture/provider',
      cwd: 'C:/fixture',
      timeoutMs: 100,
      spawnImpl: fixture.spawnImpl,
      onUpdate: (update) => updates.push(update),
    });
    await client.start();
    assert.equal(client.supportsSession('resume'), true);
    const created = await client.newSession();
    assert.equal(created.sessionId, 'fixture-session-1');
    const loaded = await client.loadSession('persisted-session');
    assert.equal(loaded.sessionId, 'persisted-session');
    const resumed = await client.resumeSession('persisted-session');
    assert.equal(resumed.sessionId, 'persisted-session');
    const prompt = await client.prompt(created.sessionId, 'say hello');
    assert.equal(prompt.stopReason, 'end_turn');
    assert.equal(prompt.text, 'fixture-answer');
    assert.equal(collectAcpText(prompt.updates), 'fixture-answer');
    assert.equal(updates.length, 2);
    const permissionResponse = fixture.received.find((message) => message.id === 77);
    assert.deepEqual(permissionResponse.result, { outcome: { outcome: 'cancelled' } });
    assert.deepEqual(fixture.received.find((message) => message.method === 'session/new').params, { cwd: 'C:/fixture', mcpServers: [] });
    await client.deleteSession(created.sessionId);
    assert.ok(fixture.received.some((message) => message.method === 'session/delete' && message.params.sessionId === created.sessionId));
    await client.close({ sessionId: created.sessionId });
    assert.equal(client.child, null);
  });

  test('cancels an ACP prompt after timeout and closes the process', async () => {
    const fixture = acpFixtureSpawn();
    const client = new AcpClient({ cliPath: 'reasonix-fixture', modelRef: 'fixture/provider', cwd: 'C:/fixture', timeoutMs: 25, spawnImpl: fixture.spawnImpl });
    await client.start();
    const session = await client.newSession();
    await assert.rejects(() => client.prompt(session.sessionId, 'hang', { timeoutMs: 10 }), (error) => error.code === 'timeout');
    assert.ok(fixture.received.some((message) => message.method === 'session/cancel'));
    await client.close({ sessionId: session.sessionId });
    assert.equal(client.child, null);
  });
});

function coordinatorFixture({ failReplacementPrompt = false, failOldClose = false } = {}) {
  const events = [];
  let nextSession = 1;
  const client = {
    started: false,
    async start() { this.started = true; events.push(['start']); },
    async newSession() {
      const sessionId = `coordinator-session-${nextSession++}`;
      events.push(['new', sessionId]);
      return { sessionId };
    },
    async prompt(sessionId, text) {
      events.push(['prompt', sessionId, text]);
      if (failReplacementPrompt && sessionId !== 'coordinator-session-1') throw Object.assign(new Error('replacement failed'), { code: 'replacement_failed' });
      return { stopReason: 'end_turn', text: `reply:${text.slice(0, 24)}` };
    },
    async closeSession(sessionId) { events.push(['close', sessionId]); if (failOldClose && sessionId === 'coordinator-session-1') throw Object.assign(new Error('old close raced'), { code: 'close_race' }); return {}; },
    async deleteSession(sessionId) { events.push(['delete', sessionId]); return {}; },
    supportsSession(name) { return name === 'delete'; },
  };
  return { client, events };
}

describe('ACP session budget coordinator', () => {
  test('uses deterministic bounded summaries and records append decisions without bodies', async () => {
    const { client } = coordinatorFixture();
    const decisions = [];
    const coordinator = new AcpSessionCoordinator({ client, onDecision: (entry) => decisions.push(entry), now: (() => { let tick = 100; return () => tick += 7; })() });
    await coordinator.start();
    const result = await coordinator.prompt('first request');
    assert.equal(result.transport, 'acp');
    assert.equal(result.action, 'append');
    assert.equal(coordinator.currentHistory.length, 2);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].action, 'append');
    assert.equal(Object.hasOwn(decisions[0], 'text'), false);
    assert.equal(Object.hasOwn(decisions[0], 'content'), false);
    assert.equal(summarizeAcpMessages([{ role: 'user', content: '  alpha\n beta  ' }]), '1. user: alpha beta');
    assert.ok(summarizeAcpMessages([{ role: 'user', content: 'x'.repeat(100) }], { perMessageCap: 10, maxChars: 10 }).length <= 10);
  });

  test('compacts through a replacement session and deletes the old session only after success', async () => {
    const { client, events } = coordinatorFixture();
    const coordinator = new AcpSessionCoordinator({
      client,
      hardCapBytes: 400,
      compactTriggerRatio: 0.25,
      preserveRecent: 1,
      summarize: (messages) => messages.map((message) => message.content).join(' | '),
    });
    await coordinator.start();
    coordinator.history = [
      { role: 'user', content: 'old question '.repeat(3) },
      { role: 'assistant', content: 'old answer '.repeat(3) },
      { role: 'user', content: 'recent question' },
    ];
    const result = await coordinator.prompt('next request');
    assert.equal(result.action, 'compact');
    assert.equal(result.sessionId, 'coordinator-session-2');
    assert.deepEqual(events.map((event) => event[0]), ['start', 'new', 'new', 'prompt', 'close', 'delete']);
    assert.equal(events[4][1], 'coordinator-session-1');
    assert.equal(events[5][1], 'coordinator-session-1');
    assert.ok(coordinator.currentHistory.some((message) => message.acpCompacted));
    assert.equal(coordinator.decisions[0].action, 'compact');
    assert.ok(coordinator.decisions[0].resultBytes < coordinator.hardCapBytes);
  });

  test('rotates when a valid compacted history still exceeds the hard cap', async () => {
    const { client, events } = coordinatorFixture();
    const next = { role: 'user', content: 'next' };
    const coordinator = new AcpSessionCoordinator({
      client,
      hardCapBytes: historyBytes([next, { role: 'assistant', content: 'reply:next' }]) + 1,
      compactTriggerRatio: 0.25,
      preserveRecent: 1,
      summarize: () => 'oversized summary '.repeat(40),
    });
    await coordinator.start();
    coordinator.history = [{ role: 'user', content: 'old question' }, { role: 'assistant', content: 'old answer' }];
    const result = await coordinator.prompt(next.content);
    assert.equal(result.action, 'rotate');
    assert.equal(result.sessionId, 'coordinator-session-2');
    assert.equal(events.filter((event) => event[0] === 'new').length, 2);
    assert.equal(coordinator.currentHistory.at(0).content, next.content);
    assert.ok(coordinator.decisions[0].resultBytes < coordinator.hardCapBytes);
  });

  test('falls back per-call when summarization fails and leaves persistent history unchanged', async () => {
    const { client, events } = coordinatorFixture();
    let fallbackCalls = 0;
    const coordinator = new AcpSessionCoordinator({
      client,
      hardCapBytes: 100,
      compactTriggerRatio: 0.25,
      summarize: () => { throw new Error('summary unavailable'); },
      fallbackPrompt: async (text, context) => { fallbackCalls += 1; assert.equal(text, 'next'); assert.equal(Object.hasOwn(context, 'history'), false); return { text: 'fallback-answer' }; },
    });
    await coordinator.start();
    coordinator.history = [{ role: 'user', content: 'old question' }, { role: 'assistant', content: 'old answer' }];
    const before = JSON.stringify(coordinator.currentHistory);
    const result = await coordinator.prompt('next');
    assert.equal(result.transport, 'per_call');
    assert.equal(result.action, 'per_call');
    assert.equal(fallbackCalls, 1);
    assert.equal(events.filter((event) => event[0] === 'prompt').length, 0);
    assert.equal(JSON.stringify(coordinator.currentHistory), before);
    assert.equal(coordinator.decisions[0].reason, 'compact_failed');
    assert.equal(coordinator.decisions[0].fallbackUsed, true);
  });

  test('falls back when replacement prompt fails and keeps the old session active', async () => {
    const { client, events } = coordinatorFixture({ failReplacementPrompt: true });
    let fallbackCalls = 0;
    const coordinator = new AcpSessionCoordinator({
      client,
      hardCapBytes: 220,
      compactTriggerRatio: 0.25,
      preserveRecent: 1,
      summarize: () => 'small summary',
      fallbackPrompt: async () => { fallbackCalls += 1; return { text: 'fallback-answer' }; },
    });
    await coordinator.start();
    coordinator.history = [{ role: 'user', content: 'old question '.repeat(3) }, { role: 'assistant', content: 'old answer '.repeat(3) }, { role: 'user', content: 'recent' }];
    const before = JSON.stringify(coordinator.currentHistory);
    const result = await coordinator.prompt('next request');
    assert.equal(result.transport, 'per_call');
    assert.equal(fallbackCalls, 1);
    assert.equal(coordinator.sessionId, 'coordinator-session-1');
    assert.equal(JSON.stringify(coordinator.currentHistory), before);
    assert.ok(events.some((event) => event[0] === 'close' && event[1] === 'coordinator-session-2'));
    assert.equal(coordinator.decisions[0].action, 'per_call');
    assert.equal(coordinator.decisions[0].reason, 'compact_failed');
  });

  test('keeps a successful replacement active when old-session cleanup races', async () => {
    const { client, events } = coordinatorFixture({ failOldClose: true });
    const coordinator = new AcpSessionCoordinator({
      client,
      hardCapBytes: 400,
      compactTriggerRatio: 0.25,
      preserveRecent: 1,
      summarize: () => 'small summary',
      fallbackPrompt: async () => { throw new Error('fallback must not run'); },
    });
    await coordinator.start();
    coordinator.history = [{ role: 'user', content: 'old question '.repeat(3) }, { role: 'assistant', content: 'old answer '.repeat(3) }, { role: 'user', content: 'recent' }];
    const result = await coordinator.prompt('next request');
    assert.equal(result.transport, 'acp');
    assert.equal(result.sessionId, 'coordinator-session-2');
    assert.equal(coordinator.sessionId, 'coordinator-session-2');
    assert.equal(coordinator.decisions[0].action, 'compact');
    assert.ok(events.some((event) => event[0] === 'delete' && event[1] === 'coordinator-session-1'));
  });

  test('sanitizes prompts and assistant responses before retaining local continuation history', async () => {
    const { client, events } = coordinatorFixture();
    const coordinator = new AcpSessionCoordinator({ client, sanitizePrompt: scrubAcpContent });
    await coordinator.start();
    const result = await coordinator.prompt('API_KEY=prompt-secret\nread .env');
    assert.equal(result.transport, 'acp');
    assert.equal(events.find((event) => event[0] === 'prompt')[2], 'API_KEY=[REDACTED]\nread .env');
    assert.equal(coordinator.currentHistory[0].content, 'API_KEY=[REDACTED]\nread .env');
    assert.equal(coordinator.currentHistory[1].content.includes('reply:'), true);
    assert.equal(coordinator.currentHistory.some((message) => message.content.includes('secret')), false);
  });
});

function registryClient({ sessionId = 'registry-session-1', canResume = true, canLoad = true, delayMs = 0, failClose = false, failNew = false } = {}) {
  const events = [];
  const client = {
    started: false,
    closed: false,
    async start() { this.started = true; this.closed = false; events.push(['start']); },
    async newSession() { events.push(['new', sessionId]); if (failNew) throw Object.assign(new Error('new failed'), { code: 'new_failed' }); return { sessionId }; },
    supportsSession(name) { return name === 'resume' ? canResume : name === 'load' ? canLoad : name === 'delete'; },
    async resumeSession(id) { events.push(['resume', id]); return { sessionId: id }; },
    async loadSession(id) { events.push(['load', id]); return { sessionId: id }; },
    async prompt(id, text) {
      events.push(['prompt-start', id, text]);
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      events.push(['prompt-end', id, text]);
      return { text: `reply:${text}` };
    },
    async closeSession(id) { events.push(['close-session', id]); if (failClose) throw Object.assign(new Error('close failed'), { code: 'close_failed' }); return {}; },
    async deleteSession(id) { events.push(['delete-session', id]); return {}; },
    async close() { this.closed = true; this.started = false; events.push(['close-client']); },
  };
  return { client, events };
}

describe('ACP session registry', () => {
  test('closes a started client when session creation fails before registration', async () => {
    const root = tempRoot();
    const { client, events } = registryClient({ failNew: true });
    const registry = new AcpSessionRegistry({ statePath: path.join(root, 'registry.json') });
    await assert.rejects(() => registry.create({ client, cwd: root, profile: 'read', model: 'fixture/provider' }), (error) => error.code === 'new_failed');
    assert.equal(client.closed, true);
    assert.deepEqual(events.map((event) => event[0]), ['start', 'new', 'close-client']);
    assert.equal(registry.size, 0);
  });

  test('uses the project build test root and persists metadata without task bodies', async () => {
    const root = tempRoot();
    assert.equal(path.dirname(root), PROJECT_TEST_ROOT);
    const statePath = path.join(root, 'registry.json');
    const { client } = registryClient();
    const registry = new AcpSessionRegistry({ statePath, now: (() => { let tick = 100; return () => tick += 10; })() });
    const entry = await registry.create({ client, cwd: root, profile: 'deepseek-worker', model: 'fixture/provider' });
    assert.equal(entry.sessionId, 'registry-session-1');
    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(saved.schema, ACP_REGISTRY_SCHEMA);
    assert.equal(saved.sessions[0].cwd, root);
    assert.equal(Object.hasOwn(saved.sessions[0], 'task'), false);
    assert.equal(Object.hasOwn(saved.sessions[0], 'history'), false);
  });

  test('serializes concurrent prompts per session and updates last-used metadata', async () => {
    const root = tempRoot();
    const { client, events } = registryClient({ delayMs: 10 });
    const registry = new AcpSessionRegistry({ statePath: path.join(root, 'registry.json') });
    await registry.create({ client, cwd: root, profile: 'read', model: 'fixture/provider' });
    const results = await Promise.all([registry.prompt('registry-session-1', 'one'), registry.prompt('registry-session-1', 'two')]);
    assert.deepEqual(results.map((result) => result.text), ['reply:one', 'reply:two']);
    assert.deepEqual(events.filter((event) => event[0].startsWith('prompt')).map((event) => event[0] + ':' + event[2]), [
      'prompt-start:one', 'prompt-end:one', 'prompt-start:two', 'prompt-end:two',
    ]);
    assert.ok(registry.list()[0].lastUsedAt > registry.list()[0].createdAt);
  });

  test('loads persisted sessions as orphaned and resumes with resume, then load fallback', async () => {
    const root = tempRoot();
    const statePath = path.join(root, 'registry.json');
    const first = new AcpSessionRegistry({ statePath });
    const original = registryClient({ sessionId: 'persisted-session' });
    await first.create({ client: original.client, cwd: root, profile: 'read', model: 'fixture/provider' });
    const restarted = new AcpSessionRegistry({ statePath });
    assert.equal(restarted.list()[0].state, 'orphaned');
    const resumed = registryClient({ sessionId: 'persisted-session', canResume: true, canLoad: false });
    await restarted.resume('persisted-session', { clientFactory: async () => resumed.client });
    assert.ok(resumed.events.some((event) => event[0] === 'resume'));
    assert.equal(restarted.list()[0].state, 'active');
    resumed.client.started = false;
    resumed.client.closed = true;
    const loaded = registryClient({ sessionId: 'persisted-session', canResume: false, canLoad: true });
    await restarted.resume('persisted-session', { clientFactory: async () => loaded.client });
    assert.ok(loaded.events.some((event) => event[0] === 'load'));
  });

  test('delete sends ACP delete before closing the client and removes persisted metadata', async () => {
    const root = tempRoot();
    const { client, events } = registryClient();
    const registry = new AcpSessionRegistry({ statePath: path.join(root, 'registry.json') });
    await registry.create({ client, cwd: root, profile: 'read', model: 'fixture/provider' });
    const result = await registry.delete('registry-session-1');
    assert.deepEqual(result, { sessionId: 'registry-session-1', state: 'deleted' });
    assert.deepEqual(events.slice(-3).map((event) => event[0]), ['close-session', 'delete-session', 'close-client']);
    assert.deepEqual(registry.list(), []);
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, 'registry.json'), 'utf8')).sessions, []);
  });

  test('deletes a persisted orphan only after recreating its ACP client', async () => {
    const root = tempRoot();
    const statePath = path.join(root, 'registry.json');
    const first = registryClient({ sessionId: 'orphan-session' });
    const initial = new AcpSessionRegistry({ statePath });
    await initial.create({ client: first.client, cwd: root, profile: 'read', model: 'fixture/provider' });
    const restarted = new AcpSessionRegistry({ statePath });
    const replacement = registryClient({ sessionId: 'orphan-session' });
    await restarted.delete('orphan-session', { clientFactory: async () => replacement.client });
    assert.ok(replacement.events.some((event) => event[0] === 'resume'));
    assert.deepEqual(restarted.list(), []);
  });

  test('does not allow a prompt queued behind delete to run', async () => {
    const root = tempRoot();
    const { client, events } = registryClient({ delayMs: 10 });
    const registry = new AcpSessionRegistry({ statePath: path.join(root, 'registry.json') });
    await registry.create({ client, cwd: root, profile: 'read', model: 'fixture/provider' });
    const firstPrompt = registry.prompt('registry-session-1', 'first');
    const deletion = registry.delete('registry-session-1');
    const queuedPrompt = registry.prompt('registry-session-1', 'after-delete');
    await firstPrompt;
    await deletion;
    await assert.rejects(() => queuedPrompt, (error) => error.code === 'session_not_active');
    const promptEnd = events.findIndex((event) => event[0] === 'prompt-end');
    const close = events.findIndex((event) => event[0] === 'close-session');
    assert.ok(promptEnd >= 0 && close > promptEnd);
  });

  test('marks crashed transports orphaned and shutdown closes every live session', async () => {
    const root = tempRoot();
    const first = registryClient({ sessionId: 'crashed-session' });
    const registry = new AcpSessionRegistry({ statePath: path.join(root, 'registry.json') });
    await registry.create({ client: first.client, cwd: root, profile: 'read', model: 'fixture/provider' });
    first.client.started = false;
    first.client.closed = true;
    assert.equal(registry.list({ includeClosed: false })[0].state, 'orphaned');
    await assert.rejects(() => registry.prompt('crashed-session', 'cannot run'), (error) => error.code === 'session_orphaned');
    const second = registryClient({ sessionId: 'live-session' });
    await registry.register({ client: second.client, sessionId: 'live-session', cwd: root, profile: 'read', model: 'fixture/provider' });
    const result = await registry.shutdown();
    assert.deepEqual(result.closed.sort(), ['crashed-session', 'live-session']);
    assert.equal(registry.list().every((entry) => entry.state === 'closed'), true);
  });

  test('process lifecycle hooks trigger idempotent registry shutdown', async () => {
    const root = tempRoot();
    const { client, events } = registryClient();
    const registry = new AcpSessionRegistry({ statePath: path.join(root, 'registry.json') });
    await registry.create({ client, cwd: root, profile: 'read', model: 'fixture/provider' });
    const processLike = new EventEmitter();
    const uninstall = registry.installProcessHandlers(processLike);
    processLike.emit('SIGTERM');
    processLike.emit('SIGTERM');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(registry.list()[0].state, 'closed');
    assert.equal(events.filter((event) => event[0] === 'close-client').length, 1);
    uninstall();
  });

  test('binds scoped sessions to one opaque owner/task pair and strips scope from ACP options', async () => {
    const root = tempRoot();
    const { client, events } = registryClient();
    const registry = new AcpSessionRegistry({ statePath: path.join(root, 'registry.json'), scopeRequired: true });
    const entry = await registry.create({ client, cwd: root, profile: 'read', model: 'fixture/provider', scope: { owner: 'caller-a', taskId: 'task-1' } });
    assert.deepEqual(entry.scope, { owner: 'caller-a', taskId: 'task-1' });
    await registry.prompt(entry.sessionId, 'allowed', { owner: 'caller-a', taskId: 'task-1', mode: 'inspect' });
    assert.deepEqual(events.find((event) => event[0] === 'prompt-start'), ['prompt-start', entry.sessionId, 'allowed']);
    await assert.rejects(() => registry.prompt(entry.sessionId, 'cross-task', { owner: 'caller-a', taskId: 'task-2' }), (error) => error.code === 'session_scope_mismatch');
    await assert.rejects(() => registry.prompt(entry.sessionId, 'missing-scope'), (error) => error.code === 'session_scope_required');
    const saved = JSON.parse(readFileSync(path.join(root, 'registry.json'), 'utf8'));
    assert.deepEqual(saved.sessions[0].scope, { owner: 'caller-a', taskId: 'task-1' });
    assert.equal(Object.hasOwn(saved.sessions[0], 'history'), false);
  });

  test('rechecks the security policy inside the serialized prompt lane', async () => {
    const root = tempRoot();
    const { client, events } = registryClient();
    const securityPolicy = new AcpSecurityPolicy({
      workspaceRoot: root,
      writePolicy: { allowWrite: true, enabled: true, allowedPaths: ['docs'], errors: [] },
    });
    const registry = new AcpSessionRegistry({ statePath: path.join(root, 'registry.json'), scopeRequired: true, securityPolicy });
    const entry = await registry.create({ client, cwd: root, profile: 'write', model: 'fixture/provider', scope: { owner: 'caller-a', taskId: 'task-1' } });
    await registry.prompt(entry.sessionId, 'write docs', { owner: 'caller-a', taskId: 'task-1', mode: 'implement', role: 'write', requestedPaths: ['docs/report.md'] });
    assert.equal(events.filter((event) => event[0] === 'prompt-start').length, 1);
    await assert.rejects(() => registry.prompt(entry.sessionId, 'write source', { owner: 'caller-a', taskId: 'task-1', mode: 'implement', role: 'write', requestedPaths: ['src/main.mjs'] }), (error) => error.code === 'write_path_denied');
    await assert.rejects(() => registry.prompt(entry.sessionId, 'drift', { owner: 'caller-a', taskId: 'task-1', mode: 'implement', role: 'write', cwd: path.join(root, 'other'), requestedPaths: ['docs/report.md'] }), (error) => error.code === 'session_scope_mismatch');
  });
});

describe('ACP session security policy', () => {
  test('redacts credential-like assignments, bearer tokens, private keys, and sensitive files', () => {
    const content = 'API_KEY=alpha\nAuthorization: Bearer abcdefghijkl\n-----BEGIN PRIVATE KEY-----\\nsecret\\n-----END PRIVATE KEY-----';
    const scrubbed = scrubAcpContent(content);
    assert.equal(scrubbed.includes('alpha'), false);
    assert.equal(scrubbed.includes('abcdefghijkl'), false);
    assert.equal(scrubbed.includes('secret'), false);
    assert.equal(scrubAcpContent('DB_PASSWORD=hunter2', { sourcePath: '.env' }), '[REDACTED sensitive file]');
    assert.equal(scrubAcpContent('NORMAL_VALUE=still-private').includes('still-private'), false);
    assert.equal(scrubAcpContent('{"api_key":"json-secret"}').includes('json-secret'), false);
    assert.deepEqual(scrubAcpMessages([{ role: 'user', content: 'TOKEN=top-secret' }])[0].content, 'TOKEN=[REDACTED]');
  });

  test('enforces workspace/session scope and the existing write whitelist', () => {
    const root = tempRoot();
    const policy = new AcpSecurityPolicy({
      workspaceRoot: root,
      writePolicy: { allowWrite: true, enabled: true, allowedPaths: ['docs'], errors: [] },
    });
    const session = { sessionId: 'secure-session', cwd: root, profile: 'deepseek-worker-write', model: 'fixture/provider', owner: 'caller-a', taskId: 'task-1' };
    const authorized = policy.authorizeCall(session, { mode: 'implement', role: 'write', owner: 'caller-a', taskId: 'task-1', requestedPaths: ['docs/report.md'] });
    assert.equal(authorized.mode, 'implement');
    assert.throws(() => policy.authorizeCall(session, { mode: 'implement', role: 'write', owner: 'caller-a', taskId: 'task-2', requestedPaths: ['docs/report.md'] }), (error) => error.code === 'session_scope_mismatch');
    assert.throws(() => policy.authorizeCall(session, { mode: 'implement', role: 'write', owner: 'caller-a', taskId: 'task-1', requestedPaths: ['src/main.mjs'] }), (error) => error.code === 'write_path_denied');
    assert.throws(() => policy.authorizeCall(session, { mode: 'inspect', role: 'write', owner: 'caller-a', taskId: 'task-1' }), (error) => error.code === 'read_mode_write_denied');
    assert.throws(() => policy.authorizeSession(session, { owner: 'caller-a', taskId: 'task-1', cwd: path.join(root, '..') }), (error) => error.code === 'session_scope_mismatch');
  });

  test('requires complete opaque scope identifiers', () => {
    assert.deepEqual(normalizeSessionScope({ owner: 'a', taskId: 'b' }, { required: true }), { owner: 'a', taskId: 'b' });
    assert.throws(() => normalizeSessionScope({ owner: 'a' }, { required: true }), (error) => error.code === 'session_scope_required');
    assert.throws(() => normalizeSessionScope({ owner: 'a', taskId: 'b\nc' }), (error) => error.code === 'session_scope_invalid');
  });
});

describe('ACP transport coexistence switch', () => {
  function transportClient({ failStart = false, failNewSessionCode = null, failPromptCode = null, delayMs = 0 } = {}) {
    const events = [];
    let nextSession = 1;
    let promptCount = 0;
    let activePrompts = 0;
    let maxActivePrompts = 0;
    const client = {
      started: false,
      closed: false,
      async start() { events.push(['start']); if (failStart) throw Object.assign(new Error('ACP unavailable'), { code: 'spawn_error' }); this.started = true; },
      async newSession() {
        events.push(['new']);
        if (failNewSessionCode) throw Object.assign(new Error(`ACP ${failNewSessionCode}`), { code: failNewSessionCode });
        const sessionId = `transport-session-${nextSession++}`;
        events.at(-1).push(sessionId);
        return { sessionId };
      },
      async prompt(sessionId, text) {
        events.push(['prompt', sessionId, text]);
        if (failPromptCode && promptCount++ === 0) throw Object.assign(new Error(`ACP ${failPromptCode}`), { code: failPromptCode });
        activePrompts += 1;
        maxActivePrompts = Math.max(maxActivePrompts, activePrompts);
        try {
          if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
          return { text: `answer:${text}` };
        } finally {
          activePrompts -= 1;
        }
      },
      async cancel(sessionId) { events.push(['cancel', sessionId]); },
      async closeSession(sessionId) { events.push(['close-session', sessionId]); return {}; },
      async close() { events.push(['close']); this.closed = true; this.started = false; },
    };
    return { client, events, get maxActivePrompts() { return maxActivePrompts; } };
  }

  test('defaults and invalid transport values fail closed to per-call', () => {
    assert.equal(resolveTransport({ path: 'fixture.json', data: {} }).mode, 'per-call');
    assert.equal(resolveTransport({ path: 'fixture.json', data: { transport: 'acp' } }).mode, 'acp');
    const invalid = resolveTransport({ path: 'fixture.json', data: { transport: 'ACP-ish' } });
    assert.equal(invalid.mode, 'per-call');
    assert.match(invalid.error, /per-call/);
  });

  test('reuses only an explicit ACP session and keeps implement on per-call fallback', async () => {
    const fixture = transportClient();
    const fallbacks = [];
    const manager = new AcpTransportManager({
      clientFactory: async () => fixture.client,
      fallback: async (request, context) => { fallbacks.push([request.task, context.reason]); return { isError: false, text: `fallback:${request.task}`, meta: { outcome: 'success' } }; },
    });
    const first = await manager.run({ sessionId: 'session-a', task: 'one', cwd: 'C:/fixture', mode: 'inspect', profile: 'read', model: 'fixture/provider', maxSteps: 80, timeoutSeconds: 5 });
    const second = await manager.run({ sessionId: 'session-a', task: 'two', cwd: 'C:/fixture', mode: 'review', profile: 'read', model: 'fixture/provider', maxSteps: 96, timeoutSeconds: 5 });
    const write = await manager.run({ sessionId: 'session-a', task: 'write', cwd: 'C:/fixture', mode: 'implement', profile: 'write', model: 'fixture/provider', maxSteps: 96, timeoutSeconds: 5 });
    assert.equal(first.meta.transport, 'acp');
    assert.equal(second.meta.transport, 'acp');
    assert.equal(fixture.events.filter((event) => event[0] === 'new').length, 1);
    assert.deepEqual(fallbacks, [['write', 'write_mode_per_call']]);
    assert.equal(write.meta.transport, 'per-call');
    await manager.close();
    assert.ok(fixture.events.some((event) => event[0] === 'close'));
  });

  test('falls back once on ACP startup failure and marks later requests degraded', async () => {
    const fixture = transportClient({ failStart: true });
    const fallbacks = [];
    const manager = new AcpTransportManager({
      clientFactory: async () => fixture.client,
      fallback: async (request, context) => { fallbacks.push(context.reason); return { isError: false, text: 'per-call', meta: { outcome: 'success' } }; },
    });
    const first = await manager.run({ sessionId: 'session-a', task: 'first', cwd: 'C:/fixture', mode: 'inspect', profile: 'read', model: 'fixture/provider' });
    const second = await manager.run({ sessionId: 'session-b', task: 'second', cwd: 'C:/fixture', mode: 'inspect', profile: 'read', model: 'fixture/provider' });
    assert.equal(first.meta.transport, 'per-call');
    assert.equal(second.meta.transport, 'per-call');
    assert.equal(manager.status.degraded, true);
    assert.deepEqual(fallbacks, ['acp_spawn_error', 'acp_degraded']);
  });

  test('preserves an internal ACP transport error code through coordinator fallback', async () => {
    const fixture = transportClient({ failPromptCode: 'timeout' });
    const fallbacks = [];
    const manager = new AcpTransportManager({
      clientFactory: async () => fixture.client,
      fallback: async (request, context) => { fallbacks.push(context.reason); return { isError: false, text: 'per-call', meta: { outcome: 'success' } }; },
    });
    const result = await manager.run({ sessionId: 'session-a', task: 'timeout', cwd: 'C:/fixture', mode: 'inspect', profile: 'read', model: 'fixture/provider' });
    assert.equal(result.meta.transport, 'per-call');
    assert.equal(result.meta.transportFallback, 'acp_timeout');
    assert.deepEqual(fallbacks, ['acp_timeout']);
    assert.equal(manager.status.degraded, true);
    assert.equal(manager.status.persistentSessions, 0);
  });

  test('closes an ACP client when session creation fails before registration', async () => {
    const fixture = transportClient({ failNewSessionCode: 'protocol_error' });
    const fallbacks = [];
    const manager = new AcpTransportManager({
      clientFactory: async () => fixture.client,
      fallback: async (_request, context) => { fallbacks.push(context.reason); return { isError: false, text: 'per-call', meta: { outcome: 'success' } }; },
    });
    await manager.run({ sessionId: 'session-a', task: 'new-session-failure', cwd: 'C:/fixture', mode: 'inspect', profile: 'read', model: 'fixture/provider' });
    assert.deepEqual(fallbacks, ['acp_protocol_error']);
    assert.equal(fixture.client.closed, true);
    assert.ok(fixture.events.some((event) => event[0] === 'close'));
  });

  test('serializes concurrent prompts for one ACP session and cancels only the active request', async () => {
    const fixture = transportClient({ delayMs: 12 });
    const manager = new AcpTransportManager({ clientFactory: async () => fixture.client, fallback: async () => ({ isError: true, text: 'fallback' }) });
    const first = manager.run({ sessionId: 'session-a', task: 'one', cwd: 'C:/fixture', mode: 'inspect', profile: 'read', model: 'fixture/provider' });
    const second = manager.run({ sessionId: 'session-a', task: 'two', cwd: 'C:/fixture', mode: 'inspect', profile: 'read', model: 'fixture/provider' });
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map((result) => result.meta.transport), ['acp', 'acp']);
    assert.deepEqual(fixture.events.filter((event) => event[0] === 'prompt').map((event) => event[2]), ['one', 'two']);
    assert.equal(fixture.events.filter((event) => event[0] === 'new').length, 1);
    assert.equal(fixture.maxActivePrompts, 1);
    const cancelRef = { requested: false, cancel: null };
    const cancelled = manager.run({ sessionId: 'session-a', task: 'three', cwd: 'C:/fixture', mode: 'inspect', profile: 'read', model: 'fixture/provider', cancelRef });
    await new Promise((resolve) => setTimeout(resolve, 2));
    cancelRef.requested = true;
    cancelRef.cancel?.();
    const cancelledResult = await cancelled;
    assert.equal(cancelledResult.meta.outcome, 'cancelled');
    assert.ok(fixture.events.some((event) => event[0] === 'cancel'));
    await manager.close();
  });

  test('accepts a configured additional allowed root without allowing session cwd drift', () => {
    const root = tempRoot();
    const extra = tempRoot();
    const policy = new AcpSecurityPolicy({ workspaceRoot: root, allowedRoots: [root, extra], requireScope: true });
    const session = { sessionId: 'extra-root', cwd: extra, profile: 'read', model: 'fixture/provider', owner: 'caller-a', taskId: 'task-1' };
    assert.equal(policy.authorizeSession(session, { owner: 'caller-a', taskId: 'task-1', cwd: extra }).cwd, extra);
    assert.throws(() => policy.authorizeSession(session, { owner: 'caller-a', taskId: 'task-1', cwd: root }), (error) => error.code === 'session_scope_mismatch');
  });
});

describe('ACP transport design prototype', () => {
  test('compacts before the hard cap and preserves system plus recent messages', () => {
    assert.equal(ACP_HISTORY_HARD_CAP_BYTES, 128 * 1024 * 1024);
    assert.equal(ACP_COMPACT_TRIGGER_RATIO, 0.75);
    const history = [
      { role: 'system', content: 'system policy' },
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'recent question' },
      { role: 'assistant', content: 'recent answer' },
    ];
    const decision = prepareSessionContinuation(history, { role: 'user', content: 'next' }, {
      hardCapBytes: 512,
      compactTriggerRatio: 0.25,
      summarize: (messages) => messages.map((message) => message.content).join(' | '),
    });
    assert.equal(decision.action, 'compact');
    assert.ok(decision.bytes < 512);
    assert.equal(decision.summarizedCount, 3);
    assert.equal(decision.persistentHistory[0].content, 'system policy');
    assert.equal(decision.persistentHistory.at(-1).content, 'next');
    assert.equal(history.some((message) => message.acpCompacted), false);
  });

  test('compact failure falls back per-call without mutating persistent history', () => {
    const history = [
      { role: 'user', content: 'old question', metadata: { source: 'fixture' } },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'recent question' },
    ];
    const before = JSON.stringify(history);
    const decision = prepareSessionContinuation(history, { role: 'user', content: 'next' }, {
      hardCapBytes: 100,
      summarize: (messages) => {
        messages[0].metadata.source = 'mutated copy';
        throw new Error('summary unavailable');
      },
    });
    assert.equal(decision.action, 'per_call');
    assert.equal(decision.reason, 'compact_failed');
    assert.deepEqual(decision.persistentHistory, history);
    assert.deepEqual(decision.callMessages, [{ role: 'user', content: 'next' }]);
    assert.equal(JSON.stringify(history), before);
  });

  test('rotation starts a fresh session when a valid summary cannot fit', () => {
    const history = [
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'recent question' },
    ];
    const next = { role: 'user', content: 'next' };
    const decision = prepareSessionContinuation(history, next, {
      hardCapBytes: historyBytes([next]) + 1,
      summarize: () => 'summary remains large enough to force rotation',
    });
    assert.equal(decision.action, 'rotate');
    assert.deepEqual(decision.persistentHistory, [next]);
    assert.equal(decision.callMessages[0].content, 'next');
  });
});

test('BRIDGE_LOG records redacted run metadata and stays optional', async () => {
  const root = tempRoot();
  writeCliFiles(root);
  writeFileSync(path.join(root, 'subagent'), `
const args = process.argv.slice(2);
if (args[0] === 'run' && args.includes('--max-steps') && args[args.indexOf('--max-steps') + 1] === '3') {
  process.stderr.write('stderr-secret');
  process.exit(7);
}
process.stdout.write('worker-visible-output');
`, 'utf8');
  const logPath = path.join(root, 'calls.jsonl');
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: root,
    env: envFor(root, { BRIDGE_LOG: logPath }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const responses = await readMcpSession(child, [
    { id: 1, method: 'tools/call', params: { name: 'reasonix_run', arguments: { task: 'task-secret-success', cwd: '.', mode: 'inspect', max_steps: 2, timeout_seconds: 2 } } },
    { id: 2, method: 'tools/call', params: { name: 'reasonix_run', arguments: { task: 'task-secret-rejected', mode: 'implement' } } },
    { id: 3, method: 'tools/call', params: { name: 'reasonix_run', arguments: { task: 'task-secret-failure', cwd: '.', mode: 'inspect', max_steps: 3, timeout_seconds: 2 } } },
  ]);
  const exit = await new Promise((resolve) => child.once('close', resolve));
  assert.equal(exit, 0);
  assert.equal(responses[0].result.isError, false);
  assert.equal(responses[1].result.isError, true);
  assert.equal(responses[2].result.isError, true);
  const records = readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(records.length, 3);
  assert.equal(records[0].mode, 'inspect');
  assert.equal(records[0].cwdRoot, 'workspace');
  assert.equal(records[0].maxSteps, 2);
  assert.equal(records[0].timeoutSeconds, 2);
  assert.equal(records[0].outcome, 'success');
  assert.equal(records[0].exitCode, 0);
  assert.ok(records[0].elapsedMs >= 0);
  assert.ok(records[0].outputBytes > 0);
  assert.equal(records[0].truncated, false);
  assert.equal(records[0].usage.status, 'unavailable');
  assert.equal(records[0].usage.reason, 'cli_usage_not_forwarded');
  assert.equal(records[0].usage.prompt_cache_hit_tokens, null);
  assert.equal(records[0].usage.prompt_cache_miss_tokens, null);
  assert.equal(records[1].mode, 'implement');
  assert.equal(records[1].outcome, 'rejected');
  assert.equal(records[1].exitCode, null);
  assert.equal(records[2].outcome, 'worker_exit');
  assert.equal(records[2].exitCode, 7);
  assert.equal(records[2].outputBytes, 0);
  assert.doesNotMatch(readFileSync(logPath, 'utf8'), /task-secret|stderr-secret|worker-visible-output/);
  for (const record of records) assert.doesNotMatch(JSON.stringify(record), /[A-Za-z]:\\\\|\\\\Users\\\\|\/tmp\//);
});

test('BRIDGE_LOG records cache usage only when the CLI forwards structured usage', async () => {
  const root = tempRoot();
  writeCliFiles(root);
  writeFileSync(path.join(root, 'subagent'), `
process.stdout.write(JSON.stringify({ content: 'completion-secret', usage: {
  prompt_tokens: 120, completion_tokens: 8, prompt_cache_hit_tokens: 96, prompt_cache_miss_tokens: 24
} }));
`, 'utf8');
  const logPath = path.join(root, 'cache-usage.jsonl');
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: root,
    env: envFor(root, { BRIDGE_LOG: logPath }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const responses = await readMcpSession(child, [
    { id: 1, method: 'tools/call', params: { name: 'reasonix_run', arguments: { task: 'cache-usage', cwd: '.', mode: 'inspect', max_steps: 2, timeout_seconds: 2 } } },
  ]);
  const exit = await new Promise((resolve) => child.once('close', resolve));
  assert.equal(exit, 0);
  assert.equal(responses[0].result.isError, false);
  const record = JSON.parse(readFileSync(logPath, 'utf8').trim());
  assert.deepEqual(record.usage, {
    status: 'available',
    source: 'cli',
    prompt_tokens: 120,
    completion_tokens: 8,
    prompt_cache_hit_tokens: 96,
    prompt_cache_miss_tokens: 24,
  });
  assert.doesNotMatch(readFileSync(logPath, 'utf8'), /completion-secret/);
});

test('BRIDGE_LOG selects the most complete usage record when progress arrives first', async () => {
  const root = tempRoot();
  writeCliFiles(root);
  writeFileSync(path.join(root, 'subagent'), `
process.stdout.write([
  JSON.stringify({ event: 'progress', usage: { prompt_cache_hit_tokens: 96 } }),
  JSON.stringify({ event: 'completed', usage: {
    prompt_tokens: 120, completion_tokens: 8, prompt_cache_hit_tokens: 96, prompt_cache_miss_tokens: 24
  } })
].join('\\n'));
`, 'utf8');
  const logPath = path.join(root, 'multi-record-usage.jsonl');
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: root,
    env: envFor(root, { BRIDGE_LOG: logPath }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const responses = await readMcpSession(child, [
    { id: 1, method: 'tools/call', params: { name: 'reasonix_run', arguments: { task: 'multi-record-usage', cwd: '.', mode: 'inspect', max_steps: 2, timeout_seconds: 2 } } },
  ]);
  const exit = await new Promise((resolve) => child.once('close', resolve));
  assert.equal(exit, 0);
  assert.equal(responses[0].result.isError, false);
  const record = JSON.parse(readFileSync(logPath, 'utf8').trim());
  assert.deepEqual(record.usage, {
    status: 'available',
    source: 'cli',
    prompt_tokens: 120,
    completion_tokens: 8,
    prompt_cache_hit_tokens: 96,
    prompt_cache_miss_tokens: 24,
  });
});

test('Reasonix max_steps pauses are classified separately from bridge timeouts', async () => {
  const root = tempRoot();
  writeCliFiles(root);
  writeFileSync(path.join(root, 'subagent'), `
process.stderr.write('sub-agent: paused after 5 tool-call rounds (max_steps) — work saved');
process.exit(1);
`, 'utf8');
  const logPath = path.join(root, 'step-limit.jsonl');
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: root,
    env: envFor(root, { BRIDGE_LOG: logPath }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const responses = await readMcpSession(child, [
    { id: 1, method: 'tools/call', params: { name: 'reasonix_run', arguments: { task: 'step-limit', cwd: '.', mode: 'inspect', max_steps: 10, timeout_seconds: 120 } } },
  ]);
  const exit = await new Promise((resolve) => child.once('close', resolve));
  assert.equal(exit, 0);
  assert.equal(responses[0].result.isError, true);
  assert.match(responses[0].result.content[0].text, /max_steps=10/);
  assert.match(responses[0].result.content[0].text, /5 tool-call rounds/);
  assert.match(responses[0].result.content[0].text, /timeout_seconds=120 was not reached/);
  const record = JSON.parse(readFileSync(logPath, 'utf8').trim());
  assert.equal(record.outcome, 'step_limit');
  assert.equal(record.stepLimitRounds, 5);
  assert.equal(record.timeoutSeconds, 120);
});

test('Reasonix continuation cursor failures are classified without automatic replay', async () => {
  const root = tempRoot();
  writeCliFiles(root);
  writeFileSync(path.join(root, 'subagent'), `
  process.stderr.write('sub-agent: read_file did not complete safely: read continuation cursor is not valid; cursor=opaque-token-secret; re-read the file');
process.exit(1);
`, 'utf8');
  const logPath = path.join(root, 'cursor-error.jsonl');
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: root,
    env: envFor(root, { BRIDGE_LOG: logPath }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const responses = await readMcpSession(child, [
    { id: 1, method: 'tools/call', params: { name: 'reasonix_run', arguments: { task: 'cursor-error', cwd: '.', mode: 'inspect', timeout_seconds: 120 } } },
  ]);
  const exit = await new Promise((resolve) => child.once('close', resolve));
  assert.equal(exit, 0);
  assert.equal(responses[0].result.isError, true);
  assert.match(responses[0].result.content[0].text, /malformed or invalid read_file continuation cursor/);
  assert.match(responses[0].result.content[0].text, /bridge did not retry the task/);
  assert.match(responses[0].result.content[0].text, /cursor diagnostic redacted/);
  assert.match(responses[0].result.content[0].text, /checkpoint_id=[0-9a-f-]{36}/);
  assert.doesNotMatch(responses[0].result.content[0].text, /opaque-token-secret/);
  const record = JSON.parse(readFileSync(logPath, 'utf8').trim());
  assert.equal(record.outcome, 'cursor_error');
  assert.equal(record.cursorError, true);
  assert.equal(record.stepLimitRounds, null);
});

test('failed runs create durable one-shot checkpoints that resume across bridge processes', async () => {
  const root = tempRoot();
  writeCliFiles(root);
    const checkpointDir = path.join(testArtifactRoot(), 'checkpoints', path.basename(root));
    tempArtifacts.add(checkpointDir);
  const callsPath = path.join(checkpointDir, 'calls');
  writeFileSync(path.join(root, 'subagent'), `
const fs = require('node:fs');
const calls = fs.existsSync(process.env.CALLS) ? Number(fs.readFileSync(process.env.CALLS, 'utf8')) : 0;
fs.mkdirSync(require('node:path').dirname(process.env.CALLS), { recursive: true });
fs.writeFileSync(process.env.CALLS, String(calls + 1));
if (calls === 0) { process.stderr.write('paused after 4 tool-call rounds (max_steps)'); process.exit(1); }
process.stdout.write('resumed-ok');
`, 'utf8');
  commitFixture(root);
  const env = envFor(root, { BRIDGE_CHECKPOINT_DIR: checkpointDir, CALLS: callsPath });
  const first = spawn(process.execPath, [SERVER_PATH], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const firstResponses = await readMcpSession(first, [{ id: 1, method: 'tools/call', params: { name: 'reasonix_run', arguments: { task: 'checkpoint task', cwd: '.', mode: 'inspect', max_steps: 8 } } }]);
  assert.equal(await new Promise((resolve) => first.once('close', resolve)), 0);
  assert.equal(firstResponses[0].result.isError, true);
  const checkpointId = firstResponses[0].result.content[0].text.match(/checkpoint_id=([0-9a-f-]{36})/)?.[1];
  assert.ok(checkpointId);
  const checkpointPath = path.join(checkpointDir, `${checkpointId}.json`);
  const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8'));
  assert.equal(checkpoint.schema, 'qlh.reasonix.checkpoint.v1');
  assert.equal(checkpoint.status, 'ready');
  assert.equal(checkpoint.outcome, 'step_limit');
  assert.equal(checkpoint.stage, null);
  assert.match(checkpoint.task, /checkpoint task/);
  assert.doesNotMatch(JSON.stringify(checkpoint), /resumed-ok|paused after/);

  const second = spawn(process.execPath, [SERVER_PATH], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const secondResponses = await readMcpSession(second, [{ id: 2, method: 'tools/call', params: { name: 'reasonix_resume', arguments: { checkpoint_id: checkpointId, tool_rounds: 6 } } }]);
  assert.equal(await new Promise((resolve) => second.once('close', resolve)), 0);
  assert.equal(secondResponses[0].result.isError, false);
  assert.match(secondResponses[0].result.content[0].text, /resumed-ok/);
  assert.equal(readFileSync(callsPath, 'utf8'), '2');
  const consumed = JSON.parse(readFileSync(checkpointPath, 'utf8'));
  assert.equal(consumed.status, 'consumed');

  const third = spawn(process.execPath, [SERVER_PATH], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const thirdResponses = await readMcpSession(third, [{ id: 3, method: 'tools/call', params: { name: 'reasonix_resume', arguments: { checkpoint_id: checkpointId } } }]);
  assert.equal(await new Promise((resolve) => third.once('close', resolve)), 0);
  assert.equal(thirdResponses[0].result.isError, true);
  assert.match(thirdResponses[0].result.content[0].text, /already been consumed/);
  assert.equal(readFileSync(callsPath, 'utf8'), '2');
});

test('checkpoint resume refuses workspace drift before spawning a worker', async () => {
  const root = tempRoot();
  writeCliFiles(root);
    const checkpointDir = path.join(testArtifactRoot(), 'checkpoints', path.basename(root));
    tempArtifacts.add(checkpointDir);
  const callsPath = path.join(checkpointDir, 'calls');
  writeFileSync(path.join(root, 'subagent'), `
const fs = require('node:fs');
const calls = fs.existsSync(process.env.CALLS) ? Number(fs.readFileSync(process.env.CALLS, 'utf8')) : 0;
fs.mkdirSync(require('node:path').dirname(process.env.CALLS), { recursive: true });
fs.writeFileSync(process.env.CALLS, String(calls + 1));
process.stderr.write('paused after 3 tool-call rounds (max_steps)');
process.exit(1);
`, 'utf8');
  commitFixture(root);
  const env = envFor(root, { BRIDGE_CHECKPOINT_DIR: checkpointDir, CALLS: callsPath });
  const first = spawn(process.execPath, [SERVER_PATH], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const firstResponses = await readMcpSession(first, [{ id: 1, method: 'tools/call', params: { name: 'reasonix_run', arguments: { task: 'drift task', cwd: '.', mode: 'inspect', max_steps: 6 } } }]);
  assert.equal(await new Promise((resolve) => first.once('close', resolve)), 0);
  const checkpointId = firstResponses[0].result.content[0].text.match(/checkpoint_id=([0-9a-f-]{36})/)?.[1];
  assert.ok(checkpointId);
  writeFileSync(path.join(root, 'drift.txt'), 'changed after checkpoint', 'utf8');
  const second = spawn(process.execPath, [SERVER_PATH], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const secondResponses = await readMcpSession(second, [{ id: 2, method: 'tools/call', params: { name: 'reasonix_resume', arguments: { checkpoint_id: checkpointId } } }]);
  assert.equal(await new Promise((resolve) => second.once('close', resolve)), 0);
  assert.equal(secondResponses[0].result.isError, true);
  assert.match(secondResponses[0].result.content[0].text, /working tree changed/);
  assert.equal(readFileSync(callsPath, 'utf8'), '1');
});

test('bridge limit overrides affect worker calls and status', async () => {
  const root = tempRoot();
  writeCliFiles(root);
  writeFileSync(path.join(root, 'bridge.config.json'), JSON.stringify({
    modelRef: 'fixture/provider',
    limits: { MAX_STEPS_CAP: 3, TIMEOUT_SECONDS_CAP: 4, OUTPUT_CHAR_CAP: 20, queueCap: 1 },
  }), 'utf8');
  const capturePath = path.join(root, 'worker-args.json');
  writeFileSync(path.join(root, 'subagent'), `
const fs = require('node:fs');
if (process.env.CAPTURE) fs.writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)));
process.stdout.write('z'.repeat(64));
`, 'utf8');
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: root,
    env: envFor(root, { CAPTURE: capturePath }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const responses = await readMcpSession(child, [
    { id: 1, method: 'tools/call', params: { name: 'reasonix_status', arguments: {} } },
    { id: 2, method: 'tools/call', params: { name: 'reasonix_run', arguments: { task: 'limit-check', cwd: '.', max_steps: 99, timeout_seconds: 999 } } },
    { id: 3, method: 'tools/call', params: { name: 'reasonix_status', arguments: {} } },
  ]);
  const exit = await new Promise((resolve) => child.once('close', resolve));
  assert.equal(exit, 0);
  const status = JSON.parse(responses[0].result.content[0].text);
  assert.deepEqual(status.limits, { maxStepsCap: 3, toolRoundsCap: 1, taskCharCap: 8000, timeoutSecondsCap: 4, outputCharCap: 20, queueCap: 1 });
  assert.equal(responses[1].result.isError, false);
  assert.match(responses[1].result.content[0].text, /\[output truncated; original 64 chars\]/);
  const afterStatus = JSON.parse(responses[2].result.content[0].text);
  assert.equal(afterStatus.lastRun.outcome, 'success');
  assert.equal(afterStatus.lastRun.truncated, true);
  const args = JSON.parse(readFileSync(capturePath, 'utf8'));
  assert.equal(args[args.indexOf('--max-steps') + 1], '3');
});

test('tool_rounds maps to the raw Reasonix step budget', async () => {
  const root = tempRoot();
  writeCliFiles(root);
  const capturePath = path.join(root, 'worker-args.json');
  writeFileSync(path.join(root, 'subagent'), `
const fs = require('node:fs');
fs.writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)));
process.stdout.write('round-budget-ok');
`, 'utf8');
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: root,
    env: envFor(root, { CAPTURE: capturePath }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const responses = await readMcpSession(child, [
    { id: 1, method: 'tools/call', params: { name: 'reasonix_status', arguments: {} } },
    { id: 2, method: 'tools/call', params: { name: 'reasonix_run', arguments: { task: 'round-budget', cwd: '.', mode: 'plan', stage: 'plan', tool_rounds: 7, timeout_seconds: 120 } } },
    { id: 3, method: 'tools/call', params: { name: 'reasonix_status', arguments: {} } },
  ]);
  const exit = await new Promise((resolve) => child.once('close', resolve));
  assert.equal(exit, 0);
  const status = JSON.parse(responses[0].result.content[0].text);
  assert.equal(status.limits.toolRoundsCap, 128);
  assert.equal(responses[1].result.isError, false);
  const afterStatus = JSON.parse(responses[2].result.content[0].text);
  assert.equal(afterStatus.lastRun.stage, 'plan');
  assert.equal(afterStatus.workflow.lastStage, 'plan');
  const args = JSON.parse(readFileSync(capturePath, 'utf8'));
  assert.equal(args[args.indexOf('--max-steps') + 1], '14');
});

test('wide budget configuration accepts explicit long runs within the hard cap', async () => {
  const root = tempRoot();
  writeCliFiles(root);
  writeFileSync(path.join(root, 'bridge.config.json'), JSON.stringify({
    modelRef: 'fixture/provider',
    limits: { MAX_STEPS_CAP: 240, TIMEOUT_SECONDS_CAP: 1200 },
  }), 'utf8');
  const capturePath = path.join(root, 'worker-args.json');
  writeFileSync(path.join(root, 'subagent'), `
const fs = require('node:fs');
fs.writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)));
process.stdout.write('wide-budget-ok');
`, 'utf8');
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: root,
    env: envFor(root, { CAPTURE: capturePath }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const responses = await readMcpSession(child, [
    { id: 1, method: 'tools/call', params: { name: 'reasonix_status', arguments: {} } },
    { id: 2, method: 'tools/call', params: { name: 'reasonix_run', arguments: { task: 'wide-budget', cwd: '.', tool_rounds: 100, timeout_seconds: 1500 } } },
  ]);
  const exit = await new Promise((resolve) => child.once('close', resolve));
  assert.equal(exit, 0);
  const status = JSON.parse(responses[0].result.content[0].text);
  assert.equal(status.limits.maxStepsCap, 240);
  assert.equal(status.limits.toolRoundsCap, 120);
  assert.equal(status.limits.timeoutSecondsCap, 1200);
  assert.equal(responses[1].result.isError, false);
  const args = JSON.parse(readFileSync(capturePath, 'utf8'));
  assert.equal(args[args.indexOf('--max-steps') + 1], '200');
});

test('invalid bridge limits fall back or clamp with one warning each', async () => {
  const root = tempRoot();
  writeCliFiles(root);
  writeFileSync(path.join(root, 'bridge.config.json'), JSON.stringify({
    modelRef: 'fixture/provider',
    limits: { MAX_STEPS_CAP: 0, TIMEOUT_SECONDS_CAP: 'not-a-number', OUTPUT_CHAR_CAP: 999999, queueCap: -1 },
  }), 'utf8');
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: root,
    env: envFor(root),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const responses = await readMcpSession(child, [{ id: 1, method: 'tools/call', params: { name: 'reasonix_status', arguments: {} } }]);
  const exit = await new Promise((resolve) => child.once('close', resolve));
  assert.equal(exit, 0);
  const status = JSON.parse(responses[0].result.content[0].text);
  assert.deepEqual(status.limits, { maxStepsCap: 256, toolRoundsCap: 128, taskCharCap: 8000, timeoutSecondsCap: 1800, outputCharCap: 24000, queueCap: 5 });
  for (const key of ['MAX_STEPS_CAP', 'TIMEOUT_SECONDS_CAP', 'OUTPUT_CHAR_CAP', 'queueCap']) {
    assert.equal((stderr.match(new RegExp(`bridge config ${key}`, 'g')) ?? []).length, 1);
  }
});

test('status reports in-flight depth and a redacted last run while queue-full calls are bounded', async () => {
  const root = tempRoot();
  writeCliFiles(root);
  writeFileSync(path.join(root, 'bridge.config.json'), JSON.stringify({
    modelRef: 'fixture/provider',
    limits: { queueCap: 1 },
  }), 'utf8');
  const startedPath = path.join(root, 'worker-started');
  writeFileSync(path.join(root, 'subagent'), `
const fs = require('node:fs');
fs.writeFileSync(process.env.STARTED, 'started');
setTimeout(() => process.stdout.write('slow-result'), 500);
`, 'utf8');
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: root,
    env: envFor(root, { STARTED: startedPath }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const client = mcpClient(child);
  const first = client.request(1, 'tools/call', { name: 'reasonix_run', arguments: { task: 'first-secret-task', cwd: '.', timeout_seconds: 5 } });
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 3000;
    const poll = () => {
      if (existsSync(startedPath)) resolve();
      else if (Date.now() >= deadline) reject(new Error('worker did not start'));
      else setTimeout(poll, 10);
    };
    poll();
  });
  const during = await client.request(2, 'tools/call', { name: 'reasonix_status', arguments: {} });
  const duringStatus = JSON.parse(during.result.content[0].text);
  assert.equal(duringStatus.queueDepth, 1);
  assert.equal(duringStatus.inFlight, 1);
  assert.equal(duringStatus.lastRun, null);
  const rejected = await client.request(3, 'tools/call', { name: 'reasonix_run', arguments: { task: 'second-secret-task', cwd: '.' } });
  assert.equal(rejected.result.isError, true);
  assert.match(rejected.result.content[0].text, /depth=1/);
  assert.match(rejected.result.content[0].text, /cap=1/);
  assert.match(rejected.result.content[0].text, /retry after about/);
  const completed = await first;
  assert.equal(completed.result.isError, false);
  const after = await client.request(4, 'tools/call', { name: 'reasonix_status', arguments: {} });
  const afterStatus = JSON.parse(after.result.content[0].text);
  assert.equal(afterStatus.queueDepth, 0);
  assert.equal(afterStatus.inFlight, 0);
  assert.equal(afterStatus.lastRun.outcome, 'success');
  assert.equal(afterStatus.lastRun.exitCode, 0);
  assert.equal(afterStatus.lastRun.cwdRoot, 'workspace');
  assert.doesNotMatch(JSON.stringify(afterStatus.lastRun), /first-secret-task|second-secret-task/);
  assert.doesNotMatch(JSON.stringify(afterStatus.lastRun), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  child.stdin.end();
  const exit = await new Promise((resolve) => child.once('close', resolve));
  assert.equal(exit, 0);
});

test('reasonix_events returns ordered redacted lifecycle events and supports incremental polling', async () => {
  const root = tempRoot();
  writeCliFiles(root);
  const startedPath = path.join(root, 'events-started');
  writeFileSync(path.join(root, 'subagent'), `
const fs = require('node:fs');
fs.writeFileSync(process.env.STARTED, 'started');
setTimeout(() => process.stdout.write('worker-output-secret'), 150);
`, 'utf8');
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: root,
    env: envFor(root, { STARTED: startedPath }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const client = mcpClient(child);
  try {
    const run = client.request(1, 'tools/call', { name: 'reasonix_run', arguments: { task: 'task-secret-events', cwd: '.', timeout_seconds: 5 } });
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 3000;
      const poll = () => {
        if (existsSync(startedPath)) resolve();
        else if (Date.now() >= deadline) reject(new Error('worker did not start'));
        else setTimeout(poll, 10);
      };
      poll();
    });
    const during = await client.request(2, 'tools/call', { name: 'reasonix_status', arguments: {} });
    const job = JSON.parse(during.result.content[0].text).jobs.find((entry) => entry.state === 'running');
    assert.ok(job?.jobId);
    assert.equal(job.eventCount, 2);
    const inFlight = await client.request(3, 'tools/call', { name: 'reasonix_events', arguments: { job_id: job.jobId, limit: 2 } });
    const inFlightPayload = JSON.parse(inFlight.result.content[0].text);
    assert.equal(inFlight.result.isError, false);
    assert.equal(inFlightPayload.schema, 'qlh.reasonix.events.v1');
    assert.equal(inFlightPayload.jobId, job.jobId);
    assert.deepEqual(inFlightPayload.events.map((event) => event.type), ['queued', 'started']);
    assert.equal(inFlightPayload.terminal, false);
    assert.equal(inFlightPayload.nextSeq, 2);
    assert.equal(inFlightPayload.latestSeq, 2);

    const result = await run;
    assert.equal(result.result.isError, false);
    const all = await client.request(4, 'tools/call', { name: 'reasonix_events', arguments: { job_id: job.jobId } });
    const payload = JSON.parse(all.result.content[0].text);
    assert.deepEqual(payload.events.map((event) => event.type), ['queued', 'started', 'completed']);
    assert.deepEqual(payload.events.map((event) => event.seq), [1, 2, 3]);
    assert.equal(payload.terminal, true);
    assert.equal(payload.state, 'completed');
    assert.equal(payload.nextSeq, 3);
    assert.equal(payload.latestSeq, 3);
    assert.equal(payload.hasMore, false);
    const eventKeys = ['jobId', 'seq', 'type', 'mode', 'stage', 'state', 'outcome', 'maxSteps', 'timeoutSeconds', 'stepLimitRounds', 'cancelRequested', 'queueDepth', 'inFlight', 'parallelActive', 'exclusiveActive', 'at'];
    for (const event of payload.events) {
      assert.deepEqual(Object.keys(event).sort(), [...eventKeys].sort());
    }
    const serialized = JSON.stringify(payload);
    assert.doesNotMatch(serialized, /task-secret-events|worker-output-secret/);
    assert.doesNotMatch(serialized, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const incremental = await client.request(5, 'tools/call', { name: 'reasonix_events', arguments: { job_id: job.jobId, after_seq: 2 } });
    const incrementalPayload = JSON.parse(incremental.result.content[0].text);
    assert.deepEqual(incrementalPayload.events.map((event) => event.type), ['completed']);
    assert.equal(incrementalPayload.nextSeq, 3);
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.once('close', resolve));
  }
});

test('reasonix_events reports cancellation as an ordered terminal lifecycle without worker text', async () => {
  const root = tempRoot();
  writeCliFiles(root);
  const startedPath = path.join(root, 'events-cancel-started');
  writeFileSync(path.join(root, 'subagent'), `
const fs = require('node:fs');
fs.writeFileSync(process.env.STARTED, 'started');
setTimeout(() => process.stdout.write('cancelled-worker-secret'), 5000);
`, 'utf8');
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: root,
    env: envFor(root, { STARTED: startedPath }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const client = mcpClient(child);
  try {
    const run = client.request(1, 'tools/call', { name: 'reasonix_run', arguments: { task: 'task-secret-cancel', cwd: '.', timeout_seconds: 5 } });
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 3000;
      const poll = () => {
        if (existsSync(startedPath)) resolve();
        else if (Date.now() >= deadline) reject(new Error('worker did not start'));
        else setTimeout(poll, 10);
      };
      poll();
    });
    const during = await client.request(2, 'tools/call', { name: 'reasonix_status', arguments: {} });
    const job = JSON.parse(during.result.content[0].text).jobs.find((entry) => entry.state === 'running');
    assert.ok(job?.jobId);
    const cancelled = await client.request(3, 'tools/call', { name: 'reasonix_cancel', arguments: { job_id: job.jobId } });
    assert.equal(cancelled.result.isError, false);
    await run;
    const events = await client.request(4, 'tools/call', { name: 'reasonix_events', arguments: { job_id: job.jobId } });
    const payload = JSON.parse(events.result.content[0].text);
    assert.deepEqual(payload.events.map((event) => event.type), ['queued', 'started', 'cancellation_requested', 'cancelled']);
    assert.equal(payload.terminal, true);
    assert.equal(payload.state, 'cancelled');
    assert.equal(payload.events[2].state, 'running');
    assert.equal(payload.events[2].cancelRequested, true);
    assert.equal(payload.events[3].outcome, 'cancelled');
    assert.doesNotMatch(JSON.stringify(payload), /task-secret-cancel|cancelled-worker-secret/);
    assert.doesNotMatch(JSON.stringify(payload), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.once('close', resolve));
  }
});

test('explicit parallel read jobs overlap and status reclaims their worker slots', async () => {
  const root = tempRoot();
  writeCliFiles(root);
  const markerDir = path.join(root, 'parallel-markers');
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(path.join(root, 'subagent'), `
const fs = require('node:fs');
const path = require('node:path');
const task = process.argv.at(-1);
const safe = task.replace(/[^a-z0-9-]/gi, '_');
fs.writeFileSync(path.join(process.env.PARALLEL_DIR, safe + '.started'), 'started');
setTimeout(() => {
  fs.writeFileSync(path.join(process.env.PARALLEL_DIR, safe + '.done'), 'done');
  process.stdout.write(task);
}, 350);
`, 'utf8');
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: root,
    env: envFor(root, { PARALLEL_DIR: markerDir }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const client = mcpClient(child);
  try {
    const first = client.request(1, 'tools/call', { name: 'reasonix_run', arguments: { task: 'parallel-one', cwd: '.', parallel: true, timeout_seconds: 5 } });
    const second = client.request(2, 'tools/call', { name: 'reasonix_run', arguments: { task: 'parallel-two', cwd: '.', parallel: true, timeout_seconds: 5 } });
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 3000;
      const poll = () => {
        if (existsSync(path.join(markerDir, 'parallel-one.started')) && existsSync(path.join(markerDir, 'parallel-two.started'))) resolve();
        else if (Date.now() >= deadline) reject(new Error('parallel workers did not overlap'));
        else setTimeout(poll, 10);
      };
      poll();
    });
    const during = await client.request(3, 'tools/call', { name: 'reasonix_status', arguments: {} });
    const duringStatus = JSON.parse(during.result.content[0].text);
    assert.equal(duringStatus.parallelActive, 2);
    assert.equal(duringStatus.exclusiveActive, 0);
    assert.equal(duringStatus.inFlight, 2);
    assert.equal(duringStatus.jobs.filter((job) => job.state === 'running' && job.parallel).length, 2);
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    assert.equal(firstResponse.result.isError, false);
    assert.equal(secondResponse.result.isError, false);
    assert.match(firstResponse.result.content[0].text, /parallel-one/);
    assert.match(secondResponse.result.content[0].text, /parallel-two/);
    const after = await client.request(4, 'tools/call', { name: 'reasonix_status', arguments: {} });
    const afterStatus = JSON.parse(after.result.content[0].text);
    assert.equal(afterStatus.parallelActive, 0);
    assert.equal(afterStatus.inFlight, 0);
    assert.equal(afterStatus.jobs.filter((job) => job.state === 'completed').length, 2);
    assert.equal(afterStatus.jobs.filter((job) => job.reclaimedAt).length, 2);
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.once('close', resolve));
  }
});

test('cancelling a parallel worker terminates it and reclaims the slot without a checkpoint', async () => {
  const root = tempRoot();
  writeCliFiles(root);
  const startedPath = path.join(root, 'parallel-cancel-started');
  writeFileSync(path.join(root, 'subagent'), `
const fs = require('node:fs');
fs.writeFileSync(process.env.STARTED, 'started');
setTimeout(() => process.stdout.write('should-not-finish'), 5000);
`, 'utf8');
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: root,
    env: envFor(root, { STARTED: startedPath }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const client = mcpClient(child);
  try {
    const run = client.request(1, 'tools/call', { name: 'reasonix_run', arguments: { task: 'cancel-me', cwd: '.', parallel: true, timeout_seconds: 5 } });
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 3000;
      const poll = () => {
        if (existsSync(startedPath)) resolve();
        else if (Date.now() >= deadline) reject(new Error('worker did not start'));
        else setTimeout(poll, 10);
      };
      poll();
    });
    const during = await client.request(2, 'tools/call', { name: 'reasonix_status', arguments: {} });
    const job = JSON.parse(during.result.content[0].text).jobs.find((entry) => entry.state === 'running');
    assert.ok(job?.jobId);
    const cancelled = await client.request(3, 'tools/call', { name: 'reasonix_cancel', arguments: { job_id: job.jobId } });
    assert.equal(cancelled.result.isError, false);
    assert.match(cancelled.result.content[0].text, /cancellation requested/);
    const result = await run;
    assert.equal(result.result.isError, true);
    assert.match(result.result.content[0].text, /worker cancelled/);
    const after = await client.request(4, 'tools/call', { name: 'reasonix_status', arguments: {} });
    const status = JSON.parse(after.result.content[0].text);
    const finished = status.jobs.find((entry) => entry.jobId === job.jobId);
    assert.equal(finished.state, 'cancelled');
    assert.equal(status.parallelActive, 0);
    assert.equal(status.inFlight, 0);
    assert.equal(status.checkpoint.readyCount, 0);
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.once('close', resolve));
  }
});

test('plan mode passes a machine-readable change list without enabling writes', async () => {
  const root = tempRoot();
  writeCliFiles(root);
  const plan = {
    schema: 'qlh.reasonix.plan.v1',
    changes: [{ file: 'src/server.mjs', location: 'line 1', reason: 'fixture reason', patch: 'replace one line' }],
  };
  writeFileSync(path.join(root, 'subagent'), `process.stdout.write(${JSON.stringify(JSON.stringify(plan))});`, 'utf8');
  const before = readdirSync(root).sort();
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: root,
    env: envFor(root, { BRIDGE_LOG: '' }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const responses = await readMcpSession(child, [
    { id: 1, method: 'tools/list' },
    { id: 2, method: 'tools/call', params: { name: 'reasonix_run', arguments: { task: 'plan-secret-task', cwd: '.', mode: 'plan' } } },
    { id: 3, method: 'tools/call', params: { name: 'reasonix_status', arguments: {} } },
    { id: 4, method: 'tools/call', params: { name: 'reasonix_run', arguments: { task: 'write-secret-task', cwd: '.', mode: 'implement' } } },
  ]);
  const exit = await new Promise((resolve) => child.once('close', resolve));
  assert.equal(exit, 0);
  const planTool = responses[0].result.tools.find((tool) => tool.name === 'reasonix_run');
  assert.deepEqual(planTool.inputSchema.properties.mode.enum, ['inspect', 'implement', 'review', 'plan']);
  assert.equal(responses[1].result.isError, false);
  assert.equal(responses[1].result.content[0].text, JSON.stringify(plan));
  assert.deepEqual(JSON.parse(responses[1].result.content[0].text), plan);
  const status = JSON.parse(responses[2].result.content[0].text);
  assert.ok(status.modes.includes('plan'));
  assert.equal(status.workerReadOnlyAssumed, true);
  assert.equal(responses[3].result.isError, true);
  assert.match(responses[3].result.content[0].text, /mode=implement is disabled/);
  assert.deepEqual(readdirSync(root).sort(), before);
});

test('low-version CLI is refused before the bridge starts', () => {
  const root = tempRoot();
  const cli = writeVersionStub(root, '1.38.5');
  const result = spawnSync(process.execPath, [SERVER_PATH], {
    cwd: root,
    env: envFor(root, { REASONIX_EXE: cli }),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /below minimum 1\.38\.6/);
});

test('unparseable CLI version remains unknown instead of blocking startup', () => {
  const result = checkCliVersion('missing-reasonix-cli');
  assert.equal(result.status, 'unknown');
  assert.match(result.error, /cannot run|not available|ENOENT/);
});

test('server keeps running with an unparseable CLI version and reports unknown', async () => {
  const root = tempRoot();
  const cli = writeVersionStub(root, 'development');
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: root,
    env: envFor(root, { REASONIX_EXE: cli }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const responses = await readMcpSession(child, [{ id: 1, method: 'tools/call', params: { name: 'reasonix_status', arguments: {} } }]);
  const exit = await new Promise((resolve) => child.once('close', resolve));
  assert.equal(exit, 0);
  const status = JSON.parse(responses[0].result.content[0].text);
  assert.equal(status.versionCheck, 'unknown');
});
