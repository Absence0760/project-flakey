Feature: Login

  Background:
    Given I visit the login page

  Scenario: Show the login form
    Then I should see the login form
    And I should see the email input
    And I should see the password input
    And I should see the login button

  Scenario: Login with valid credentials
    When I enter "admin@test.com" as the email
    And I enter "password" as the password
    And I click the login button
    Then I should see the login success message
    And I should see the todos page

  Scenario: Show error with invalid credentials
    When I enter "wrong@test.com" as the email
    And I enter "wrong" as the password
    And I click the login button
    Then I should see the login error message

  Scenario: No messages shown initially
    Then I should not see the login success message
    And I should not see the login error message
