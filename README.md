# claude-handoff-guard

Hook-enforced ownership for AI coding session handoffs.

Most "handoff" tools solve *amnesia*: capture state to a markdown file, restore it after compaction
or a new session. That problem is well covered. This one solves the problem nobody enforces:
**concurrent clobber**. When two sessions work the same repo, or you resume on a second machine, or a
background agent runs alongside an interactive one, they overwrite each other's handoff notes and you
do not find out until the context you needed is gone.

The fix here is not a better template. It is a PreToolUse hook that makes a cross-session overwrite
*structurally* blocked, not merely discouraged.

## The core idea: the lock lives inside the file

Every handoff file's first line is an ownership marker:

```
<!-- claude-session: 9e0d3802-... -->
```

There is no sidecar `.lock` file. Ownership travels with the artifact through git, across devices,
through a `mv`. A PreToolUse hook reads the calling session's id and compares it to the marker in the
content being written and the marker already on disk. Mismatch blocks the write.

## The chicken-and-egg (the interesting part)

To write a handoff that says who wrote it, the session needs to know its own id. **It does not.** The
model has no native access to its `session_id`.

So the first write of a fresh handoff is *designed to fail*. The block reason carries the id:

```
Handoff write missing or wrong ownership marker.

Your session_id: `9e0d3802-4f...`.

Prepend exactly this as line 1:
  <!-- claude-session: 9e0d3802-4f... -->

Then retry.
```

The model copies the id from the failure and retries. One block per fresh handoff, and the file is
now self-identifying for every future session. The missing capability becomes a one-time handshake.

## Defense across all three mutation surfaces

A model that is blocked on `Write` will route around you. So the guard covers every way a file can be
mutated:

- **Write** validates the marker in the new content.
- **Edit** validates the marker on disk (and blocks edits to legacy marker-less files until you take
  ownership with a Write).
- **Bash** matches shell redirects to handoff paths (`>`, `>>`, `tee`, `sed -i`) and blocks unowned
  writes that try to sneak past the file tools.

It also accepts both the Claude Code tool schema (`Write`/`Edit`/`Bash`) and the Gemini CLI schema
(`write_file`/`replace`/`run_shell_command`) in one hook, because gating on one silently disables the
guard for the other client.

## What ships

```
hooks/handoff-write-guard.mjs            PreToolUse: the ownership guard
hooks/handoff-session-start.mjs          SessionStart: surface existing handoffs + slug overlaps
hooks/handoff-stop-gate.mjs              Stop: once-per-session "you have no handoff" nudge
hooks/pre-commit-staged-marker-check.mjs git pre-commit: block commits mixing two sessions' handoffs
hooks/test/handoff-write-guard.test.mjs  node --test suite (8 cases)
scripts/handoff-migrate-archive.mjs      archive stale, marker-less legacy handoffs
scripts/install-git-hooks.sh             per-device installer for the pre-commit hook
skills/handoff/SKILL.md                  the /handoff slash command
rules/session-handoff.md                 the convention the hooks enforce
settings.example.json                    hook wiring to merge into ~/.claude/settings.json
```

Handoffs are expected under the standard Claude Code memory layout:
`~/.claude/projects/<encoded-cwd>/memory/handoff-<branch>-<topic>.md`, where `<encoded-cwd>` is the
absolute working directory with `/`, `\`, and `.` replaced by `-`.

## Install

```bash
# 1. Copy hooks/skills/rules into your ~/.claude
cp hooks/*.mjs        ~/.claude/hooks/
cp -r hooks/test      ~/.claude/hooks/
cp scripts/*          ~/.claude/scripts/
cp -r skills/handoff  ~/.claude/skills/
cp rules/*            ~/.claude/rules/

# 2. Merge settings.example.json into ~/.claude/settings.json (additive arrays)

# 3. Install the per-device git pre-commit hook (handoffs live in a git repo)
bash ~/.claude/scripts/install-git-hooks.sh

# 4. Verify
node --test ~/.claude/hooks/test/
```

## Philosophy: fail open, never trap the session

Every hook wraps its body in try/catch and exits 0 on any internal error. A bug in the guard
degrades to convention; it never bricks a session. The Stop nudge is non-blocking and fires at most
once per session. The escape hatches (`touch /tmp/handoff-guard-bypass-<file>`, or
`HANDOFF_GUARD_BYPASS=1`) exist precisely because a structural guard you cannot override becomes a
structural guard you rip out. Bypass use is logged so silent disabling is auditable.

## Limitations (honest)

This makes the *unaware* clobber impossible. It does not make the *chosen* one impossible.

- A session correctly shown a foreign marker can still archive the file or set the bypass env. Human
  review of the visible block message is the backstop for that class.
- The `<branch>` token in a filename is not checked against the real branch (intentional: cross-device
  resume deliberately inherits a foreign branch's topic).
- A TOCTOU race exists if two sessions create the *same new* filename in the gap between the hook's
  read and the tool's write. Vanishingly rare for solo dev; deliberately not locked.

## License

MIT.
