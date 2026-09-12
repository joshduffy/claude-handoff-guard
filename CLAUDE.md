# CLAUDE.md. claude-handoff-guard

Hook-enforced ownership for AI coding session handoffs. Most handoff tools solve *amnesia* (capture
and restore state). This one solves **concurrent clobber**: a PreToolUse hook that makes a
cross-session handoff overwrite *structurally* blocked, not just discouraged. Intended to be
npm-publishable and portable, so it stays dependency-free.

> Default branch is **`master`** (not `main`). Branch from `origin/master`.

## Stack

- **Node.js, ESM (`.mjs`), zero runtime dependencies.** No build step.
- Tests via the Node built-in test runner: `node --test hooks/test/*.test.mjs`.

## Architecture / layout

- `hooks/` | the hook implementations: `handoff-write-guard.mjs` (PreToolUse ownership block),
  `handoff-session-start.mjs` (SessionStart surfacing), `handoff-stop-gate.mjs` (Stop nudge),
  `pre-commit-staged-marker-check.mjs` (git pre-commit). Tests in `hooks/test/`.
- `scripts/` | `handoff-migrate-archive.mjs`, `install-git-hooks.sh`.
- `rules/session-handoff.md` | the rule doc shipped with the tool.
- `skills/handoff/` | the handoff skill definition.
- `settings.example.json` | example wiring for a consumer's `settings.json`.

## Commands

- `npm test` | `node --test hooks/test/*.test.mjs`.

## Conventions

- **Zero dependencies, ever.** It is published for others to run; adding a dep breaks portability.
  If you need a utility, write it in under 30 lines or use Node built-ins.
- Hooks read JSON on stdin and emit hook decisions on stdout per the Claude Code hook contract;
  keep that contract intact. The ownership marker is the first-line comment
  `<!-- claude-session: <id> -->`; the first write of a fresh handoff intentionally blocks to
  bootstrap the session id.
- Every behavior change needs a `node --test` case; this is correctness-critical (it guards other
  people's work).

## Guardrails

- This is a **public** repo. Keep it dependency-free and portable; no machine-specific paths or
  personal config in committed files.
- ASCII-only commit messages (some deploy APIs reject non-ASCII). Periods, commas, colons,
  semicolons; `->` for arrows.
- Default branch is `master`. Tests are mandatory for hook behavior changes.
