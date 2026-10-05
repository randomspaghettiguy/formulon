import js from '@eslint/js';

const nodeAndBrowser = {
  console: 'readonly',
  process: 'readonly',
  performance: 'readonly',
  URL: 'readonly',
};

export default [
  { ignores: ['node_modules/**', 'lib/**', 'tmp/**', 'coverage/**', '.*/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: nodeAndBrowser },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-cond-assign': ['error', 'except-parens'],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { module: 'writable', require: 'readonly' } },
  },
  {
    files: ['test/**'],
    languageOptions: { globals: { describe: 'readonly', it: 'readonly', expect: 'readonly' } },
  },
];
