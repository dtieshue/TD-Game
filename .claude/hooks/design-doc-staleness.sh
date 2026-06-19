#!/usr/bin/env bash
# Stop hook: nudge Claude to update DESIGN.md when project files are newer than it.
# Self-limiting: exits quietly if DESIGN.md is current, or if already re-invoked
# by this same hook (stop_hook_active) to avoid loops.

input="$(cat)"
# Project root: Claude Code sets CLAUDE_PROJECT_DIR for hooks; fall back to this
# script's location (.claude/hooks/) so it also works standalone or on any clone.
proj="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
doc="$proj/DESIGN.md"

# Avoid re-blocking loops.
if echo "$input" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  exit 0
fi

# No doc yet -> nothing to keep in sync.
[ -f "$doc" ] || exit 0

# Newest project source file (excluding the doc itself, VCS, deps, the .claude dir).
newest="$(find "$proj" \
  -type d \( -name node_modules -o -name .git -o -name .claude -o -name dist -o -name build -o -name Archive \) -prune -o \
  -type f ! -name DESIGN.md -newer "$doc" -print 2>/dev/null | head -n 1)"

if [ -n "$newest" ]; then
  printf '{"decision":"block","reason":"Project files changed since DESIGN.md was last updated (e.g. %s). Before stopping, update DESIGN.md so it reflects the latest ground truth — revise the affected sections plus the Roadmap and Open Questions. If the doc is already accurate, just touch it (no content change needed) and stop."}\n' "$(basename "$newest")"
  exit 0
fi

exit 0
