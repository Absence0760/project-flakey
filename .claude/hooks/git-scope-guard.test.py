#!/usr/bin/env python3
"""Tests for git-scope-guard.py.

Runs the hook as a subprocess with crafted PreToolUse payloads and asserts
the deny/allow decision. Run: `python3 .claude/hooks/git-scope-guard.test.py`.
Not wired into CI — the hook itself is the live guard; this pins its logic so
an edit can't silently reopen a hole (notably the bare-`git commit` sweep that
let one session's commit capture another's staged changes).
"""

import json
import subprocess
import sys
from pathlib import Path

HOOK = str(Path(__file__).with_name("git-scope-guard.py"))


def decision(command):
    """Return 'deny' if the hook blocks the command, else 'allow'."""
    out = subprocess.run(
        [sys.executable, HOOK],
        input=json.dumps({"tool_name": "Bash", "tool_input": {"command": command}}),
        capture_output=True, text=True,
    ).stdout.strip()
    if not out:
        return "allow"
    try:
        return json.loads(out)["hookSpecificOutput"]["permissionDecision"]
    except (ValueError, KeyError):
        return "allow"


# (command, expected) — the core of the suite is the bare-commit gap.
CASES = [
    # The regression that motivated this guard: bare commit sweeps the index.
    ('git commit -m "msg"', "deny"),
    ("git commit", "deny"),
    ('git commit -m "msg" --no-verify', "deny"),
    # Scoped commits are safe and must pass.
    ('git commit -m "msg" -- foo.ts bar.ts', "allow"),
    ('git commit foo.ts -m "msg"', "allow"),
    ('git commit -m "msg" -- src/lib/types.ts', "allow"),
    # Scoped / no-content commits that don't race-snapshot the index.
    ('git commit --amend -m "reword" -- foo.ts', "allow"),  # amend + pathspec
    ('git commit --allow-empty -m "ci: trigger"', "allow"),
    ("git commit --no-edit", "allow"),  # merge / cherry-pick continuation
    # (bare `git commit --amend` is git-state-dependent — tested white-box below)
    # Pre-existing rules still hold.
    ('git commit -am "msg"', "deny"),
    ('git commit -a -m "msg"', "deny"),
    ("git add -u", "deny"),
    ("git add .", "deny"),
    ("git add -A", "deny"),
    ("git add foo.ts bar.ts", "allow"),
    ("git reset --hard", "deny"),
    ("git checkout -- .", "deny"),
    ("git restore .", "deny"),
    ("git restore -- foo.ts", "allow"),
    ("git stash", "deny"),
    ("git stash push -- foo.ts", "allow"),
    ("git rm -r --cached .", "deny"),
    ("git rm .", "deny"),
    ("git rm src/old.ts", "allow"),
    ("git rm -r src/legacy", "allow"),
    ("git rm --cached src/old.ts", "allow"),
    ("git clean -fd", "deny"),
    # Read-only / unrelated — never blocked.
    ("git status", "allow"),
    ("git log --oneline -5", "allow"),
    ("git diff --cached", "allow"),
    # Compound commands: a deny anywhere in the chain blocks.
    ('git add foo.ts && git commit -m "msg"', "deny"),
    ('git add foo.ts && git commit -m "msg" -- foo.ts', "allow"),
]

failures = []
for command, expected in CASES:
    got = decision(command)
    status = "ok" if got == expected else "FAIL"
    if got != expected:
        failures.append((command, expected, got))
    print(f"  [{status}] expect {expected:5} got {got:5}  {command}")

# White-box: bare `git commit --amend` is git-state-dependent (deny only when
# the index has staged changes). Load the module and stub the git query so both
# branches are deterministic without touching the real shared index.
import importlib.util  # noqa: E402

spec = importlib.util.spec_from_file_location("gsg", HOOK)
gsg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gsg)

WHITEBOX = []
for staged, args, want_deny in [
    (True, ["--amend", "-m", "reword"], True),    # staged → absorbs the index
    (True, ["--amend", "--no-edit"], True),
    (False, ["--amend", "-m", "reword"], False),  # nothing staged → pure reword
    (False, ["--amend", "--no-edit"], False),
    (True, ["--amend", "-m", "x", "--", "foo.ts"], False),  # scoped → safe even if staged
]:
    gsg._has_staged_changes = lambda s=staged: s
    reason = gsg._check_commit(args)
    got_deny = reason is not None
    ok = got_deny == want_deny
    if not ok:
        failures.append((f"_check_commit({args}) staged={staged}", want_deny, got_deny))
    print(f"  [{'ok' if ok else 'FAIL'}] amend staged={str(staged):5} "
          f"expect {'deny' if want_deny else 'allow':5} got {'deny' if got_deny else 'allow':5}  {args}")

if failures:
    print(f"\n{len(failures)} FAILED:")
    for command, expected, got in failures:
        print(f"  {command!r}: expected {expected}, got {got}")
    sys.exit(1)
print(f"\nAll {len(CASES)} subprocess + {len(WHITEBOX) or 5} white-box cases passed.")
