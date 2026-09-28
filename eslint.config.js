import js from '@eslint/js'
import globals from 'globals'
import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import {
  ONE_DOOR_FILES,
  ONE_DOOR_IGNORES,
  ONE_DOOR_PENDING,
  ONE_DOOR_RULES,
} from './apps/web/eslint.one-door.js'

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: ['**/dist/**', '**/build/**', '**/node_modules/**', '**/*.d.ts', 'spikes/**'],
  },
  // Base JS rules
  {
    files: ['**/*.{js,cjs,mjs}'],
    ...js.configs.recommended,
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
  // TypeScript rules (all packages)
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs['recommended'].rules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    },
  },
  // React-specific rules (apps/web only)
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/react-compiler': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/globals': 'off',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  // One door (ADR 0010): the editor writes the document only through
  // commands. Rule and the shrinking list of not-yet-migrated files:
  // apps/web/eslint.one-door.js.
  {
    files: ONE_DOOR_FILES,
    ignores: [...ONE_DOOR_IGNORES, ...ONE_DOOR_PENDING.map((p) => p.file)],
    rules: ONE_DOOR_RULES,
  },
  // Server runtime code must log through pino (structured, leveled, parseable
  // by the prod log pipeline), NOT bare `console.*`. The exceptions below are
  // process bootstrap and CLI tools, which run before/outside the request
  // lifecycle and legitimately write to stdout/stderr directly.
  {
    files: ['apps/server/src/**/*.ts'],
    ignores: [
      'apps/server/src/index.ts', // process bootstrap (banner/fatal before app.log exists)
      'apps/server/src/observability/sentry.ts', // observability init, may log before pino
      'apps/server/src/db/migrate.ts', // migration CLI — stdout progress is the UX
      'apps/server/src/scripts/**/*.ts', // one-shot CLI scripts — console is the output
    ],
    rules: {
      'no-console': 'error',
    },
  },
  // Relax rules for test files — inline `import()` type annotations and scratch
  // unused helpers are fine in tests (vi.hoisted mocks use this pattern).
  {
    files: ['**/*.{test,spec}.{ts,tsx}', '**/__tests__/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'off',
    },
  },
]
