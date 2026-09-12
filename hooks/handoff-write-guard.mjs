#!/usr/bin/env node
// PreToolUse hook: prevents cross-session handoff overwrites.
// Fires on Write|Edit|Bash. Fails open on any internal error.

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';

const HOOK_LOG = join(homedir(), '.claude', 'hook-log.jsonl');
const STOPWORDS = new Set(['fix', 'feat', 'chore', 'docs', 'refactor', 'test', 'main', 'master', 'the', 'and', 'for', 'a']);

const HANDOFF_PATH_RE = /\/projects\/[^/]+\/memory\/(handoff-[a-z0-9-]+\.md)$/;
const VALID_GRAMMAR = /^handoff-[a-z0-9]+-[a-z0-9]+(-[a-z0-9]+)+\.md$/;
const MARKER_RE = /^<!--\s*claude-session:\s*(\S+)\s*-->/;
const BASH_WRITE_RE = /(>{1,2}|tee\b|sed\s+-i)\s*[^|;&]*?(\S*?\/projects\/[^\s|;&"']+\/memory\/handoff-[a-z0-9-]+\.md)/;

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

function notify(subtitle, message, sessionShort) {
  // Optional desktop notification on block. No-op by default. Wire your own
  // notifier here (e.g. terminal-notifier on macOS, notify-send on Linux).
  // Set HANDOFF_GUARD_NO_NOTIFY=1 to force-skip even if you add one.
  if (process.env.HANDOFF_GUARD_NO_NOTIFY === '1') return;
}

function block(reason, project, sessionShort) {
  notify(project, reason.split('\n')[0].slice(0, 80), sessionShort);
  // Claude Code expects "block"; gemini CLI uses "deny". Use Claude Code's
  // shape since this is the active client. If gemini support is needed later,
  // dispatch on a runtime-detectable signal rather than guessing.
  console.log(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

function commitDate(dir, filename) {
  // Committer date (YYYY-MM-DD) of the file's last commit. More reliable than
  // mtime, which git checkout/stash rewrite. Null when untracked or no git.
  try {
    const out = execFileSync('git', ['-C', dir, 'log', '-1', '--format=%cs', '--', filename], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function topicTokens(filename) {
  const m = filename.match(/^handoff-(.+)\.md$/);
  if (!m) return [];
  return m[1].split('-').filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

function findOverlap(filename, dir) {
  const targetTokens = topicTokens(filename).slice(0, 2);
  if (targetTokens.length < 2) return null;
  const targetKey = targetTokens.join('-');
  let entries = [];
  try {
    entries = readdirSync(dir).filter(
      (f) => f !== filename && f.startsWith('handoff-') && f.endsWith('.md')
    );
  } catch {
    return null;
  }
  for (const e of entries) {
    const eTokens = topicTokens(e).slice(0, 2);
    if (eTokens.length >= 2 && eTokens.join('-') === targetKey) return e;
  }
  return null;
}

async function main() {
  if (process.env.HANDOFF_GUARD_BYPASS === '1') {
    log({ event: 'handoff-guard-env-bypass' });
    process.exit(0);
  }

  const raw = await readStdin();
  const input = JSON.parse(raw);

  const tool = input.tool_name ?? '';
  const sessionId = input.session_id ?? 'unknown';
  const sessionShort = sessionId.slice(0, 8);
  const cwd = input.cwd ?? '';
  const project = basename(cwd) || 'unknown';

  let targetPath = null;
  let newContent = null;
  let isWrite = false;
  let isEdit = false;

  // Accept BOTH Claude Code schema (Write/Edit/Bash) and gemini CLI schema
  // (write_file/replace/run_shell_command). Migrating one without the other
  // silently disables the hook for whichever client is on the missing schema.
  if (tool === 'write_file' || tool === 'Write') {
    targetPath = input.tool_input?.file_path ?? '';
    newContent = input.tool_input?.content ?? '';
    isWrite = true;
  } else if (tool === 'replace' || tool === 'Edit') {
    targetPath = input.tool_input?.file_path ?? '';
    isEdit = true;
  } else if (tool === 'run_shell_command' || tool === 'Bash') {
    const cmd = input.tool_input?.command ?? '';
    const m = cmd.match(BASH_WRITE_RE);
    if (m) targetPath = m[2];
  }

  if (!targetPath) process.exit(0);
  const pathMatch = targetPath.match(HANDOFF_PATH_RE);
  if (!pathMatch) process.exit(0);
  const filename = pathMatch[1];
  const dir = dirname(targetPath);

  // Manual bypass flag (consume on use)
  const bypassFlag = `/tmp/handoff-guard-bypass-${filename}`;
  if (existsSync(bypassFlag)) {
    try { unlinkSync(bypassFlag); } catch {}
    log({ event: 'handoff-guard-bypass', sessionId, targetPath });
    process.exit(0);
  }

  // Check 1: filename grammar
  if (!VALID_GRAMMAR.test(filename)) {
    const reason = `Handoff filename rejected by grammar: \`${filename}\`.

Required: \`handoff-<branch>-<topic-of-2-or-more-tokens>.md\`. Bare \`handoff-main.md\` and \`handoff-master.md\` are forbidden: parallel sessions on \`main\` collide on a single file and silently overwrite each other.

Pick a topic suffix that names the work, e.g.:
  handoff-main-auth-refactor.md
  handoff-feat-search-index.md
  handoff-main-payments-webhook.md

Override: \`touch ${bypassFlag}\` then retry.`;
    log({ event: 'handoff-guard-block', reason: 'grammar', sessionId, targetPath, filename });
    block(reason, project, sessionShort);
  }

  // Read on-disk marker if file exists
  let onDiskMarker = null;
  let mtime = null;
  if (existsSync(targetPath)) {
    try {
      const firstLine = readFileSync(targetPath, 'utf8').split('\n')[0] ?? '';
      const m = firstLine.match(MARKER_RE);
      if (m) onDiskMarker = m[1];
      mtime = statSync(targetPath).mtime.toISOString();
    } catch {}
  }

  // Foreign on-disk marker → block (Write/Edit/Bash all hit this)
  if (onDiskMarker && onDiskMarker !== sessionId) {
    const contSuggestion = filename.replace(/\.md$/, '-cont.md');
    const lastEdit = commitDate(dir, filename) ?? `mtime ${mtime}`;
    const reason = `Foreign session owns \`${filename}\`.

Prior owner: session \`${onDiskMarker.slice(0, 8)}\` (last commit ${lastEdit}).
Your session: \`${sessionShort}\`.

This is another session's running record. Do NOT overwrite it. To proceed:
1. Pick a new topic-suffixed filename, e.g., \`${contSuggestion}\`, and reference the prior file in its "What was done" section. This is the cross-device / concurrent-session path.
2. Only if you have CONFIRMED the prior handoff is stale (its branch is merged or gone, or its last commit predates the work it describes), archive it: \`mkdir -p ${dir}/handoff-archive && mv ${targetPath} ${dir}/handoff-archive/\`, then retry. Verify staleness first; do not assume it.`;
    log({ event: 'handoff-guard-block', reason: 'foreign-marker', sessionId, targetPath, priorSession: onDiskMarker });
    block(reason, project, sessionShort);
  }

  // Edit on a file with no marker (legacy) → block
  if (isEdit && !onDiskMarker) {
    const reason = `Edit on legacy handoff (no ownership marker): \`${filename}\`.

This file predates the handoff-guard convention. To safely take ownership:
1. Read the existing content.
2. Use Write (not Edit) to replace the file with content beginning with \`<!-- claude-session: ${sessionId} -->\` as line 1.

Or override: \`touch ${bypassFlag}\` and retry the Edit.`;
    log({ event: 'handoff-guard-block', reason: 'edit-legacy', sessionId, targetPath });
    block(reason, project, sessionShort);
  }

  // Write must include matching marker as line 1 of new content
  if (isWrite) {
    const firstLine = String(newContent).split('\n')[0] ?? '';
    const m = firstLine.match(MARKER_RE);
    const contentMarker = m ? m[1] : null;
    if (contentMarker !== sessionId) {
      const reason = `Handoff write missing or wrong ownership marker.

Your session_id: \`${sessionId}\`.

Prepend exactly this as line 1:
  <!-- claude-session: ${sessionId} -->

Then retry. This marker is what blocks future sessions from silently overwriting your work.

Override: \`touch ${bypassFlag}\` and retry.`;
      log({ event: 'handoff-guard-block', reason: 'missing-marker', sessionId, targetPath, contentMarker });
      block(reason, project, sessionShort);
    }
  }

  // Bash redirect to handoff: only allowed if file exists with our marker (i.e., own update).
  // Must cover BOTH client schemas (Claude Code 'Bash', gemini 'run_shell_command');
  // gating on one silently disables the redirect guard for the other client.
  if ((tool === 'run_shell_command' || tool === 'Bash') && (!onDiskMarker || onDiskMarker !== sessionId)) {
    const reason = `Bash redirect to handoff path is restricted: \`${filename}\`.

Bash redirects can't be inspected for ownership markers. Use Write or Edit instead so the guard can validate.

For scripts that intentionally write handoffs (e.g., the migration script), set \`HANDOFF_GUARD_BYPASS=1\` in the environment.

Override: \`touch ${bypassFlag}\` and retry.`;
    log({ event: 'handoff-guard-block', reason: 'bash-redirect', sessionId, targetPath });
    block(reason, project, sessionShort);
  }

  // Sibling-overlap soft warn (only on new-file Writes that pass marker check)
  if (isWrite && !existsSync(targetPath)) {
    const overlap = findOverlap(filename, dir);
    if (overlap) {
      log({ event: 'handoff-guard-overlap-warn', sessionId, targetPath, overlap });
      console.log(
        JSON.stringify({
          systemMessage: `Sibling-overlap notice: \`${filename}\` shares the first two non-stopword topic tokens with existing \`${overlap}\`. Consider extending the existing handoff or picking a more distinct topic slug. (Write proceeds.)`,
        })
      );
    }
  }

  process.exit(0);
}

main().catch((e) => {
  try { log({ event: 'handoff-guard-error', error: e?.message || String(e) }); } catch {}
  process.exit(0);
});
