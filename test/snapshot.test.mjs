import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SNAPSHOT_MAX_FILES, restoreSnapshotEntries, snapshotWriteBaseline } from '../src/snapshot.mjs';

function tempRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'rxb-snapshot-'));
}

test('snapshotWriteBaseline captures content and restore writes it back verbatim', () => {
  const root = tempRoot();
  try {
    writeFileSync(path.join(root, 'allowed.txt'), 'user edit', 'utf8');
    const snapshot = snapshotWriteBaseline(root, [{ path: 'allowed.txt', status: ' M' }], (value) => value === 'allowed.txt');

    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.entries[0].kind, 'file');
    assert.equal(snapshot.entries[0].sha256.length, 64);

    writeFileSync(path.join(root, 'allowed.txt'), 'worker overwrite', 'utf8');
    const restored = restoreSnapshotEntries(root, snapshot.entries);
    assert.deepEqual([...restored.handled], ['allowed.txt']);
    assert.equal(restored.errors.length, 0);
    assert.equal(readFileSync(path.join(root, 'allowed.txt'), 'utf8'), 'user edit');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('snapshotWriteBaseline skips disallowed paths and records absent ones', () => {
  const root = tempRoot();
  try {
    const snapshot = snapshotWriteBaseline(
      root,
      [{ path: 'outside.txt', status: ' M' }, { path: 'gone.txt', status: ' D' }],
      (value) => value === 'gone.txt',
    );

    assert.equal(snapshot.ok, true);
    assert.deepEqual(snapshot.entries.map((entry) => entry.path), ['gone.txt']);
    assert.equal(snapshot.entries[0].kind, 'absent');

    writeFileSync(path.join(root, 'gone.txt'), 'worker recreated it', 'utf8');
    const restored = restoreSnapshotEntries(root, snapshot.entries);
    assert.deepEqual([...restored.handled], ['gone.txt']);
    // A path that was absent in the baseline is removed again by the restore.
    assert.throws(() => readFileSync(path.join(root, 'gone.txt'), 'utf8'), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('snapshotWriteBaseline fails closed over the file-count limit', () => {
  const root = tempRoot();
  try {
    const entries = Array.from({ length: SNAPSHOT_MAX_FILES + 1 }, (_value, index) => ({ path: `f${index}.txt`, status: ' M' }));
    const snapshot = snapshotWriteBaseline(root, entries, () => true);

    assert.equal(snapshot.ok, false);
    assert.match(snapshot.error, /write-baseline limit/);
    assert.deepEqual(snapshot.entries, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('snapshotWriteBaseline fails closed on directories', () => {
  const root = tempRoot();
  try {
    mkdirSync(path.join(root, 'dir.txt'));
    const snapshot = snapshotWriteBaseline(root, [{ path: 'dir.txt', status: '??' }], () => true);

    assert.equal(snapshot.ok, false);
    assert.match(snapshot.error, /not a regular file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restoreSnapshotEntries removes entries that were absent in the baseline', () => {
  const root = tempRoot();
  try {
    writeFileSync(path.join(root, 'new.txt'), 'created by worker', 'utf8');
    const restored = restoreSnapshotEntries(root, [{ path: 'new.txt', kind: 'absent' }]);

    assert.deepEqual([...restored.handled], ['new.txt']);
    assert.equal(restored.errors.length, 0);
    assert.throws(() => readFileSync(path.join(root, 'new.txt'), 'utf8'), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
