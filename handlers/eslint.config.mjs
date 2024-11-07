// @ts-check

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

const config = [
  {
    ignores: ['src/**/*.mjs', 'src/**/*.d.*'],
  },
  ...tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
  ),
  {
    // TODO These are temporary and need to be removed and code fixed
    rules: {
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
export default config;
