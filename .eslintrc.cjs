module.exports = {
  root: true,
  env: {
    es2022: true,
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'script',
  },
  extends: ['eslint:recommended'],
  overrides: [
    {
      files: ['src/renderer/**/*.js'],
      excludedFiles: ['src/renderer/**/*.test.js', 'src/renderer/**/*.spec.js'],
      env: {
        browser: true,
      },
    },
    {
      files: [
        'src/main/**/*.js',
        'src/preload/**/*.js',
        'src/renderer/**/*.test.js',
        'src/renderer/**/*.spec.js',
        'scripts/**/*.js',
      ],
      env: {
        node: true,
      },
    },
  ],
  rules: {
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
  },
};
