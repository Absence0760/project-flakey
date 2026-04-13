Feature: Todos

  Background:
    Given I visit the todos page

  Scenario: Add a new todo
    When I type "Buy groceries" in the todo input
    And I click the add todo button
    Then the todo list should contain "Buy groceries"
    And the todo count should show "1 item"

  Scenario: Add a todo with Enter key
    When I type "Walk the dog" in the todo input and press enter
    Then the todo list should contain "Walk the dog"

  Scenario: Mark a todo as completed
    When I type "Read a book" in the todo input and press enter
    And I check the first todo
    Then the first todo should be marked as done
    And the todo count should show "0 items"

  Scenario: Delete a todo
    When I type "Temporary item" in the todo input and press enter
    Then the todo list should contain "Temporary item"
    When I delete the first todo
    Then the todo list should not contain "Temporary item"

  Scenario: Filter active todos
    When I type "Active task" in the todo input and press enter
    And I type "Done task" in the todo input and press enter
    And I check the last todo
    And I click the active filter
    Then there should be 1 todo visible
    And the todo list should contain "Active task"

  Scenario: Filter completed todos
    When I type "Task A" in the todo input and press enter
    And I type "Task B" in the todo input and press enter
    And I check the first todo
    And I click the completed filter
    Then there should be 1 todo visible
    And the first todo should be marked as done
