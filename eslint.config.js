const js = require("@eslint/js");
const globals = require("globals");

const nodeGlobals = { ...globals.node };
delete nodeGlobals.crypto;

module.exports = [
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
    },
    rules: {
      "no-unused-vars": ["warn", {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        }],
    },
  },
  {
    files: ["src/renderer/**/*.js"],
    ignores: ["src/renderer/**/*.test.js", "src/renderer/**/*.spec.js"],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: [
      "src/main/**/*.js",
      "src/preload/**/*.js",
      "src/renderer/**/*.test.js",
      "src/renderer/**/*.spec.js",
      "scripts/**/*.js",
    ],
    languageOptions: {
      globals: nodeGlobals,
    },
  },
];
