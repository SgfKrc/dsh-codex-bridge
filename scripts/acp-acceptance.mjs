#!/usr/bin/env node
/**
 * Offline ACP-06 acceptance drill.
 *
 * This deliberately uses a deterministic ACP client fixture. It exercises the
 * bridge lifecycle and cleanup contracts without requiring a model or network.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpSessionCoordinator } from '../src/acp-session.mjs';
import { AcpClient } from '../src/acp-client.mjs';
import { AcpSessionRegistry } from '../src/acp-registry.mjs';
import { AcpTransportManager } from '../src/acp-transport.mjs';
import { historyBytes } from '../src/acp-prototype.mjs';
import { checkCliVersion, readBridgeConfig, resolveCliPath, resolveModelRef, validateModelRef } from '../src/config.mjs';

const BRIDGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_ROOT = path.resolve(BRIDGE_ROOT, '..', '..', 'build', 'bridge-test');
const REGISTRY_PATH = path.join(TEST_ROOT, 'acp-06-registry.json');
const DRILL_ROOT = path.join(TEST_ROOT, 'acp-06-drill');
const CHILD_MODE = process.argv[2] === '--registry-child';
const REAL_MODE = process.argv[2] === '--real';

function removeDrillArtifacts() {
  for (const target of [REGISTRY_PATH, DRILL_ROOT]) {
    const relative = path.relative(TEST_ROOT, target);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`unsafe ACP-06 cleanup target: ${target}`);
  }
  rmSync(REGISTRY_PATH, { force: true });
  rmSync(DRILL_ROOT, { recursive: true, force: true });
}

function fakeClient({ sessionId = 'acp-06-session', delayMs = 0 } = {}) {
  const events = [];
  let newSessionCount = 0;
  let activePrompts = 0;
  let maxActivePrompts = 0;
  const client = {
    started: false,
    closed: false,
    async start() { this.started = true; this.closed = false; events.push(['start']); },
    async newSession() {
      newSessionCount += 1;
      const id = newSessionCount === 1 ? sessionId : `${sessionId}-replacement-${newSessionCount}`;
      events.push(['new', id]);
      return { sessionId: id };
    },
    supportsSession(name) { return ['resume', 'load', 'delete'].includes(name); },
    async resumeSession(id) { events.push(['resume', id]); return { sessionId: id }; },
    async loadSession(id) { events.push(['load', id]); return { sessionId: id }; },
    async prompt(id, text) {
      events.push(['prompt-start', id, text]);
      activePrompts += 1;
      maxActivePrompts = Math.max(maxActivePrompts, activePrompts);
      try {
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        events.push(['prompt-end', id, text]);
        return { text: `reply:${text}` };
      } finally {
        activePrompts -= 1;
      }
    },
    async cancel(id) { events.push(['cancel', id]); },
    async closeSession(id) { events.push(['close-session', id]); },
    async deleteSession(id) { events.push(['delete-session', id]); },
    async close() { this.closed = true; this.started = false; events.push(['close']); },
  };
  return { client, events, get maxActivePrompts() { return maxActivePrompts; } };
}

async function runChild() {
  const statePath = path.resolve(process.argv[3]);
  const cwd = path.resolve(process.argv[4]);
  const { client } = fakeClient();
  const registry = new AcpSessionRegistry({ statePath, scopeRequired: true });
  await registry.create({ client, cwd, profile: 'read', model: 'fixture/provider', scope: { owner: 'acp-06', taskId: 'drill' } });
  process.stdout.write('READY\n');
  setInterval(() => {}, 1_000);
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('registry child did not become ready')), 5_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('READY')) { clearTimeout(timer); resolve(); }
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      if (!output.includes('READY')) { clearTimeout(timer); reject(new Error(`registry child exited before ready (${code})`)); }
    });
  });
}

async function stopChild(child) {
  const exited = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  if (!child.kill('SIGKILL')) throw new Error('could not strongly terminate registry child');
  const result = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve({ code: null, signal: 'timeout' }), 3_000))]);
  if (result.signal === 'timeout') {
    throw new Error('registry child did not exit after strong termination');
  }
  return result;
}

async function compactDrill() {
  const { client, events } = fakeClient();
  const coordinator = new AcpSessionCoordinator({
    client,
    hardCapBytes: 600,
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
  if (result.action !== 'compact' || coordinator.decisions[0]?.resultBytes >= coordinator.hardCapBytes) throw new Error('compact drill did not stay below the hard cap');
  await coordinator.close();
  const rotateClient = fakeClient({ sessionId: 'acp-06-rotate' });
  const next = { role: 'user', content: 'next' };
  const rotate = new AcpSessionCoordinator({
    client: rotateClient.client,
    hardCapBytes: historyBytes([next, { role: 'assistant', content: 'reply:next' }]) + 1,
    compactTriggerRatio: 0.25,
    preserveRecent: 1,
    summarize: () => 'oversized summary '.repeat(40),
  });
  await rotate.start();
  rotate.history = [{ role: 'user', content: 'old question' }, { role: 'assistant', content: 'old answer' }];
  const rotated = await rotate.prompt(next.content);
  if (rotated.action !== 'rotate' || historyBytes(rotate.currentHistory) >= rotate.hardCapBytes) throw new Error('rotate drill did not produce a bounded replacement history');
  await rotate.close();
  return { action: result.action, replacementCleanup: events.filter((event) => event[0] === 'close-session').length >= 2, rotate: rotated.action };
}

async function transportDrill() {
  const fixture = fakeClient({ sessionId: 'transport-session', delayMs: 20 });
  const { client, events } = fixture;
  const manager = new AcpTransportManager({ clientFactory: async () => client, fallback: async () => ({ isError: true, text: 'fallback' }) });
  const first = manager.run({ sessionId: 'transport', task: 'one', cwd: DRILL_ROOT, mode: 'inspect', profile: 'read', model: 'fixture/provider' });
  const second = manager.run({ sessionId: 'transport', task: 'two', cwd: DRILL_ROOT, mode: 'inspect', profile: 'read', model: 'fixture/provider' });
  const results = await Promise.all([first, second]);
  const order = events.filter((event) => event[0] === 'prompt-start').map((event) => event[2]);
  if (order.join(',') !== 'one,two' || results.some((result) => result.meta.transport !== 'acp') || events.filter((event) => event[0] === 'new').length !== 1 || fixture.maxActivePrompts !== 1) throw new Error('concurrent ACP prompts were not serialized');
  const cancelRef = { requested: false, cancel: null };
  const pending = manager.run({ sessionId: 'transport', task: 'cancelled', cwd: DRILL_ROOT, mode: 'inspect', profile: 'read', model: 'fixture/provider', cancelRef });
  await new Promise((resolve) => setTimeout(resolve, 2));
  cancelRef.requested = true;
  cancelRef.cancel?.();
  const cancelled = await pending;
  if (cancelled.meta.outcome !== 'cancelled' || !events.some((event) => event[0] === 'cancel')) throw new Error('active ACP cancellation was not observed');
  await manager.close();
  return { serialized: true, cancelled: true, persistentSessionsAfterClose: manager.status.persistentSessions };
}

function writeAcpFixture(file) {
  writeFileSync(file, `
const readline = require('node:readline');
let nextSession = 1;
const input = readline.createInterface({ input: process.stdin, terminal: false });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
input.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {}, delete: {} } } } });
  else if (message.method === 'session/new') send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'acp-06-real-' + nextSession++ } });
  else if (message.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fixture-response' } } } });
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
  } else if (['session/close', 'session/delete', 'session/cancel'].includes(message.method)) send({ jsonrpc: '2.0', id: message.id, result: {} });
});
`, 'utf8');
}

async function realClientDrill() {
  const fixturePath = path.join(DRILL_ROOT, 'acp-fixture.cjs');
  writeAcpFixture(fixturePath);
  const client = new AcpClient({ cliPath: process.execPath, commandPrefix: [fixturePath], modelRef: 'fixture/provider', cwd: DRILL_ROOT, timeoutMs: 500 });
  await client.start();
  const childPid = client.child?.pid ?? 0;
  if (!Number.isInteger(childPid) || childPid < 1) throw new Error('real ACP child did not expose a process id');
  const session = await client.newSession();
  const prompt = await client.prompt(session.sessionId, 'real-process');
  if (prompt.text !== 'fixture-response') throw new Error('real ACP child did not return an update');
  await client.close({ sessionId: session.sessionId });
  if (client.child !== null || client.started || client.closed !== true) throw new Error('real ACP child was not fully closed');
  let childAlive = false;
  try { process.kill(childPid, 0); childAlive = true; } catch { /* expected after cleanup */ }
  if (childAlive) throw new Error('real ACP child process still exists after close');
  return { handshake: true, prompt: true, childClosed: true };
}

async function configuredReasonixDrill() {
  const config = readBridgeConfig();
  const cliPath = resolveCliPath();
  const version = checkCliVersion(cliPath);
  if (version.status === 'fail') throw new Error(version.error);
  const modelRef = resolveModelRef({ cliPath, bridgeConfig: config }).ref;
  const modelProblem = validateModelRef(modelRef);
  if (modelProblem) throw new Error(modelProblem);
  const options = { cliPath, modelRef, cwd: BRIDGE_ROOT, workspaceOnly: true, timeoutMs: 30_000 };
  const first = new AcpClient(options);
  let sessionId = '';
  try {
    await first.start();
    sessionId = (await first.newSession()).sessionId;
    await first.abort();
    const second = new AcpClient(options);
    let deleted = false;
    try {
      await second.start();
      if (!second.supportsSession('resume')) throw new Error('configured Reasonix does not advertise session/resume');
      if (!second.supportsSession('delete')) throw new Error('configured Reasonix does not advertise session/delete');
      try {
        await second.resumeSession(sessionId);
      } catch (error) {
        if (/unknown session/iu.test(error.message)) {
          return {
            schema: 'qlh.reasonix.acp.acceptance.real.v1',
            status: 'blocked',
            version: version.version,
            reason: 'empty_session_not_persisted',
            detail: 'Reasonix did not retain a session that had no prompt before the strong kill; rerun this gate after a real prompt or provider-backed persistence fixture.',
            lifecycle: { created: true, strongKill: true, resumed: false, closed: true, deleted: false },
          };
        }
        throw error;
      }
      await second.closeSession(sessionId);
      await second.deleteSession(sessionId);
      deleted = true;
    } finally {
      if (!deleted && sessionId && second.started && second.supportsSession('delete')) {
        try { await second.deleteSession(sessionId); } catch { /* best effort cleanup after a failed drill */ }
      }
      await second.close();
    }
  } finally {
    if (first.child) await first.abort();
  }
  return { schema: 'qlh.reasonix.acp.acceptance.real.v1', status: 'passed', version: version.version, lifecycle: { created: true, strongKill: true, resumed: true, closed: true, deleted: true } };
}

async function runAcceptance() {
  mkdirSync(TEST_ROOT, { recursive: true });
  removeDrillArtifacts();
  mkdirSync(DRILL_ROOT, { recursive: true });
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--registry-child', REGISTRY_PATH, DRILL_ROOT], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let childResult;
  try {
    await waitForReady(child);
    childResult = await stopChild(child);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* best effort */ }
    }
  }
  const registry = new AcpSessionRegistry({ statePath: REGISTRY_PATH, scopeRequired: true });
  const orphan = registry.list({ includeClosed: false }).find((entry) => entry.sessionId === 'acp-06-session');
  if (orphan?.state !== 'orphaned') throw new Error('cross-process crash did not produce an orphaned session');
  const resumed = fakeClient({ sessionId: 'acp-06-session' });
  await registry.resume('acp-06-session', { clientFactory: async () => resumed.client });
  const resumedPrompt = await registry.prompt('acp-06-session', 'after-resume', { owner: 'acp-06', taskId: 'drill', mode: 'inspect' });
  if (resumedPrompt.text !== 'reply:after-resume') throw new Error('resumed session did not accept a prompt');
  const persisted = readFileSync(REGISTRY_PATH, 'utf8');
  if (persisted.includes('after-resume') || persisted.includes('reply:after-resume')) throw new Error('registry persisted a prompt or response body');
  const shutdown = await registry.shutdown();
  if (shutdown.errors.length || registry.list({ includeClosed: false }).some((entry) => entry.state !== 'closed')) throw new Error('registry shutdown left an active session');
  const compact = await compactDrill();
  const transport = await transportDrill();
  const realClient = await realClientDrill();
  const result = {
    schema: 'qlh.reasonix.acp.acceptance.v1',
    status: 'passed',
    process: { childExited: childResult.signal !== 'timeout', strongKillRequested: true, childCode: childResult.code, childSignal: childResult.signal },
    resume: { orphanDetected: true, resumed: true, promptAccepted: true, shutdownClosed: shutdown.closed },
    compact,
    transport,
    realClient,
    artifacts: { registryPath: path.relative(process.cwd(), REGISTRY_PATH), retainedBodies: false },
  };
  removeDrillArtifacts();
  if (existsSync(REGISTRY_PATH) || existsSync(DRILL_ROOT)) throw new Error('ACP-06 drill artifacts were not removed');
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (CHILD_MODE) await runChild();
else if (REAL_MODE) {
  try {
    const report = await configuredReasonixDrill();
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.status !== 'passed') process.exitCode = 2;
  }
  catch (error) { process.stderr.write(`ACP-06 real acceptance failed: ${error.message}\n`); process.exitCode = 1; }
}
else {
  try { await runAcceptance(); }
  catch (error) {
    process.stderr.write(`ACP-06 acceptance failed: ${error.message}\n`);
    try { removeDrillArtifacts(); } catch { /* best effort */ }
    process.exitCode = 1;
  }
}
