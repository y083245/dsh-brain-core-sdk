import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

async function lint(filePath: string, code: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: repoRoot })
  const [result] = await eslint.lintText(code, { filePath: path.join(repoRoot, filePath) })
  return (result?.messages ?? []).map((message) => message.ruleId ?? '')
}

function hasRestricted(ruleIds: readonly string[]): boolean {
  return ruleIds.includes('no-restricted-imports')
}

test('a kernel module reaches another module only through index.ts or contracts/', async () => {
  const file = 'apps/kernel/src/memory-context/fixture.ts'
  assert.equal(hasRestricted(await lint(file, "import { open } from '../memory-store/sqlite.ts'")), true)
  assert.equal(hasRestricted(await lint(file, "import { DSH } from '@deepseek-ai/dsh'")), true)
  assert.equal(hasRestricted(await lint(file, "export { x } from '../home/secret.ts'")), true)
  assert.equal(hasRestricted(await lint(file, "import { store } from '../memory-store/index.ts'")), false)
  assert.equal(hasRestricted(await lint(file, "import type { Clock } from '../contracts/index.ts'")), false)
  assert.equal(hasRestricted(await lint(file, "import { local } from './local.ts'")), false)
})

test('a deeper module can not reach up past its own module', async () => {
  assert.equal(hasRestricted(await lint('apps/kernel/src/home/deep/inner.ts', "export { x } from '../../main.ts'")), true)
})

test('main.ts and cli.ts go through each module index.ts too', async () => {
  const file = 'apps/kernel/src/main.ts'
  assert.equal(hasRestricted(await lint(file, "import { server } from './memory-api/server.ts'")), true)
  assert.equal(hasRestricted(await lint(file, "import { DSH } from '@deepseek-ai/dsh'")), true)
  assert.equal(hasRestricted(await lint(file, "import { api } from './memory-api/index.ts'")), false)
})
