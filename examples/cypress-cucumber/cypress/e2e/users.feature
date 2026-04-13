Feature: Users Table

  Background:
    Given I visit the users page

  Scenario: Display all users
    Then I should see 5 users in the table

  Scenario: Sorted by name ascending by default
    Then the first user should be "Alice Johnson"

  Scenario: Sort by name descending
    When I click the name sort header
    Then the first user should be "Eve Davis"

  Scenario: Open and cancel delete modal
    When I click delete for "alice@test.com"
    Then the delete modal should be visible
    When I cancel the delete
    Then the delete modal should not be visible
    And I should see 5 users in the table

  Scenario: Delete a user
    When I click delete for "bob@test.com"
    And I confirm the delete
    Then I should see 4 users in the table
