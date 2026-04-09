Feature: Form

  Background:
    Given I visit the form page

  Scenario: Display the form with default values
    Then the form should be visible
    And the priority should default to "medium"

  Scenario: Submit with all fields
    When I enter "New feature" as the item name
    And I select "feature" as the category
    And I select "high" as the priority
    And I enter "A great feature" as the description
    And I check the urgent checkbox
    And I submit the form
    Then the form result should be visible
    And the form result should contain "New feature"

  Scenario: Submit with only required fields
    When I enter "Minimal" as the item name
    And I submit the form
    Then the form result should contain "Minimal"

  Scenario: Reset the form
    When I enter "Something" as the item name
    And I check the urgent checkbox
    And I reset the form
    Then the item name should be empty
    And the urgent checkbox should not be checked
