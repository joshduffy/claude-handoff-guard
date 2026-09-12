#!/usr/bin/env node
// Stop hook: the "suspenders" for rules/session-handoff.md.
// Once per session, if the project has uncommitted work AND this session owns
// no handoff in the project memory dir, emit a single non-blocking reminder.
//
// Why once-per-session and non-blocking: Stop fires at the END OF EVERY TURN,
// not just at session end. A per-turn warning would nag constantly, and a hard
// block could trap the user. The harness cannot detect "the last turn", so this
// is a nudge, not a gate. True end-of-session discipline still rests on the rule.
// Fails open on any internal error.

import { existsSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK_LOG = join(homedir(), '.claude', 'hook-log.jsonl');
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

// Encode an absolute cwd to its ~/.claude/projects/<encoded>/memory dir name:
// replace /, \, and . with '-'. Matches the harness's own encoding.
function memoryDirFor(cwd) {
  const encoded = cwd.replace(/[/\\.]/g, '-');
  return join(homedir(), '.claude', 'projects', encoded, 'memory');
}

function hasUncommittedWork(cwd) {
  try {
    const out = execFileSync('git', ['-C', cwd, 'status', '--short'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length > 0;
  } catch {
    return false; // not a git repo, or git missing: no signal, stay quiet
  }
}

function ownsAHandoff(memDir, sessionId) {
  let files = [];
  try {
    files = readdirSync(memDir).filter((f) => f.startsWith('handoff-') && f.endsWith('.md'));
  } catch {
    return false;
  }
  for (const f of files) {
    try {
      const first = readFileSync(join(memDir, f), 'utf8').split('\n')[0] ?? '';
      const m = first.match(MARKER_RE);
      if (m && m[1] === sessionId) return true;
    } catch {}
  }
  return false;
}

async function main() {
  const raw = await readStdin();
  const input = JSON.parse(raw);
  const sessionId = input.session_id ?? 'unknown';
  const cwd = input.cwd ?? '';
  if (!cwd) process.exit(0);

  // Once-per-session sentinel: fire at most one reminder.
  const sentinel = join(tmpdir(), `handoff-stop-gate-${sessionId}`);
  if (existsSync(sentinel)) process.exit(0);

  if (!hasUncommittedWork(cwd)) process.exit(0);

  const memDir = memoryDirFor(cwd);
  if (ownsAHandoff(memDir, sessionId)) process.exit(0);

  try { writeFileSync(sentinel, sessionId); } catch {}
  log({ event: 'handoff-stop-gate-nudge', sessionId, cwd });

  console.log(
    JSON.stringify({
      systemMessage:
        'Handoff reminder: this session has uncommitted work and has not written a handoff yet. ' +
        'At a natural breakpoint or before ending, run /handoff so the next session can resume. ' +
        '(Shown once per session.)',
    })
  );
  process.exit(0);
}

main().catch((e) => {
  try { log({ event: 'handoff-stop-gate-error', error: e?.message || String(e) }); } catch {}
  process.exit(0);
});
