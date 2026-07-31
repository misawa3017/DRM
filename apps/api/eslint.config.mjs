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
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      // Passport/Nest lifecycle hooks (validate, canActivate, guards, ...)
      // are conventionally declared `async` to satisfy the framework's
      // Promise-returning contract even when a given implementation has no
      // internal `await` (e.g. JwtStrategy#validate). Flagging every such
      // case would mean stripping `async` and breaking callers that rely on
      // synchronous throws becoming rejected promises (see
      // jwt.strategy.spec.ts), which is a worse trade than leaving this rule
      // off for a pattern the framework itself encourages.
      '@typescript-eslint/require-await': 'off',
    },
  },
);
