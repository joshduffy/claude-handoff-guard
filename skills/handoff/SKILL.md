---
name: handoff
description: Generate a session handoff document for the current branch. Use at the end of any session or at natural breakpoints.
user_invocable: true
---

# Handoff

Generate a session handoff document following the mandatory format:

1. **Determine branch + topic slug**:
   - Branch: `git branch --show-current`. Slugify for filename (lowercase, slashes to dashes).
   - Topic slug (MANDATORY): 2-4 dash-joined lowercase words naming this session's workstream. Examples: `auth-refactor`, `search-index-rewrite`, `payments-webhook-retry`. Bare `handoff-main.md` / `handoff-master.md` are REJECTED by the write-guard hook because most sessions sit on `main` and bare names silently overwrite. Pick a slug that distinguishes this workstream from any sibling sessions on the same branch.
   - Grammar constraint (so the first write does not block on shape): the filename must be `handoff-<branch>-<topic>.md` with the topic carrying AT LEAST TWO tokens. `handoff-main-spike.md` is rejected (one topic token); `handoff-main-search-index.md` passes. Normalize branch slugs to lowercase alphanumerics + dashes first (uppercase, dots, and underscores are rejected by the grammar).

2. **Check for an existing handoff owned by this session**:

   Run `grep -l "<!-- claude-session: <your-session-id> -->" <memory-dir>/handoff-*.md` (you will learn your session_id from a first-write block per step 4 if you do not already have it).

   - **Match found**: a handoff for this session already exists. Update it IN PLACE (Edit, not Write). Do NOT create a sibling. Re-derive the topic slug from the existing filename. After the update, skip to step 5.
   - **No match**: this is a fresh write. Proceed to step 3.

   Sibling handoff files are reserved for cross-device resume and for genuinely concurrent background sessions, never for a single session writing a second file because the work shifted topics.

3. **Gather context**:
   - `git log --oneline -10` for recent commits this session
   - `git status --short` for uncommitted work
   - Open PRs on this branch: `gh pr list --head <branch>`
   - Build status if quick: `npm run build 2>&1 | tail -5`
   - Any failed commands, unexpected behaviors, or corrections this session. Capture verbatim error output and a unique string to grep the session log later.

4. **Write handoff file** to the project memory directory as `handoff-<branch>-<topic>.md`:

```markdown
<!-- claude-session: <your-session-id> -->
# Session Handoff - <TODAY'S DATE> - <BRANCH> - <TOPIC>

## What was done
- [Concrete deliverables: PR numbers, files changed, features built]

## What was NOT done / NOT verified
- [Anything skipped, deferred, or untested. Be honest.]

## Failure traces (if any)
- Trigger / Error (verbatim) / Component involved / Classification / grep hint

## Current state
- Branch / Worktree / Build passing-failing / Deploy state

## Next session prompt
\`\`\`
Pick up <intent> in <project>. Read <memory-dir>/handoff-<branch>-<topic>.md first. Priority: [1-2 sentence next action].
\`\`\`
```

**First-write chicken-and-egg:** the model does not natively know its own `session_id`. The first attempted Write of a fresh handoff blocks; the block reason contains the current `session_id`. Copy it into the marker line, retry. One block per fresh handoff is the expected cost.

5. **Print the next-session prompt** in a code block so the user can copy it.

6. **Clean up stale handoffs**: if any `handoff-*.md` files reference branches that no longer exist (`git branch -a`), move them to `handoff-archive/` rather than deleting (`git mv`, not `git rm`).
