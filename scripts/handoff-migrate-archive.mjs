#!/usr/bin/env node
// One-time migration: move every existing handoff-*.md across all per-project
// memory dirs into a sibling handoff-archive/ subdir.

import { readdirSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const SELF_PID = String(process.pid);

function activeCCSessionCount() {
  // Count actual Claude Code sessions (bare `claude` binary + VSCode extension),
  // not the macOS desktop app's helper processes or unrelated claude-named scripts.
  try {
    const out = execFileSync('pgrep', ['-fl', 'claude'], { encoding: 'utf8' });
    return out
      .split('\n')
      .filter(Boolean)
      .filter((line) => !line.startsWith(`${SELF_PID} `))
      .filter((line) => !/handoff-migrate/.test(line))
      .filter((line) => {
        const cmd = line.replace(/^\d+\s+/, '');
        // Bare `claude` binary (CC CLI sessions)
        if (cmd === 'claude') return true;
        // VSCode extension's claude binary
        if (/anthropic\.claude-code-.*\/claude\b/.test(cmd)) return true;
        return false;
      })
      .length;
  } catch {
    return 0;
  }
}

function listActiveCCSessions() {
  try {
    const out = execFileSync('pgrep', ['-fl', 'claude'], { encoding: 'utf8' });
    return out
      .split('\n')
      .filter(Boolean)
      .filter((line) => !line.startsWith(`${SELF_PID} `))
      .filter((line) => !/handoff-migrate/.test(line))
      .filter((line) => {
        const cmd = line.replace(/^\d+\s+/, '');
        if (cmd === 'claude') return true;
        if (/anthropic\.claude-code-.*\/claude\b/.test(cmd)) return true;
        return false;
      })
      .map((line) => {
        const m = line.match(/^(\d+)\s+(.*)$/);
        if (!m) return line;
        const cmd = m[2].length > 80 ? m[2].slice(0, 77) + '...' : m[2];
        return `  ${m[1]}  ${cmd}`;
      });
  } catch {
    return [];
  }
}

const MARKER_RE = /^<!--\s*claude-session:\s*\S+\s*-->/;

function hasOwnershipMarker(filepath) {
  try {
    const firstLine = readFileSync(filepath, 'utf8').split('\n')[0] ?? '';
    return MARKER_RE.test(firstLine);
  } catch {
    return false;
  }
}

function findHandoffDirs() {
  const result = [];
  for (const proj of readdirSync(PROJECTS_DIR)) {
    const memDir = join(PROJECTS_DIR, proj, 'memory');
    if (!existsSync(memDir)) continue;
    let allFiles = [];
    try {
      allFiles = readdirSync(memDir).filter(
        (f) => f.startsWith('handoff-') && f.endsWith('.md')
      );
    } catch {
      continue;
    }
    // Only migrate files WITHOUT an ownership marker (stale, pre-rule legacy).
    // Marker-stamped files are current sessions' work; leave them in primary.
    const stale = [];
    const kept = [];
    for (const f of allFiles) {
      if (hasOwnershipMarker(join(memDir, f))) kept.push(f);
      else stale.push(f);
    }
    if (stale.length === 0 && kept.length === 0) continue;
    result.push({ proj, memDir, files: stale, kept });
  }
  return result;
}

function gitMv(src, dst) {
  // Try git mv first; fall back to plain mv if file isn't tracked.
  const repoRoot = join(homedir(), '.claude');
  const gitResult = spawnSync('git', ['mv', src, dst], { cwd: repoRoot });
  if (gitResult.status === 0) return { ok: true, via: 'git mv' };
  const mvResult = spawnSync('mv', [src, dst]);
  if (mvResult.status === 0) return { ok: true, via: 'mv (untracked)' };
  return { ok: false, via: null, stderr: gitResult.stderr?.toString() || '' };
}

function main() {
  if (!FORCE && !DRY) {
    const count = activeCCSessionCount();
    if (count > 0) {
      console.error(
        `Refusing to migrate: ${count} active Claude Code session(s) detected:`
      );
      for (const line of listActiveCCSessions()) console.error(line);
      console.error(
        `\nClose other sessions first, or run with --force if you've confirmed all are closed.\n` +
        `(--dry-run is always allowed.)`
      );
      process.exit(1);
    }
  }

  const targets = findHandoffDirs();
  if (targets.length === 0) {
    console.log('No handoff files found in any project memory dir.');
    return;
  }

  let total = 0;
  let failed = 0;
  let kept = 0;
  for (const { proj, memDir, files, kept: keptFiles } of targets) {
    const archiveDir = join(memDir, 'handoff-archive');
    console.log(`\n[${proj}]`);
    if (keptFiles && keptFiles.length > 0) {
      console.log(`  KEEP (marker-stamped, current):`);
      for (const k of keptFiles) console.log(`     ${k}`);
      kept += keptFiles.length;
    }
    if (files.length === 0) {
      console.log(`  (no stale files to archive)`);
      continue;
    }
    console.log(`  archive dir: ${archiveDir}`);
    if (!DRY && !existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });
    for (const f of files) {
      const src = join(memDir, f);
      const dst = join(archiveDir, f);
      if (DRY) {
        console.log(`  [DRY] mv ${f}`);
        total++;
      } else {
        const result = gitMv(src, dst);
        if (result.ok) {
          console.log(`        mv ${f}  (${result.via})`);
          total++;
        } else {
          console.error(`  FAIL  mv ${f}: ${result.stderr?.split('\n')[0] ?? 'unknown'}`);
          failed++;
        }
      }
    }
  }
  console.log(
    `\n${DRY ? 'Would move' : 'Moved'}: ${total} stale files  |  Kept in primary: ${kept} marker-stamped files` +
    (failed > 0 ? `  |  Failed: ${failed}` : '')
  );
}

main();
