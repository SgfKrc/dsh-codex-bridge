import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const SNAPSHOT_SCHEMA = 'qlh.reasonix.write-baseline.v1';
export const SNAPSHOT_MAX_FILES = 64;
export const SNAPSHOT_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const SNAPSHOT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

function entryKey(value) {
  return typeof value === 'string' ? value.replaceAll('\\', '/').replace(/^\.\//, '') : '';
}

/**
 * Snapshot the pre-existing dirty state of allowed paths before a
 * `cleanTreePolicy: "snapshot"` implement call.
 *
 * The snapshot lets a later rollback restore what the user had in the worktree
 * (including uncommitted edits) instead of `git restore`-ing the path to HEAD,
 * which is what makes continuous writes safe under a dirty tree. Fail-closed:
 * anything unreadable, non-regular, or over the file/total budget refuses the
 * whole call with an actionable message.
 */
export function snapshotWriteBaseline(root, entries, isAllowed) {
  const candidates = [];
  const seen = new Set();
  for (const entry of entries ?? []) {
    const key = entryKey(entry?.path);
    if (!key || seen.has(key) || typeof isAllowed !== 'function' || !isAllowed(entry.path)) continue;
    seen.add(key);
    candidates.push({ path: key, status: String(entry.status ?? '') });
  }
  if (!candidates.length) return { ok: true, entries: [], error: '' };
  if (candidates.length > SNAPSHOT_MAX_FILES) {
    return { ok: false, entries: [], error: `${candidates.length} pre-existing change(s) under allowedPaths exceed the ${SNAPSHOT_MAX_FILES}-file write-baseline limit; commit or stash them first` };
  }
  const snapshot = [];
  let totalBytes = 0;
  for (const candidate of candidates) {
    const absolute = path.join(root, candidate.path);
    let stats;
    try {
      stats = statSync(absolute);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        snapshot.push({ path: candidate.path, kind: 'absent' });
        continue;
      }
      return { ok: false, entries: [], error: `cannot snapshot ${candidate.path}: ${error.message}` };
    }
    if (!stats.isFile()) return { ok: false, entries: [], error: `cannot snapshot ${candidate.path}: not a regular file` };
    if (stats.size > SNAPSHOT_MAX_FILE_BYTES) return { ok: false, entries: [], error: `cannot snapshot ${candidate.path}: exceeds the per-file write-baseline limit` };
    totalBytes += stats.size;
    if (totalBytes > SNAPSHOT_MAX_TOTAL_BYTES) {
      return { ok: false, entries: [], error: 'pre-existing change(s) exceed the total write-baseline budget; commit or stash them first' };
    }
    let content;
    try {
      content = readFileSync(absolute);
    } catch (error) {
      return { ok: false, entries: [], error: `cannot snapshot ${candidate.path}: ${error.message}` };
    }
    snapshot.push({
      path: candidate.path,
      kind: 'file',
      sha256: createHash('sha256').update(content).digest('hex'),
      content: content.toString('base64'),
    });
  }
  return { ok: true, entries: snapshot, error: '' };
}

/**
 * Restore snapshot entries verbatim (base64 payload for files, removal for
 * `absent` entries). Returns the handled path set so the caller can exclude
 * them from the git-based rollback path.
 */
export function restoreSnapshotEntries(root, snapshotEntries) {
  const handled = new Set();
  const errors = [];
  for (const entry of snapshotEntries ?? []) {
    const key = entryKey(entry?.path);
    if (!key) continue;
    const absolute = path.join(root, key);
    try {
      if (entry.kind === 'absent') {
        rmSync(absolute, { recursive: true, force: true });
        handled.add(key);
        continue;
      }
      if (entry.kind !== 'file' || typeof entry.content !== 'string') continue;
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, Buffer.from(entry.content, 'base64'));
      handled.add(key);
    } catch (error) {
      errors.push(`restore ${key}: ${error.message}`);
    }
  }
  return { handled, errors };
}

export function rollbackRecordSnapshot(value) {
  if (!value || !Array.isArray(value)) return [];
  return value.filter((entry) => entry && typeof entry.path === 'string');
}
