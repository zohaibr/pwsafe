import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['node_modules', 'out', 'dist', 'release', 'coverage', 'test/fixtures'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The renderer is sandboxed: it must never import Node or Electron main-process modules.
      'no-restricted-imports': [
        'error',
        { patterns: ['node:*', 'electron', '../../main/*', '../main/*'] },
      ],
    },
  },
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      // Shared code runs in both processes: no Node, DOM-only or Electron imports.
      'no-restricted-imports': ['error', { patterns: ['node:*', 'electron'] }],
    },
  },
  {
    files: ['scripts/**/*.{js,mjs,ts}'],
    rules: { 'no-console': 'off' },
  },
)
