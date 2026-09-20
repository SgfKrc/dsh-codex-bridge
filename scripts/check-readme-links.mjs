import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const target = path.resolve(process.argv[2] ?? 'README.md');
const source = readFileSync(target, 'utf8');
const errors = [];
const markdownLink = /!?\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/gu;

function isExternal(value) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(value) || value.startsWith('#');
}

function checkTarget(raw, line) {
  const value = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
  if (isExternal(value)) return;
  const filePart = value.split(/[?#]/u, 1)[0];
  if (!filePart) return;
  let decoded;
  try { decoded = decodeURIComponent(filePart); } catch { errors.push(`${line}: invalid URI encoding in ${value}`); return; }
  if (path.isAbsolute(decoded)) { errors.push(`${line}: absolute local link is not allowed: ${value}`); return; }
  const resolved = path.resolve(path.dirname(target), decoded);
  if (!existsSync(resolved)) errors.push(`${line}: missing local link target ${value}`);
}

for (const match of source.matchAll(markdownLink)) {
  const line = source.slice(0, match.index).split('\n').length;
  checkTarget(match[1], line);
}

if (errors.length) {
  process.stderr.write(`${path.relative(process.cwd(), target)} has broken local links:\n${errors.map((error) => `- ${error}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${path.relative(process.cwd(), target)}: local links OK\n`);
}
