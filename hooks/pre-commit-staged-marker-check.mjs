#!/usr/bin/env node
// git pre-commit hook on ~/.claude: blocks commits whose staged handoff-*.md
// files contain ownership markers from more than one session_id.
//
// Backstops the named-file convention in session-handoff-mandatory.md.
// When `git add -A` accidentally sweeps up another session's uncommitted
// handoff, this catches it before the misleading attribution lands.
//
// Scope: handoff-*.md under projects/*/memory/ (incl. handoff-archive/).
// Files without a marker are skipped (legacy handoffs predate the convention).
// Bypass: `touch /tmp/.claude-staged-marker-bypass && git commit ...` (consumed).
// Fails open on any internal error.

import { existsSync, unlinkSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOOK_LOG = join(homedir(), '.claude', 'hook-log.jsonl');
const BYPASS_FLAG = '/tmp/.claude-staged-marker-bypass';
const MARKER_RE = /^<!--\s*claude-session:\s*(\S+)\s*-->/;
const HANDOFF_PATH_RE = /^projects\/[^/]+\/memory\/(handoff-archive\/)?handoff-[a-z0-9-]+\.md$/;

function log(entry) {
  try {
    appendFileSync(HOOK_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch {}
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function stagedHandoffPaths() {
  // ACMR = added | copied | modified | renamed. Skip D (deleted) since the staged
  // blob is gone. Pure renames with content carry over the marker; reading the new
  // path's :<path> blob yields the same marker, so they're handled.
  const out = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
  return out.split('\n').filter((p) => p && HANDOFF_PATH_RE.test(p));
}

function markerForStagedPath(path) {
  // Read the STAGED blob, not the working tree, so post-stage edits or
  // unrelated working-tree state can't fool the check.
  let firstLine = '';
  try {
    firstLine = git(['show', `:${path}`]).split('\n')[0] ?? '';
  } catch {
    return null;
  }
  const m = firstLine.match(MARKER_RE);
  return m ? m[1] : null;
}

function main() {
  if (existsSync(BYPASS_FLAG)) {
    try { unlinkSync(BYPASS_FLAG); } catch {}
    log({ event: 'staged-marker-bypass' });
    process.exit(0);
  }

  const paths = stagedHandoffPaths();
  if (paths.length === 0) process.exit(0);

  const sessionToFiles = new Map();
  for (const p of paths) {
    const sid = markerForStagedPath(p);
    if (!sid) continue;
    if (!sessionToFiles.has(sid)) sessionToFiles.set(sid, []);
    sessionToFiles.get(sid).push(p);
  }

  if (sessionToFiles.size <= 1) process.exit(0);

  const sessions = [...sessionToFiles.entries()];
  const lines = [];
  lines.push(`pre-commit blocked: staged set contains markers from ${sessions.length} sessions.`);
  lines.push('');
  for (const [sid, files] of sessions) {
    lines.push(`Session ${sid.slice(0, 8)} (${files.length} file${files.length === 1 ? '' : 's'}):`);
    for (const f of files) lines.push(`  ${f}`);
    lines.push('');
  }
  lines.push('This usually means `git add -A` swept up another session\'s uncommitted handoff.');
  lines.push('Recover by:');
  lines.push('  1. `git restore --staged <foreign-files>` to unstage the contaminating files.');
  lines.push('  2. Re-run `git commit`.');
  lines.push('');
  lines.push('Override (rare; e.g., maintenance commit touching multiple sessions\' archives):');
  lines.push('  touch /tmp/.claude-staged-marker-bypass && git commit ...');

  process.stderr.write(lines.join('\n') + '\n');
  log({
    event: 'staged-marker-block',
    sessionCount: sessions.length,
    sessions: sessions.map(([sid, files]) => ({ sid, count: files.length })),
  });
  process.exit(1);
}

try {
  main();
} catch (e) {
  try { log({ event: 'staged-marker-error', error: e?.message || String(e) }); } catch {}
  process.exit(0);
}
