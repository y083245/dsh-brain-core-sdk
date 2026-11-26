import js from '@eslint/js'
import tseslint from 'typescript-eslint'

const dshOnly = { group: ['@deepseek-ai/*'], message: 'Only satellite-host and satellite-bundle may import DSH packages.' }

export default tseslint.config(
  { ignores: ['**/dist/', '**/dist-web/', '**/node_modules/', 'spikes/**/runs/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Only the satellite packages may touch DSH, which keeps its version churn contained.
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['packages/satellite-host/**', 'packages/satellite-bundle/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [dshOnly] }],
    },
  },
  {
    // A kernel module reaches another module only through its index.ts or the shared contracts.
    // This block replaces the DSH rule above for these files, so it repeats it.
    files: ['apps/kernel/src/*/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        dshOnly,
        { group: ['../*/*', '!../*/index.ts', '!../contracts/*'], message: 'Import another kernel module only through its index.ts or contracts/.' },
      ] }],
    },
  },
  {
    // Only the plugin runtime may use Cordis; every other @deepseek-ai package stays out of the kernel.
    files: ['apps/kernel/src/plugin-runtime/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        { group: ['@deepseek-ai/*', '!@deepseek-ai/cordis'], message: 'Only plugin-runtime may import Cordis.' },
        { group: ['../*/*', '!../*/index.ts', '!../contracts/*'], message: 'Import another kernel module only through its index.ts or contracts/.' },
      ] }],
    },
  },
  {
    // main.ts and cli.ts are the assembly points; they too go through each module's index.ts.
    files: ['apps/kernel/src/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        dshOnly,
        { group: ['./*/*', '!./*/index.ts', '!./contracts/*'], message: 'Import a kernel module only through its index.ts or contracts/.' },
      ] }],
    },
  },
)
