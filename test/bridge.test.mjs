/**
 * 离线回归：不调用模型、不联网。覆盖 MCP 握手、工具面、参数闸门与安全边界。
 * 需要真模型的那部分（真的把任务跑完）由 scripts/live-probe.mjs 单独做。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'src', 'server.mjs');

/**
 * 默认的 DSH_BIN：指向一个**真实存在**的文件即可 —— 启动期只校验存在性，
 * 不会真的去执行它（所有会被拒绝的调用都在 spawn 之前就返回了）。
 * 用本文件自身当占位，避免依赖机器上装没装 dsh。
 */
const FAKE_BIN = fileURLToPath(import.meta.url);

/** 起一个 MCP 会话，发送若干请求，返回按 id 索引的响应。 */
function session(requests, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DSH_BIN: FAKE_BIN, DSH_WORKSPACE_ROOT: process.cwd(), ...env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c) => { err += c.toString('utf8'); });
    child.on('error', reject);
    child.on('close', () => {
      const responses = {};
      for (const line of out.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const m = JSON.parse(t);
          if (m.id !== undefined && m.id !== null) responses[m.id] = m;
        } catch { /* 忽略非 JSON 行 */ }
      }
      resolve({ responses, out, err });
    });
    for (const r of requests) child.stdin.write(`${JSON.stringify(r)}\n`);
    child.stdin.end();
  });
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };

test('initialize advertises the tools capability and a stable server name', async () => {
  const { responses } = await session([INIT]);
  const r = responses[1];
  assert.equal(r.result.capabilities.tools !== undefined, true);
  assert.equal(r.result.protocolVersion, '2024-11-05');
  assert.equal(r.result.serverInfo.name, 'dsh-subagent-bridge');
});

test('tools/list exposes exactly dsh_run and dsh_status', async () => {
  const { responses } = await session([INIT, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }]);
  const names = responses[2].result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['dsh_run', 'dsh_status']);
});

test('dsh_run schema requires a task string', async () => {
  const { responses } = await session([INIT, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }]);
  const run = responses[2].result.tools.find((t) => t.name === 'dsh_run');
  assert.deepEqual(run.inputSchema.required, ['task']);
  assert.equal(run.inputSchema.properties.task.type, 'string');
});

test('unknown method returns a JSON-RPC method-not-found error', async () => {
  const { responses } = await session([INIT, { jsonrpc: '2.0', id: 2, method: 'nope/nope', params: {} }]);
  assert.equal(responses[2].error.code, -32601);
});

test('dsh_status reports configuration without invoking a model', async () => {
  const { responses } = await session([
    INIT,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dsh_status', arguments: {} } },
  ]);
  const status = JSON.parse(responses[2].result.content[0].text);
  assert.equal(status.schema, 'qlh.dsh.subagent.status.v1');
  assert.equal(status.profile, 'headless');
  assert.equal(status.limits.hardTimeoutSecondsCap, 1800);
  assert.equal(status.limits.taskCharCap, 16000);
});

test('an empty task is rejected before any process is spawned', async () => {
  const { responses } = await session([
    INIT,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dsh_run', arguments: { task: '   ' } } },
  ]);
  const r = responses[2].result;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /task is required/);
});

test('a task over the character cap is rejected', async () => {
  const { responses } = await session([
    INIT,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dsh_run', arguments: { task: 'x'.repeat(16001) } } },
  ]);
  const r = responses[2].result;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /over the 16000 char cap/);
});

test('a cwd escaping the workspace root is rejected', async () => {
  const { responses } = await session([
    INIT,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dsh_run', arguments: { task: 'hi', cwd: '../../../../..' } } },
  ]);
  const r = responses[2].result;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /escapes the allowed workspace root/);
});

test('a non-positive timeout is rejected', async () => {
  const { responses } = await session([
    INIT,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dsh_run', arguments: { task: 'hi', timeout_seconds: 0 } } },
  ]);
  const r = responses[2].result;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /timeout_seconds must be a positive integer/);
});

test('a missing dsh launcher fails loudly instead of silently doing nothing', async () => {
  const { responses, err } = await session(
    [INIT, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dsh_run', arguments: { task: 'hi' } } }],
    { DSH_BIN: 'C:/definitely/not/here/bin.js' },
  );
  // DSH_BIN 指向不存在的文件 ⇒ 启动期拒绝（exit 2），不会返回任何响应。
  assert.equal(responses[2], undefined);
  assert.match(err, /refusing to start/);
});

test('calling an unknown tool is reported as a tool error, not a crash', async () => {
  const { responses } = await session([
    INIT,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dsh_nope', arguments: {} } },
  ]);
  const r = responses[2].result;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /unknown tool/);
});

// ── ACP 传输（默认关闭，逐次 opt-in）────────────────────────────────────────

test('dsh_run advertises the acp transport and session_id in its schema', async () => {
  const { responses } = await session([INIT, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }]);
  const run = responses[2].result.tools.find((t) => t.name === 'dsh_run');
  assert.deepEqual(run.inputSchema.properties.transport.enum, ['per-call', 'acp']);
  assert.equal(run.inputSchema.properties.session_id.type, 'string');
});

test('dsh_status reports the acp transport state', async () => {
  const { responses } = await session([
    INIT,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dsh_status', arguments: {} } },
  ]);
  const status = JSON.parse(responses[2].result.content[0].text);
  assert.equal(status.transport.default, 'per-call');
  assert.equal(status.transport.acp.enabled, false);
  assert.equal(status.transport.acp.activeSessions, 0);
  assert.equal(status.transport.acp.sessionCap, 8);
});

test('transport=acp is refused while ACP is disabled', async () => {
  const { responses } = await session([
    INIT,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dsh_run', arguments: { task: 'hi', transport: 'acp' } } },
  ]);
  const r = responses[2].result;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /transport=acp is disabled/);
});

test('session_id without transport=acp is rejected', async () => {
  const { responses } = await session([
    INIT,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dsh_run', arguments: { task: 'hi', session_id: 'whatever' } } },
  ]);
  const r = responses[2].result;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /session_id is only valid with transport=acp/);
});

test('an unknown ACP session_id is rejected rather than silently creating a new session', async () => {
  const { responses } = await session(
    [INIT, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dsh_run', arguments: { task: 'hi', transport: 'acp', session_id: 'nope' } } }],
    { DSH_ACP_ENABLED: 'true' },
  );
  const r = responses[2].result;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /unknown ACP session_id/);
});

test('the server exits on its own once stdin ends (no lingering handles)', async () => {
  // 回归：持久 ACP 子进程的 stdio 曾把事件循环钉住，导致 stdin 结束后桥接器进程不退出，
  // 调用方管道永不关闭（表现为 Codex 每次 ACP 调用都挂死）。这里断言进程会自然退出。
  const started = Date.now();
  await session([
    INIT,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dsh_status', arguments: {} } },
  ]);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 15000, `server took ${elapsed}ms to exit after stdin end`);
});

// ── 抗升级：入口解析与版本门 ──────────────────────────────────────────────

/**
 * 造一个最小 dsh 包：`<root>/node_modules/@deepseek-ai/dsh/{lib/bin.js,package.json}`。
 * 只用于入口解析与版本门断言；被拒绝的调用都在 spawn 之前返回，不会真的执行它。
 */
function makeFakeDshPackage(version, name = '@deepseek-ai/dsh') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-fixture-'));
  const pkgDir = path.join(root, 'node_modules', '@deepseek-ai', 'dsh');
  mkdirSync(path.join(pkgDir, 'lib'), { recursive: true });
  writeFileSync(path.join(pkgDir, 'lib', 'bin.js'), '#!/usr/bin/env node\n', 'utf8');
  writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name, version }, null, 2), 'utf8');
  return { root, bin: path.join(pkgDir, 'lib', 'bin.js') };
}

test('dsh_status reports the launcher source and the version gate', async () => {
  const { responses } = await session([
    INIT,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dsh_status', arguments: {} } },
  ]);
  const status = JSON.parse(responses[2].result.content[0].text);
  assert.equal(status.dsh.source, 'DSH_BIN');
  assert.equal(status.dsh.minVersion, '0.1.5');
  // 测试桩不是 dsh 包 ⇒ 版本不可知：只警告，不做判定
  assert.equal(status.dsh.version, null);
  assert.equal(status.dsh.versionCheck, 'unknown');
  assert.equal(status.dsh.launcher, status.launcher);
});

test('a version below DSH_MIN_VERSION is refused at startup', async () => {
  const fixture = makeFakeDshPackage('0.0.9');
  try {
    const { responses, err } = await session([INIT], { DSH_BIN: fixture.bin });
    assert.equal(responses[1], undefined);
    assert.match(err, /below the required minimum 0\.1\.5/);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('DSH_MIN_VERSION can be lowered deliberately', async () => {
  const fixture = makeFakeDshPackage('0.0.9');
  try {
    const { responses } = await session([INIT], { DSH_BIN: fixture.bin, DSH_MIN_VERSION: '0.0.1' });
    assert.equal(responses[1].result.serverInfo.name, 'dsh-subagent-bridge');
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('a pre-release of the minimum version passes the gate (rc suffix ignored)', async () => {
  const fixture = makeFakeDshPackage('0.1.5-rc.2');
  try {
    const { responses } = await session([INIT], { DSH_BIN: fixture.bin });
    assert.equal(responses[1].result.serverInfo.name, 'dsh-subagent-bridge');
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('a foreign package at DSH_BIN is not mistaken for dsh', async () => {
  const fixture = makeFakeDshPackage('9.9.9', 'some-other-package');
  try {
    const { responses, err } = await session([
      INIT,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dsh_status', arguments: {} } },
    ], { DSH_BIN: fixture.bin });
    const status = JSON.parse(responses[2].result.content[0].text);
    assert.equal(status.dsh.version, null);
    assert.match(err, /cannot determine the dsh version/);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('a PATH dsh shim is resolved to the real bin.js without a shell', async () => {
  const fixture = makeFakeDshPackage('0.1.7-rc.1');
  try {
    // npm 全局布局：<prefix>/dsh.cmd 与 <prefix>/node_modules/@deepseek-ai/dsh/lib/bin.js 同级
    writeFileSync(path.join(fixture.root, 'dsh.cmd'),
      '@ECHO off' + String.fromCharCode(13, 10)
      + 'SET _prog=node' + String.fromCharCode(13, 10)
      + '"%_prog%" "%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*' + String.fromCharCode(13, 10), 'utf8');
    const { responses } = await session([
      INIT,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dsh_status', arguments: {} } },
    ], { DSH_BIN: '', APPDATA: '', LOCALAPPDATA: '', PATH: fixture.root });
    const status = JSON.parse(responses[2].result.content[0].text);
    assert.equal(status.dsh.launcher, fixture.bin);
    assert.match(status.dsh.source, /PATH shim \(dsh\.cmd\)/);
    assert.equal(status.dsh.version, '0.1.7-rc.1');
    assert.equal(status.dsh.versionCheck, 'ok');
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('a shim pointing at a relative store path is reverse-resolved', async () => {
  const fixture = makeFakeDshPackage('0.1.7-rc.1');
  try {
    // shim 与包不同目录：文本里是相对前缀（%~dp0\..\…），反解后应落到真实包
    const shimDir = path.join(fixture.root, 'shims');
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(path.join(shimDir, 'dsh.cmd'),
      '@ECHO off' + String.fromCharCode(13, 10)
      + '"%_prog%" "%~dp0\\..\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*' + String.fromCharCode(13, 10), 'utf8');
    const { responses } = await session([
      INIT,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dsh_status', arguments: {} } },
    ], { DSH_BIN: '', APPDATA: '', LOCALAPPDATA: '', PATH: shimDir });
    const status = JSON.parse(responses[2].result.content[0].text);
    assert.equal(status.dsh.launcher, fixture.bin);
    assert.equal(status.dsh.version, '0.1.7-rc.1');
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('with no DSH_BIN and no dsh on PATH the bridge refuses loudly', async () => {
  const empty = mkdtempSync(path.join(os.tmpdir(), 'dsh-empty-'));
  try {
    const { responses, err } = await session([INIT], {
      DSH_BIN: '', DSH_HOME: '', NPM_CONFIG_PREFIX: '', APPDATA: '', LOCALAPPDATA: '', PATH: empty,
    });
    assert.equal(responses[1], undefined);
    assert.match(err, /cannot locate the dsh launcher/);
  } finally { rmSync(empty, { recursive: true, force: true }); }
});
