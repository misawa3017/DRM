// @ts-check
import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs', 'dist/**', 'generated/**', 'coverage/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintConfigPrettier,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      // TypeScript already checks for undefined identifiers; no-undef produces
      // false positives against ambient/global types (e.g. test globals).
      'no-undef': 'off',
      // BullMQ's WorkerHost#process contract requires an async, Promise-
      // returning method even for processors (like HealthCheckProcessor)
      // whose work is entirely synchronous. Same trade-off as
      // apps/api/eslint.config.mjs applies to Passport/Nest lifecycle
      // hooks: stripping `async` would break the framework's contract for
      // a rule that's flagging conformance to that contract, not a bug.
      '@typescript-eslint/require-await': 'off',
    },
  },
);
