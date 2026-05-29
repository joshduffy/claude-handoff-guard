// node --test: black-box tests for handoff-write-guard.mjs
// Spawns the hook with crafted stdin payloads and asserts the decision.
// Sets HANDOFF_GUARD_NO_NOTIFY=1 so the terminal-notifier path stays quiet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'handoff-write-guard.mjs');

// Build a temp tree containing the path segment the hook keys on:
// .../projects/<proj>/memory/<file>
function freshMemoryDir() {
  const root = mkdtempSync(join(tmpdir(), 'handoff-guard-'));
  const memDir = join(root, 'projects', 'testproj', 'memory');
  mkdirSync(memDir, { recursive: true });
  return { root, memDir };
}

function run(payload) {
  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, HANDOFF_GUARD_NO_NOTIFY: '1', HANDOFF_GUARD_BYPASS: '' },
  });
  let out = null;
  const trimmed = (res.stdout || '').trim();
  if (trimmed) {
    try { out = JSON.parse(trimmed); } catch { out = { raw: trimmed }; }
  }
  return { code: res.status, out };
}

const SID = 'sess-aaaaaaaa-1111';
const OTHER = 'sess-bbbbbbbb-2222';
const marker = (id) => `<!-- claude-session: ${id} -->`;

test('grammar reject: bare handoff-main.md blocks', () => {
  const { memDir } = freshMemoryDir();
  const { out } = run({
    tool_name: 'Write',
    session_id: SID,
    cwd: '/tmp/testproj',
    tool_input: { file_path: join(memDir, 'handoff-main.md'), content: `${marker(SID)}\nx` },
  });
  assert.equal(out?.decision, 'block');
  assert.match(out.reason, /grammar/i);
});

test('own-marker new write passes clean', () => {
  const { memDir } = freshMemoryDir();
  const { code, out } = run({
    tool_name: 'Write',
    session_id: SID,
    cwd: '/tmp/testproj',
    tool_input: { file_path: join(memDir, 'handoff-main-auth-refactor.md'), content: `${marker(SID)}\nbody` },
  });
  assert.equal(code, 0);
  assert.equal(out, null); // no block, no systemMessage (no siblings)
});

test('missing content marker on Write blocks', () => {
  const { memDir } = freshMemoryDir();
  const { out } = run({
    tool_name: 'Write',
    session_id: SID,
    cwd: '/tmp/testproj',
    tool_input: { file_path: join(memDir, 'handoff-main-auth-refactor.md'), content: 'no marker here\nbody' },
  });
  assert.equal(out?.decision, 'block');
  assert.match(out.reason, /marker/i);
});

test('foreign on-disk marker blocks Write and omits the touch-recipe (fix 3)', () => {
  const { memDir } = freshMemoryDir();
  const f = join(memDir, 'handoff-main-auth-refactor.md');
  writeFileSync(f, `${marker(OTHER)}\nprior work`);
  const { out } = run({
    tool_name: 'Write',
    session_id: SID,
    cwd: '/tmp/testproj',
    tool_input: { file_path: f, content: `${marker(SID)}\nmine` },
  });
  assert.equal(out?.decision, 'block');
  assert.match(out.reason, /Foreign session/);
  assert.match(out.reason, /Prior owner: session `sess-bbb`/); // prior owner short id (slice 0,8) surfaced
  assert.doesNotMatch(out.reason, /touch \/tmp\/handoff-guard-bypass/); // fix 3: no self-defeat recipe
});

test('edit on legacy markerless file blocks', () => {
  const { memDir } = freshMemoryDir();
  const f = join(memDir, 'handoff-main-auth-refactor.md');
  writeFileSync(f, 'legacy content, no marker\n');
  const { out } = run({
    tool_name: 'Edit',
    session_id: SID,
    cwd: '/tmp/testproj',
    tool_input: { file_path: f },
  });
  assert.equal(out?.decision, 'block');
  assert.match(out.reason, /legacy/i);
});

test('bash redirect to unowned handoff blocks', () => {
  const { memDir } = freshMemoryDir();
  const f = join(memDir, 'handoff-main-auth-refactor.md');
  const { out } = run({
    tool_name: 'Bash',
    session_id: SID,
    cwd: '/tmp/testproj',
    tool_input: { command: `echo x >> ${f}` },
  });
  assert.equal(out?.decision, 'block');
  assert.match(out.reason, /redirect/i);
});

test('sibling-overlap emits a non-blocking warn', () => {
  const { memDir } = freshMemoryDir();
  // existing sibling: first two non-stopword topic tokens = search, index
  writeFileSync(join(memDir, 'handoff-feat-search-index-v1.md'), `${marker(SID)}\nx`);
  const { code, out } = run({
    tool_name: 'Write',
    session_id: SID,
    cwd: '/tmp/testproj',
    tool_input: { file_path: join(memDir, 'handoff-main-search-index-rewrite.md'), content: `${marker(SID)}\nbody` },
  });
  assert.equal(code, 0);
  assert.match(out?.systemMessage ?? '', /overlap/i);
});

test('non-handoff path is ignored', () => {
  const { root } = freshMemoryDir();
  const { code, out } = run({
    tool_name: 'Write',
    session_id: SID,
    cwd: '/tmp/testproj',
    tool_input: { file_path: join(root, 'src', 'index.ts'), content: 'whatever' },
  });
  assert.equal(code, 0);
  assert.equal(out, null);
});
