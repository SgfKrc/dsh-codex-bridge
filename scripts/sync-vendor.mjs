#!/usr/bin/env node
/**
 * 从上游 `reasonix-codex-bridge` 同步本仓库 vendor 进来的运行时与测试。
 *
 * 用法：
 *   node scripts/sync-vendor.mjs --check                     # 校验本地 vendor 文件与 VENDOR.json 记录一致
 *   node scripts/sync-vendor.mjs --check --upstream <dir>    # 再与上游目录逐文件比对，报告漂移
 *   node scripts/sync-vendor.mjs --update [--upstream <dir>] # 从上游复制并重写 VENDOR.json
 *
 * `--upstream` 默认取同级的 `../reasonix-codex-bridge`。本脚本自身不属于 vendor 内容，
 * 同步时不会被覆盖。
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = path.join(HERE, 'VENDOR.json');

/** vendor 覆盖的目录/文件（相对本仓库根）。scripts/ 只取下面白名单里的两个。 */
const VENDOR_DIRS = ['src', 'test', 'prompts'];
const VENDOR_FILES = ['LICENSE'];
const VENDOR_SCRIPT_FILES = ['scripts/check-readme-links.mjs', 'scripts/acp-acceptance.mjs'];

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function upstreamCommit(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function listRelative(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(dir, full).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return out;
}

function readManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    console.error(`VENDOR.json not found at ${MANIFEST_PATH}`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
}

function expectedFiles(manifest) {
  return Object.keys(manifest.files).sort();
}

const args = process.argv.slice(2);
const mode = args.includes('--update') ? 'update' : args.includes('--check') ? 'check' : null;
const upstreamArgIndex = args.indexOf('--upstream');
const upstream = path.resolve(
  HERE,
  upstreamArgIndex >= 0 && args[upstreamArgIndex + 1]
    ? args[upstreamArgIndex + 1]
    : path.join('..', 'reasonix-codex-bridge'),
);

if (!mode) {
  console.error('usage: node scripts/sync-vendor.mjs --check|--update [--upstream <dir>]');
  process.exit(2);
}

if (mode === 'update') {
  if (!existsSync(upstream)) {
    console.error(`upstream not found: ${upstream}`);
    process.exit(2);
  }
  const previous = existsSync(MANIFEST_PATH) ? readManifest() : { files: {} };
  const files = {};
  for (const dir of VENDOR_DIRS) {
    const source = path.join(upstream, dir);
    if (!existsSync(source)) {
      console.error(`upstream is missing ${dir}/`);
      process.exit(2);
    }
    for (const rel of listRelative(source)) {
      const targetRel = `${dir}/${rel}`;
      const target = path.join(HERE, targetRel);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(source, rel), target);
      files[targetRel] = sha256(target);
    }
  }
  for (const rel of [...VENDOR_FILES, ...VENDOR_SCRIPT_FILES]) {
    const source = path.join(upstream, rel);
    if (!existsSync(source)) {
      console.error(`upstream is missing ${rel}`);
      process.exit(2);
    }
    const target = path.join(HERE, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
    files[rel] = sha256(target);
  }
  const removed = Object.keys(previous.files ?? {}).filter((rel) => !(rel in files));
  const manifest = {
    upstream: {
      repository: 'https://github.com/SgfKrc/reasonix-codex-bridge',
      commit: upstreamCommit(upstream),
      path: path.relative(HERE, upstream).split(path.sep).join('/'),
    },
    syncedAt: new Date().toISOString(),
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
  };
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`updated ${Object.keys(files).length} vendored file(s) from ${manifest.upstream.commit ?? upstream}`);
  if (removed.length) console.log(`note: upstream no longer ships ${removed.join(', ')} (left in place — delete manually)`);
  process.exit(0);
}

// --check
const manifest = readManifest();
let drift = 0;
for (const rel of expectedFiles(manifest)) {
  const local = path.join(HERE, rel);
  if (!existsSync(local)) {
    console.log(`MISSING  ${rel}`);
    drift++;
    continue;
  }
  const actual = sha256(local);
  if (actual !== manifest.files[rel]) {
    console.log(`MODIFIED ${rel}`);
    drift++;
  }
}
if (drift === 0) console.log(`local vendor matches VENDOR.json (${expectedFiles(manifest).length} files)`);
else console.log(`${drift} local file(s) diverged from VENDOR.json`);

if (existsSync(upstream)) {
  let upstreamDrift = 0;
  for (const rel of expectedFiles(manifest)) {
    const source = path.join(upstream, rel);
    if (!existsSync(source)) {
      console.log(`UPSTREAM REMOVED  ${rel}`);
      upstreamDrift++;
      continue;
    }
    if (sha256(source) !== manifest.files[rel]) {
      console.log(`UPSTREAM CHANGED  ${rel}`);
      upstreamDrift++;
    }
  }
  const head = upstreamCommit(upstream);
  if (head && manifest.upstream.commit && head !== manifest.upstream.commit) {
    console.log(`upstream HEAD moved: ${manifest.upstream.commit.slice(0, 8)} -> ${head.slice(0, 8)}`);
  }
  console.log(upstreamDrift === 0
    ? `upstream matches the recorded commit snapshot (${manifest.upstream.commit?.slice(0, 8)})`
    : `${upstreamDrift} file(s) differ from upstream — run --update to re-vendor`);
  if (drift || upstreamDrift) process.exit(1);
} else {
  console.log(`(upstream not found at ${upstream}; skipped comparison)`);
  if (drift) process.exit(1);
}
