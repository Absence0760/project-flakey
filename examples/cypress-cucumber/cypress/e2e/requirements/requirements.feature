Feature: Requirements traceability

  # Better Testing links Cucumber scenarios to external requirement IDs via
  # Cucumber tags.  Tag a scenario with @req-<ID> and the tag appears in the
  # uploaded result, enabling traceability from test run to requirement.
  #
  # Example: the tag @req-CCF-123 below links this scenario to requirement
  # CCF-123 in your issue tracker.  You can use any ID format that matches
  # your project's convention (Jira, Linear, GitHub Issues, etc.).

  Background:
    Given I visit the todos page

  @req-CCF-123
  Scenario: Add a todo (CCF-123 — user must be able to create tasks)
    When I type "Demonstrate traceability" in the todo input
    And I click the add todo button
    Then the todo list should contain "Demonstrate traceability"

  @req-CCF-124
  Scenario: Complete a todo (CCF-124 — user must be able to mark tasks done)
    When I type "Complete me" in the todo input and press enter
    And I check the first todo
    Then the first todo should be marked as done
