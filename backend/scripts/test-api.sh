#!/bin/bash

# Flakey API test scripts
# Usage: bash backend/scripts/test-api.sh

API_URL="${FLAKEY_API_URL:-http://localhost:3000}"

echo "=== Flakey API Tests ==="
echo "API: $API_URL"
echo ""

# Health check
echo "--- GET /health ---"
curl -s "$API_URL/health" | python3 -m json.tool
echo ""

# Get stats
echo "--- GET /stats ---"
curl -s "$API_URL/stats" | python3 -m json.tool
echo ""

# List runs
echo "--- GET /runs ---"
curl -s "$API_URL/runs" | python3 -m json.tool | head -40
echo "  ... (truncated)"
echo ""

# Get single run (first one)
echo "--- GET /runs/1 ---"
curl -s "$API_URL/runs/1" | python3 -m json.tool | head -50
echo "  ... (truncated)"
echo ""

# Get errors
echo "--- GET /errors ---"
curl -s "$API_URL/errors" | python3 -m json.tool | head -40
echo "  ... (truncated)"
echo ""

# Post a new run with pre-normalized data
echo "--- POST /runs (normalized payload) ---"
curl -s -X POST "$API_URL/runs" \
  -H "Content-Type: application/json" \
  -d '{
    "meta": {
      "suite_name": "api-test-suite",
      "branch": "main",
      "commit_sha": "abc123",
      "ci_run_id": "ci-999",
      "started_at": "2026-04-06T10:00:00Z",
      "finished_at": "2026-04-06T10:01:30Z",
      "reporter": "mochawesome"
    },
    "stats": {
      "total": 3,
      "passed": 2,
      "failed": 1,
      "skipped": 0,
      "pending": 0,
      "duration_ms": 90000
    },
    "specs": [
      {
        "file_path": "cypress/e2e/example.cy.ts",
        "title": "Example Tests",
        "stats": { "total": 3, "passed": 2, "failed": 1, "skipped": 0, "duration_ms": 90000 },
        "tests": [
          {
            "title": "should load the homepage",
            "full_title": "Example Tests > should load the homepage",
            "status": "passed",
            "duration_ms": 25000,
            "screenshot_paths": []
          },
          {
            "title": "should display the header",
            "full_title": "Example Tests > should display the header",
            "status": "passed",
            "duration_ms": 15000,
            "screenshot_paths": []
          },
          {
            "title": "should submit the form",
            "full_title": "Example Tests > should submit the form",
            "status": "failed",
            "duration_ms": 50000,
            "error": {
              "message": "AssertionError: expected 400 to equal 200",
              "stack": "    at Context.<anonymous> (cypress/e2e/example.cy.ts:42:10)"
            },
            "screenshot_paths": []
          }
        ]
      }
    ]
  }' | python3 -m json.tool
echo ""

# Post a raw mochawesome report
echo "--- POST /runs (raw mochawesome payload) ---"
curl -s -X POST "$API_URL/runs" \
  -H "Content-Type: application/json" \
  -d '{
    "meta": {
      "suite_name": "raw-test-suite",
      "branch": "dev",
      "commit_sha": "def456",
      "ci_run_id": "ci-1000",
      "started_at": "",
      "finished_at": "",
      "reporter": "mochawesome"
    },
    "raw": {
      "stats": {
        "tests": 2,
        "passes": 1,
        "failures": 1,
        "pending": 0,
        "skipped": 0,
        "duration": 45000,
        "start": "2026-04-06T12:00:00.000Z",
        "end": "2026-04-06T12:00:45.000Z"
      },
      "results": [
        {
          "file": "cypress/e2e/raw-test.cy.ts",
          "title": "",
          "tests": [],
          "suites": [
            {
              "title": "Raw Test Suite",
              "file": "",
              "tests": [
                {
                  "title": "should pass this test",
                  "fullTitle": "Raw Test Suite > should pass this test",
                  "pass": true,
                  "fail": false,
                  "pending": false,
                  "duration": 20000,
                  "err": {}
                },
                {
                  "title": "should fail this test",
                  "fullTitle": "Raw Test Suite > should fail this test",
                  "pass": false,
                  "fail": true,
                  "pending": false,
                  "duration": 25000,
                  "err": {
                    "message": "Element not found: [data-testid=\"missing\"]",
                    "estack": "    at Context.<anonymous> (cypress/e2e/raw-test.cy.ts:18:5)"
                  }
                }
              ],
              "suites": []
            }
          ]
        }
      ]
    }
  }' | python3 -m json.tool
echo ""

# Post with bad payload (should return 400)
echo "--- POST /runs (bad payload — expect 400) ---"
curl -s -X POST "$API_URL/runs" \
  -H "Content-Type: application/json" \
  -d '{"bad": "data"}' | python3 -m json.tool
echo ""

# Get a non-existent run (should return 404)
echo "--- GET /runs/99999 (expect 404) ---"
curl -s "$API_URL/runs/99999" | python3 -m json.tool
echo ""

echo "=== Done ==="
