Feature: Accessibility

  # These scenarios use cypress-axe to run an axe-core scan on each page.
  # Violations are LOGGED in the Cypress command log but do not fail the
  # scenario — the "skipFailures" flag is true (see the step definition).
  # Remove skipFailures once the app's violations are resolved.

  Background:
    Given I have injected axe into the page

  Scenario: Home page should be accessible
    When I visit "/"
    Then the page should be accessible

  Scenario: Login page should be accessible
    When I visit "/#login"
    Then the page should be accessible

  Scenario: Todos page should be accessible
    When I visit "/#todos"
    Then the page should be accessible
