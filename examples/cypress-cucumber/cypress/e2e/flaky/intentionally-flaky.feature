Feature: Intentionally flaky scenarios

  # INTENTIONALLY FLAKY SCENARIOS
  #
  # These scenarios randomly fail ~30 % of the time to exercise the
  # flaky-detection feature of Better Testing.  Run them with:
  #
  #   pnpm test:flaky
  #
  # The dashboard should surface them as "flaky" once enough run history
  # accumulates.  DO NOT include this folder in the default test suite.

  Scenario: Flaky — random 30 % failure on page title
    Given the app is loaded
    Then the page title flakily passes

  Scenario: Flaky — random 30 % failure on nav visibility
    Given the app is loaded
    Then the nav flakily passes

  Scenario: Flaky — random 30 % failure on body presence
    Given the app is loaded
    Then the body flakily passes
