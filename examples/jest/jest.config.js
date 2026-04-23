/** @type {import("jest").Config} */
export default {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  moduleFileExtensions: ["ts", "js"],
  // Map .js imports to .ts source files (required for ESM + ts-jest)
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { useESM: true }],
  },
  reporters: [
    "default",
    [
      "jest-junit",
      {
        outputDirectory: "reports",
        outputName: "junit.xml",
        classNameTemplate: "{classname}",
        titleTemplate: "{title}",
        ancestorSeparator: " > ",
        addFileAttribute: "true",
      },
    ],
  ],
  collectCoverageFrom: ["src/**/*.ts"],
  coverageReporters: ["text", "json-summary"],
  // Flaky tests live in __tests__/flaky/ and are excluded from the default run
  // so they don't block CI. Run them explicitly with test:flaky.
  testPathIgnorePatterns: ["/node_modules/", "/__tests__/flaky/"],
};
