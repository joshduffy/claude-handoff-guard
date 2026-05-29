#!/usr/bin/env bash
# Per-device installer for the ~/.claude pre-commit hook.
#
# Mirrors the existing pattern used by ~/.git-hooks/post-merge and
# ~/.git-hooks/pre-push: a thin per-device dispatcher in the global
# core.hooksPath dir that delegates to the synced .mjs in ~/.claude/hooks/.
#
# Run once per machine after a fresh clone. Idempotent (safe to re-run).

set -euo pipefail

hook_logic="$HOME/.claude/hooks/pre-commit-staged-marker-check.mjs"
hooks_dir=$(git config --global --get core.hooksPath || true)
hooks_dir="${hooks_dir:-$HOME/.git-hooks}"
global_hook="$hooks_dir/pre-commit"

if [[ ! -f $hook_logic ]]; then
  echo "error: $hook_logic not found (expected synced from ~/.claude repo)" >&2
  exit 1
fi

mkdir -p "$hooks_dir"
cat > "$global_hook" <<'EOF'
#!/bin/bash
# Local hook wiring: dispatches to ~/.claude/hooks/pre-commit-staged-marker-check.mjs.
# Per-device install (git hooks aren't synced via the claude-config repo).
# The dispatched hook is a no-op in repos without the projects/*/memory/handoff-*.md
# layout, so it's safe to leave this in the global hooksPath.
[ -f "$HOME/.claude/hooks/pre-commit-staged-marker-check.mjs" ] && \
  exec node "$HOME/.claude/hooks/pre-commit-staged-marker-check.mjs" "$@"
exit 0
EOF

chmod +x "$global_hook" "$hook_logic"

echo "installed: $global_hook (delegates to $hook_logic)"
