"""Pytest plugin that uploads results to a Flakey backend as a NormalizedRun.

Lifecycle:
  pytest_configure        — read config/env (FLAKEY_API_URL / FLAKEY_API_KEY / suite)
  pytest_sessionstart     — stamp started_at
  pytest_runtest_logreport — buffer each test result (call phase, or setup for
                             skips/setup-errors), keyed by source file
  pytest_sessionfinish    — aggregate into a NormalizedRun, POST to /runs

The pure functions (parse_nodeid / resolve_meta / build_run) are import-safe and
unit-tested without pytest internals; the hook class wires them to pytest events.
Results upload only — live events + artifacts are follow-ups (see README).
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from .uploader import post_run

REPORTER_NAME = "pytest"


def _first_env(*names: str) -> str:
    for n in names:
        v = os.environ.get(n)
        if v:
            return v
    return ""


def parse_nodeid(nodeid: str) -> Tuple[str, str, str]:
    """Split a pytest nodeid into (file_path, full_title, title).

    "tests/test_math.py::TestCalc::test_add[2-3]"
      -> ("tests/test_math.py", "TestCalc > test_add[2-3]", "test_add[2-3]")
    "tests/test_math.py::test_add"
      -> ("tests/test_math.py", "test_add", "test_add")
    """
    parts = nodeid.split("::")
    file_path = parts[0]
    segments = parts[1:] or [file_path]
    title = segments[-1]
    full_title = " > ".join(segments)
    return file_path, full_title, title


def resolve_meta(suite: Optional[str], started_at: str, finished_at: str) -> Dict[str, Any]:
    """Build the run meta block, resolving CI fields from the standard env chains
    (matching the JS reporters)."""
    meta: Dict[str, Any] = {
        "suite_name": suite or os.environ.get("FLAKEY_SUITE") or "default",
        "branch": _first_env("BRANCH", "GITHUB_HEAD_REF", "GITHUB_REF_NAME", "BITBUCKET_BRANCH"),
        "commit_sha": _first_env("COMMIT_SHA", "GITHUB_SHA", "BITBUCKET_COMMIT"),
        "ci_run_id": _first_env("CI_RUN_ID", "GITHUB_RUN_ID", "BITBUCKET_BUILD_NUMBER"),
        "started_at": started_at,
        "finished_at": finished_at,
        "reporter": REPORTER_NAME,
    }
    release = os.environ.get("FLAKEY_RELEASE")
    if release:
        meta["release"] = release
    environment = _first_env("FLAKEY_ENV", "TEST_ENV")
    if environment:
        meta["environment"] = environment
    return meta


def _empty_stats() -> Dict[str, int]:
    return {"total": 0, "passed": 0, "failed": 0, "skipped": 0, "pending": 0, "duration_ms": 0}


def build_run(
    tests_by_file: Dict[str, List[Dict[str, Any]]],
    meta: Dict[str, Any],
) -> Dict[str, Any]:
    """Aggregate buffered per-file test lists into a NormalizedRun dict."""
    specs: List[Dict[str, Any]] = []
    run_stats = _empty_stats()
    for file_path, tests in tests_by_file.items():
        spec_stats = _empty_stats()
        for t in tests:
            spec_stats["total"] += 1
            spec_stats["duration_ms"] += t["duration_ms"]
            key = t["status"] if t["status"] in ("passed", "failed", "skipped") else "skipped"
            spec_stats[key] += 1
        specs.append({
            "file_path": file_path,
            "title": file_path,
            "stats": spec_stats,
            "tests": tests,
        })
        for k in run_stats:
            run_stats[k] += spec_stats[k]
    return {"meta": meta, "stats": run_stats, "specs": specs}


# pytest outcome -> Flakey status (pytest has no "pending"; only skipped).
_STATUS = {"passed": "passed", "failed": "failed", "skipped": "skipped"}


class FlakeyReporter:
    def __init__(self, url: str, api_key: str, suite: Optional[str]):
        self.url = url
        self.api_key = api_key
        self.suite = suite
        self.tests_by_file: Dict[str, List[Dict[str, Any]]] = {}
        # nodeid -> the buffered entry dict already in tests_by_file, so a rerun
        # of the same test overwrites in place (final-attempt wins) instead of
        # appending a second row. See pytest_runtest_logreport.
        self._entry_by_nodeid: Dict[str, Dict[str, Any]] = {}
        self.started_at = ""

    def pytest_sessionstart(self, session):  # noqa: ARG002
        self.started_at = datetime.now(timezone.utc).isoformat()

    def pytest_runtest_logreport(self, report):
        # Record once per test: the "call" phase for pass/fail, and the "setup"
        # phase only when it's a skip or a setup-time error (those never reach
        # "call"). This avoids double-counting across phases.
        record = report.when == "call" or (
            report.when == "setup" and (report.skipped or report.failed)
        )
        if not record:
            return

        file_path, full_title, title = parse_nodeid(report.nodeid)
        status = _STATUS.get(report.outcome, "skipped")
        entry: Dict[str, Any] = {
            "title": title,
            "full_title": full_title,
            "status": status,
            "duration_ms": int(round(getattr(report, "duration", 0.0) * 1000)),
            "screenshot_paths": [],
        }
        if status == "failed":
            entry["error"] = self._extract_error(report)

        # Dedupe by nodeid so a rerun (pytest-rerunfailures / flaky) of the same
        # test overwrites its earlier attempt rather than appending a second row.
        # Without this a single test rerun 3x reports as 3 tests with phantom
        # failures, corrupting the run's pass/fail counts and flaky detection.
        # Mirrors the JS reporters' "last/final attempt wins" retry handling.
        prior = self._entry_by_nodeid.get(report.nodeid)
        if prior is not None:
            prior.clear()
            prior.update(entry)
            return
        self._entry_by_nodeid[report.nodeid] = entry
        self.tests_by_file.setdefault(file_path, []).append(entry)

    @staticmethod
    def _extract_error(report) -> Dict[str, Any]:
        text = ""
        try:
            text = report.longreprtext
        except Exception:  # noqa: BLE001 — some longreprs aren't renderable
            text = str(getattr(report, "longrepr", ""))
        message = ""
        crash = getattr(getattr(report, "longrepr", None), "reprcrash", None)
        if crash is not None:
            message = getattr(crash, "message", "") or ""
        if not message:
            message = (text.strip().split("\n", 1)[0] if text else "Test failed")
        error: Dict[str, Any] = {"message": message}
        if text:
            error["stack"] = text
        return error

    def pytest_sessionfinish(self, session, exitstatus):  # noqa: ARG002
        finished_at = datetime.now(timezone.utc).isoformat()
        meta = resolve_meta(self.suite, self.started_at, finished_at)
        run = build_run(self.tests_by_file, meta)
        try:
            result = post_run(self.url, self.api_key, run)
            rid = result.get("id")
            if rid is not None:
                print(f"\n[flakey] Uploaded run #{rid} "
                      f"({run['stats']['total']} tests, {run['stats']['failed']} failed) → {self.url}",
                      file=sys.stderr)
        except Exception as e:  # noqa: BLE001 — never fail the test session on upload error
            print(f"\n[flakey] Upload failed: {e}", file=sys.stderr)


def pytest_addoption(parser):
    group = parser.getgroup("flakey")
    group.addoption("--flakey-suite", action="store", default=None,
                    help="Flakey suite name (overrides FLAKEY_SUITE).")


def pytest_configure(config):
    url = os.environ.get("FLAKEY_API_URL", "http://localhost:3000")
    api_key = os.environ.get("FLAKEY_API_KEY", "")
    if not api_key:
        # No key → register nothing; pytest runs normally without uploading.
        print("[flakey] FLAKEY_API_KEY not set — results will not be uploaded.", file=sys.stderr)
        return
    suite = config.getoption("--flakey-suite")
    config.pluginmanager.register(FlakeyReporter(url, api_key, suite), "flakey-reporter")
