# Session Handoff

AI coding sessions are stateless across boundaries. A long session loses context to compaction;
a new session starts blind; two sessions working the same repo overwrite each other's notes. A
handoff file is the durable record that bridges them. This rule defines the convention; the hooks
in this repo enforce it structurally.

## Belt: proactive handoff

At natural breakpoints (feature complete, PR merged, blocked, or ~30 min of active work), write a
handoff file.

### File naming (parallel-safe)

`handoff-<branch>-<topic>.md` in the project memory directory.

- **Branch slug:** lowercase, slashes to dashes. `feature/auth` -> `feature-auth`.
- **Topic slug (MANDATORY):** 2-4 dash-joined lowercase words naming the workstream. The topic is
  what distinguishes parallel sessions on the same branch.
- **Bare names forbidden.** `handoff-main.md` / `handoff-master.md` are rejected by the write-guard
  hook. Most solo sessions sit on `main`, so bare names cause silent overwrites.

### Ownership marker (MANDATORY)

Every handoff file's first line is exactly:

```
<!-- claude-session: <session_id> -->
```

The PreToolUse write-guard reads the calling session's `session_id` and compares it against the
marker in the content being written and the marker on disk. A mismatch blocks the write. The marker
is what stops a future session from silently overwriting your work.

**First-write chicken-and-egg.** The model does not natively know its own `session_id`. The first
attempted Write of a fresh handoff blocks; the block reason contains the `session_id`. Copy it into
the marker line and retry. One block per fresh handoff is the expected, designed cost.

### Cross-device resume

If you pull a handoff written on another device and continue the workstream, the on-disk marker will
not match your `session_id` and the hook will block. Do not fight it: read the prior handoff for
context, then write a sibling `handoff-<branch>-<topic>-cont.md` with your own marker, referencing
the prior file. Append, do not overwrite.

## Suspenders: end-of-session gate

Before ending a session, write the handoff. The `handoff-stop-gate.mjs` Stop hook emits one
per-session reminder if the project has uncommitted work and no session-owned handoff. Stop fires
every turn and cannot detect "the last turn", so this is a nudge, not a hard gate; the discipline
still rests on you.

## On session start

The `handoff-session-start.mjs` SessionStart hook surfaces existing handoffs and topic-slug overlaps
as context. Read the one matching your branch + intended workstream as your primary handoff. Siblings
are awareness-only (parallel-session conflict detection); do not adopt their tasks.

## Cleanup

After a PR is merged, move its handoff to `handoff-archive/` with `git mv` (not `git rm`). Archive
preserves history retrievably and is excluded from the session-start glob.

## What the hooks prevent, and what they do not

**Prevented structurally:**
- Bare-name collisions (grammar enforcement).
- A session silently overwriting another session's content (marker-mismatch block on Write, Edit,
  and Bash redirects: `>`, `>>`, `tee`, `sed -i`).
- A commit mixing handoffs from two sessions (pre-commit marker check).

**NOT prevented (model-quality or out of scope):**
- A foreign-marker block defeated by archiving the foreign file or setting `HANDOFF_GUARD_BYPASS=1`.
  The guard prevents the *unaware* clobber, not the *chosen* one. Bypass use is logged but not gated.
- A filename whose `<branch>` token disagrees with the real branch (grammar checks shape, not truth;
  intentional, to support cross-device resume).
- A TOCTOU race where two sessions create the same new filename in the gap between the hook's read
  and the tool's write. Vanishingly rare for solo dev; not worth a lock.
- Semantically-overlapping-but-different topic slugs. Mitigated by the sibling-overlap soft warn.
