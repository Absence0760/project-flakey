#!/usr/bin/env bash
# SessionStart hook: surface work that lives off `main`.
#
# With per-session git worktrees (`claude --worktree <name>`), each session
# commits on its own branch. Git won't let a worktree check out `main`, so that
# work only reaches `main` via an explicit merge from the primary checkout. If a
# worktree branch is forgotten, its commits sit stranded off `main`.
#
# This hook lists every local branch holding commits not yet on `main` and
# prints a warning to stdout — which Claude Code injects as session context, so
# the next turn can surface it and offer to merge. Silent when everything is on
# `main`. Fail-open: any error exits 0 with no output, never wedging startup.
set -u

repo="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
[ -n "$repo" ] || exit 0

# Does `main` exist? If not, this repo doesn't use the convention — stay quiet.
git -C "$repo" rev-parse --verify --quiet main >/dev/null 2>&1 || exit 0

# Branches with commits not contained in `main` (main itself never lists here).
branches="$(git -C "$repo" branch --no-merged main --format='%(refname:short)' 2>/dev/null)" || exit 0
[ -n "$branches" ] || exit 0

# Map branch -> worktree path (if any) for a more useful message.
report=""
while IFS= read -r br; do
	[ -n "$br" ] || continue
	count="$(git -C "$repo" rev-list --count "main..$br" 2>/dev/null || echo '?')"
	wt="$(git -C "$repo" worktree list --porcelain 2>/dev/null \
		| awk -v b="refs/heads/$br" '
			/^worktree /{path=substr($0,10)}
			$0=="branch "b{print path}')"
	if [ -n "$wt" ]; then
		report="${report}  - ${br} (${count} commit(s) off main) — worktree: ${wt}
"
	else
		report="${report}  - ${br} (${count} commit(s) off main)
"
	fi
done <<EOF
$branches
EOF

[ -n "$report" ] || exit 0

cat <<EOF
[unmerged-worktree-check] Work exists that is NOT on \`main\`:
${report}
To land it on main, from the PRIMARY checkout (the one with \`main\`):
  git merge <branch>        # fast-forwards if main hasn't moved; else a merge commit
  # or, for linear history: cd into the worktree, \`git rebase main\`, then \`git merge --ff-only <branch>\`
Surface this to the user and offer to consolidate it before it's forgotten.
EOF
exit 0
