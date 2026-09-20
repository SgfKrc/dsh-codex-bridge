import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CHECKPOINT_SCHEMA = 'qlh.reasonix.checkpoint.v1';
const CHECKPOINT_ID = /^[0-9a-f-]{36}$/u;
const MAX_CHECKPOINT_BYTES = 512 * 1024;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

export function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

export function defaultCheckpointDir() {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'reasonix-codex-bridge', 'checkpoints');
  const stateRoot = process.env.XDG_STATE_HOME?.trim() || path.join(os.homedir(), '.local', 'state');
  return path.join(stateRoot, 'reasonix-codex-bridge', 'checkpoints');
}

export function resolveCheckpointDir(configured) {
  const value = typeof configured === 'string' ? configured.trim() : '';
  return path.resolve(value || defaultCheckpointDir());
}

export function isCheckpointId(value) {
  return typeof value === 'string' && CHECKPOINT_ID.test(value);
}

function checkpointPath(directory, id) {
  if (!isCheckpointId(id)) throw new Error('invalid checkpoint id');
  return path.join(directory, `${id}.json`);
}

function ensureDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}

export function writeCheckpoint(directory, data) {
  ensureDirectory(directory);
  const id = isCheckpointId(data?.id) ? data.id : randomUUID();
  const status = data?.status === 'consumed' ? 'consumed' : 'ready';
  const record = { ...data, id, schema: CHECKPOINT_SCHEMA, status };
  const target = checkpointPath(directory, id);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, target);
  return record;
}

export function readCheckpoint(directory, id) {
  if (!isCheckpointId(id)) return { ok: false, error: 'invalid checkpoint id' };
  const target = checkpointPath(directory, id);
  let stats;
  try { stats = statSync(target); } catch (error) { return { ok: false, error: error?.code === 'ENOENT' ? 'checkpoint not found' : `checkpoint is not readable: ${error.message}` }; }
  if (!stats.isFile()) return { ok: false, error: 'checkpoint is not a regular file' };
  if (stats.size > MAX_CHECKPOINT_BYTES) return { ok: false, error: 'checkpoint exceeds the size limit' };
  let value;
  try { value = JSON.parse(readFileSync(target, 'utf8')); } catch { return { ok: false, error: 'checkpoint is not valid JSON' }; }
  if (!value || value.schema !== CHECKPOINT_SCHEMA || value.id !== id || !['ready', 'consumed'].includes(value.status)) return { ok: false, error: 'checkpoint schema is invalid' };
  return { ok: true, value, path: target };
}

export function consumeCheckpoint(directory, checkpoint) {
  ensureDirectory(directory);
  const target = checkpointPath(directory, checkpoint.id);
  const claim = `${target}.claim`;
  try {
    writeFileSync(claim, `${process.pid}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    throw new Error(error?.code === 'EEXIST' ? 'checkpoint is already being consumed' : `checkpoint claim failed: ${error.message}`);
  }
  try {
    return writeCheckpoint(directory, { ...checkpoint, status: 'consumed', consumedAt: new Date().toISOString() });
  } finally {
    try { unlinkSync(claim); } catch { /* preserve the consumed record if cleanup is interrupted */ }
  }
}

export function countReadyCheckpoints(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.json') && isCheckpointId(entry.name.slice(0, -5)))
      .map((entry) => readCheckpoint(directory, entry.name.slice(0, -5))).filter((result) => result.ok && result.value.status === 'ready').length;
  } catch { return 0; }
}
