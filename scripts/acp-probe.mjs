/**
 * 用真实的 ACP 交互相对于 `dsh --profile acp` 做端到端验收。
 *
 * 用法：
 *   node scripts/acp-probe.mjs [cwd] [prompt]
 *
 * 需要 DSH_BIN 指向 dsh 启动器（`.../@deepseek-ai/dsh/lib/bin.js`）。不硬编码任何
 * 本机路径 —— 这个脚本会进公开仓库，机器专属值必须由使用方自行注入。
 *
 * 实现要点：保持 stdin 打开。若过早关闭管道，会话建立会被中途取消，
 * 表现为 `session/new` 无响应 —— 那是假阴性，不是协议失败。
 */
import { spawn } from 'node:child_process';

const BIN = process.env.DSH_BIN;
if (!BIN) {
  console.error('DSH_BIN is required: point it at <...>/@deepseek-ai/dsh/lib/bin.js');
  process.exit(2);
}
const CWD = process.argv[2] ? process.argv[2] : process.cwd();
const PROMPT = process.argv[3] || 'Reply with exactly this token and nothing else: DSH_ACP_OK';

const child = spawn(process.execPath, [BIN, '--profile', 'acp'], {
  cwd: CWD, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
const seen = [];
const pending = new Map();
const updates = [];

function send(msg) { child.stdin.write(`${JSON.stringify(msg)}\n`); }

child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.method === 'session/update') { updates.push(m.params?.update ?? m.params); continue; }
    if (m.id !== undefined && m.id !== null) {
      seen.push(m);
      const p = pending.get(m.id);
      if (p) p(m);
    }
  }
});
child.stderr.on('data', (c) => process.stderr.write(`[acp stderr] ${c}`));

const wait = (id, ms = 60000) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(null), ms);
  pending.set(id, (m) => { clearTimeout(t); resolve(m); });
});

const t0 = Date.now();
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } } });
const init = await wait(1);
console.log('initialize:', init ? 'OK' : 'TIMEOUT');

send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: CWD, mcpServers: [] } });
const sess = await wait(2, 90000);
console.log('session/new:', sess ? 'OK' : 'TIMEOUT');
if (sess?.error) console.log('  error:', JSON.stringify(sess.error));
const sessionId = sess?.result?.sessionId;
console.log('  sessionId:', sessionId ?? '(none)');
if (sess?.result?.configOptions) {
  console.log('  configOptions:', JSON.stringify(sess.result.configOptions).slice(0, 400));
}
if (!sessionId) { child.kill(); process.exit(1); }

send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: PROMPT }] } });
const done = await wait(3, 180000);
console.log('session/prompt:', done ? 'OK' : 'TIMEOUT');
if (done?.error) console.log('  error:', JSON.stringify(done.error));

const text = updates
  .filter((u) => u?.sessionUpdate === 'agent_message_chunk' || u?.sessionUpdate === 'agentMessageChunk')
  .map((u) => u?.content?.text ?? '')
  .join('');
console.log('elapsedMs:', Date.now() - t0);
console.log('updateKinds:', [...new Set(updates.map((u) => u?.sessionUpdate))].join(', '));
console.log('ANSWER:', JSON.stringify(text));

try { send({ jsonrpc: '2.0', id: 4, method: 'session/close', params: { sessionId } }); await wait(4, 15000); } catch { /* ignore */ }
child.kill();
