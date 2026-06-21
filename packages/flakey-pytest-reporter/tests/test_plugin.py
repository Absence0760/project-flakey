"""Unit tests for the Flakey pytest reporter's pure logic.

Run: cd packages/flakey-pytest-reporter && uv run --with pytest pytest
(or with PYTHONPATH=src). These exercise the import-safe helpers without
standing up pytest's runtest machinery; the uploader is tested with a stubbed
urlopen.
"""
import io
import json

import pytest

from flakey_pytest_reporter.plugin import parse_nodeid, resolve_meta, build_run, FlakeyReporter
from flakey_pytest_reporter import uploader


# ── nodeid parsing ──────────────────────────────────────────────────────────

def test_parse_nodeid_with_class():
    f, full, title = parse_nodeid("tests/test_math.py::TestCalc::test_add[2-3]")
    assert f == "tests/test_math.py"
    assert full == "TestCalc > test_add[2-3]"
    assert title == "test_add[2-3]"


def test_parse_nodeid_module_level():
    f, full, title = parse_nodeid("tests/test_io.py::test_read")
    assert f == "tests/test_io.py"
    assert full == "test_read"
    assert title == "test_read"


def test_parse_nodeid_nested_dirs():
    f, _, _ = parse_nodeid("pkg/sub/test_x.py::test_y")
    assert f == "pkg/sub/test_x.py"


# ── env-var resolution ──────────────────────────────────────────────────────

def test_resolve_meta_env_chains(monkeypatch):
    monkeypatch.delenv("BRANCH", raising=False)
    monkeypatch.setenv("GITHUB_HEAD_REF", "feature/x")
    monkeypatch.setenv("GITHUB_SHA", "abc123")
    monkeypatch.setenv("GITHUB_RUN_ID", "999")
    monkeypatch.setenv("FLAKEY_ENV", "qa")
    monkeypatch.delenv("FLAKEY_RELEASE", raising=False)
    meta = resolve_meta("my-suite", "t0", "t1")
    assert meta["suite_name"] == "my-suite"
    assert meta["branch"] == "feature/x"        # GITHUB_HEAD_REF wins over REF_NAME
    assert meta["commit_sha"] == "abc123"
    assert meta["ci_run_id"] == "999"
    assert meta["environment"] == "qa"
    assert meta["reporter"] == "pytest"
    assert "release" not in meta                # absent env -> field omitted


def test_resolve_meta_branch_precedence(monkeypatch):
    monkeypatch.setenv("BRANCH", "explicit")
    monkeypatch.setenv("GITHUB_HEAD_REF", "ignored")
    assert resolve_meta(None, "", "")["branch"] == "explicit"


def test_resolve_meta_suite_fallback(monkeypatch):
    monkeypatch.delenv("FLAKEY_SUITE", raising=False)
    assert resolve_meta(None, "", "")["suite_name"] == "default"
    monkeypatch.setenv("FLAKEY_SUITE", "from-env")
    assert resolve_meta(None, "", "")["suite_name"] == "from-env"


# ── run aggregation ─────────────────────────────────────────────────────────

def _t(title, status, dur=10):
    return {"title": title, "full_title": f"S > {title}", "status": status,
            "duration_ms": dur, "screenshot_paths": []}


def test_build_run_aggregates_stats_and_status():
    tests_by_file = {
        "a.py": [_t("t1", "passed"), _t("t2", "failed"), _t("t3", "skipped")],
        "b.py": [_t("t4", "passed", 5)],
    }
    run = build_run(tests_by_file, resolve_meta("s", "t0", "t1"))
    assert run["stats"] == {"total": 4, "passed": 2, "failed": 1, "skipped": 1, "pending": 0, "duration_ms": 35}
    assert len(run["specs"]) == 2
    a = next(s for s in run["specs"] if s["file_path"] == "a.py")
    assert a["stats"]["total"] == 3 and a["stats"]["failed"] == 1
    assert a["title"] == "a.py"


def test_build_run_empty():
    run = build_run({}, resolve_meta("s", "t0", "t1"))
    assert run["stats"]["total"] == 0
    assert run["specs"] == []
    assert run["stats"]["pending"] == 0   # pytest has no pending; always 0


# ── logreport buffering / rerun dedupe ──────────────────────────────────────

class _FakeReport:
    """Minimal stand-in for a pytest TestReport for the recording hook."""
    def __init__(self, nodeid, when, outcome, duration=0.01):
        self.nodeid = nodeid
        self.when = when
        self.outcome = outcome
        self.duration = duration
        self.skipped = outcome == "skipped"
        self.failed = outcome == "failed"
        self.longrepr = None

    @property
    def longreprtext(self):
        return "boom" if self.failed else ""


def _reporter():
    return FlakeyReporter("http://x", "k", "s")


def test_logreport_rerun_is_deduped_to_final_attempt():
    # pytest-rerunfailures re-runs the same nodeid, firing a fresh call-phase
    # report each attempt. A flaky test that fails twice then passes must
    # report as ONE passed test, not three tests with two phantom failures.
    r = _reporter()
    nid = "tests/test_x.py::test_flaky"
    r.pytest_runtest_logreport(_FakeReport(nid, "call", "failed"))
    r.pytest_runtest_logreport(_FakeReport(nid, "call", "failed"))
    r.pytest_runtest_logreport(_FakeReport(nid, "call", "passed"))

    run = build_run(r.tests_by_file, resolve_meta("s", "t0", "t1"))
    assert run["stats"]["total"] == 1
    assert run["stats"]["passed"] == 1
    assert run["stats"]["failed"] == 0
    tests = r.tests_by_file["tests/test_x.py"]
    assert len(tests) == 1
    assert tests[0]["status"] == "passed"
    # The final (passing) attempt must not carry the earlier failure's error.
    assert "error" not in tests[0]


def test_logreport_rerun_ending_in_failure_keeps_error():
    r = _reporter()
    nid = "tests/test_x.py::test_still_broken"
    r.pytest_runtest_logreport(_FakeReport(nid, "call", "failed"))
    r.pytest_runtest_logreport(_FakeReport(nid, "call", "failed"))

    run = build_run(r.tests_by_file, resolve_meta("s", "t0", "t1"))
    assert run["stats"]["total"] == 1
    assert run["stats"]["failed"] == 1
    tests = r.tests_by_file["tests/test_x.py"]
    assert len(tests) == 1
    assert tests[0]["status"] == "failed"
    assert tests[0]["error"]["message"] == "boom"


def test_logreport_distinct_tests_are_not_collapsed():
    # Dedupe is per-nodeid: two different tests in the same file stay distinct,
    # and insertion order is preserved.
    r = _reporter()
    r.pytest_runtest_logreport(_FakeReport("a.py::test_one", "call", "passed"))
    r.pytest_runtest_logreport(_FakeReport("a.py::test_two", "call", "failed"))

    run = build_run(r.tests_by_file, resolve_meta("s", "t0", "t1"))
    assert run["stats"]["total"] == 2
    assert [t["title"] for t in r.tests_by_file["a.py"]] == ["test_one", "test_two"]


def test_logreport_setup_skip_then_no_call_records_once():
    # A test skipped at setup (no call phase) records exactly one skipped row.
    r = _reporter()
    r.pytest_runtest_logreport(_FakeReport("a.py::test_skipped", "setup", "skipped"))

    run = build_run(r.tests_by_file, resolve_meta("s", "t0", "t1"))
    assert run["stats"] == {"total": 1, "passed": 0, "failed": 0, "skipped": 1,
                            "pending": 0, "duration_ms": 10}


# ── uploader ────────────────────────────────────────────────────────────────

def test_post_run_posts_bearer_and_json(monkeypatch):
    captured = {}

    class FakeResp:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return b'{"id": 7}'

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["method"] = req.get_method()
        captured["auth"] = req.get_header("Authorization")
        captured["body"] = json.loads(req.data.decode())
        return FakeResp()

    monkeypatch.setattr(uploader.urllib.request, "urlopen", fake_urlopen)
    out = uploader.post_run("http://localhost:3000/", "fk_key", {"meta": {}, "stats": {}, "specs": []})
    assert out == {"id": 7}
    assert captured["url"] == "http://localhost:3000/runs"   # trailing slash stripped
    assert captured["method"] == "POST"
    assert captured["auth"] == "Bearer fk_key"
    assert captured["body"]["specs"] == []


def test_post_run_raises_on_http_error(monkeypatch):
    import urllib.error

    def fake_urlopen(req, timeout=None):
        raise urllib.error.HTTPError(req.full_url, 401, "Unauthorized", {}, io.BytesIO(b"bad key"))

    monkeypatch.setattr(uploader.urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(RuntimeError, match="401"):
        uploader.post_run("http://x", "k", {})
