#!/usr/bin/env node
// SessionStart hook: surfaces existing handoffs in the project memory dir so the
// session-start discovery steps in rules/session-handoff.md become a shown
// fact instead of model-discipline. Also flags sibling topic-slug overlaps
// (same first two non-stopword tokens), the concurrent-session awareness case.
// Read-only. Fails open on any internal error.

import { readdirSync, readFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOOK_LOG = join(homedir(), '.claude', 'hook-log.jsonl');
const STOPWORDS = new Set(['fix', 'feat', 'chore', 'docs', 'refactor', 'test', 'main', 'master', 'the', 'and', 'for', 'a']);
const MARKER_RE = /^<!--\s*claude-session:\s*(\S+)\s*-->/;

function readStdin() {
  return new Promise((resolve) => {
    let d = '';
    process.stdin.on('data', (c) => (d += c));
    process.stdin.on('end', () => resolve(d));
  });
}

function log(entry) {
  try {
    appendFileSync(HOOK_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch {}
}

function memoryDirFor(cwd) {
  const encoded = cwd.replace(/[/\\.]/g, '-');
  return join(homedir(), '.claude', 'projects', encoded, 'memory');
}

function topicTokens(filename) {
  const m = filename.match(/^handoff-(.+)\.md$/);
  if (!m) return [];
  return m[1].split('-').filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

function overlapPairs(files) {
  const byKey = new Map();
  for (const f of files) {
    const key = topicTokens(f).slice(0, 2).join('-');
    if (key.split('-').length < 2) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(f);
  }
  return [...byKey.values()].filter((group) => group.length > 1);
}

async function main() {
  const raw = await readStdin();
  const input = JSON.parse(raw);
  const cwd = input.cwd ?? '';
  if (!cwd) process.exit(0);

  const memDir = memoryDirFor(cwd);
  let files = [];
  try {
    files = readdirSync(memDir).filter((f) => f.startsWith('handoff-') && f.endsWith('.md'));
  } catch {
    process.exit(0); // no memory dir yet
  }
  if (files.length === 0) process.exit(0);

  const lines = [`Existing handoffs in this project (${files.length}):`];
  for (const f of files.sort()) {
    let owner = '';
    try {
      const first = readFileSync(join(memDir, f), 'utf8').split('\n')[0] ?? '';
      const m = first.match(MARKER_RE);
      if (m) owner = ` [session ${m[1].slice(0, 8)}]`;
    } catch {}
    lines.push(`  - ${f}${owner}`);
  }

  const overlaps = overlapPairs(files);
  if (overlaps.length > 0) {
    lines.push('');
    lines.push('Topic-slug overlaps (may be related workstreams; confirm before treating as separate):');
    for (const group of overlaps) lines.push(`  - ${group.join(', ')}`);
  }
  lines.push('');
  lines.push('Read the one matching your branch + intended workstream as your primary handoff. Siblings are awareness-only; do not adopt their tasks.');

  log({ event: 'handoff-session-start-surfaced', cwd, count: files.length, overlaps: overlaps.length });
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: lines.join('\n'),
      },
    })
  );
  process.exit(0);
}

main().catch((e) => {
  try { log({ event: 'handoff-session-start-error', error: e?.message || String(e) }); } catch {}
  process.exit(0);
});
