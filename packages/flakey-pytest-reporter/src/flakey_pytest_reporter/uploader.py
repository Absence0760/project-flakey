"""HTTP upload of a NormalizedRun to the Flakey backend.

Stdlib-only (urllib) so the reporter adds no transitive deps beyond pytest.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Dict


def post_run(url: str, api_key: str, run: Dict[str, Any], timeout: float = 15.0) -> Dict[str, Any]:
    """POST a NormalizedRun to ``<url>/runs``. Raises on non-2xx or transport error.

    The caller (the plugin's session-finish hook) wraps this in try/except so a
    backend hiccup never fails the test session.
    """
    endpoint = url.rstrip("/") + "/runs"
    body = json.dumps(run).encode("utf-8")
    req = urllib.request.Request(
        endpoint,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = resp.read().decode("utf-8")
            return json.loads(payload) if payload else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:200]
        raise RuntimeError(f"Flakey upload failed ({e.code}): {detail}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"Flakey upload failed: {e.reason}") from e
