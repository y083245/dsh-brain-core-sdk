import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { checkPlugin } from '../src/index.ts'
import { createPlugin, only } from './fixtures/check-plugin.ts'

/** Every violating file starts with a comment, so a finding on line 2 proves the line is reported. */
async function expectViolation(t: TestContext, code: string, rule: string, line = 2): Promise<void> {
  const dir = await createPlugin(t, { files: { 'src/bad.ts': `// fixture\n${code}` } })
  const report = await checkPlugin(dir)
  const finding = only(report.findings, rule)
  assert.equal(finding.level, 'must', `${rule} must be a "must" item`)
  assert.equal(finding.file, 'src/bad.ts')
  assert.equal(finding.line, line)
  assert.equal(report.ok, false, 'a must finding makes the report fail')
}

async function expectClean(t: TestContext, code: string, rule: string): Promise<void> {
  const dir = await createPlugin(t, { files: { 'src/fine.ts': code } })
  const report = await checkPlugin(dir)
  assert.deepEqual(report.findings.filter((finding) => finding.rule === rule), [], `${rule} should stay quiet`)
}

const OWN_DATABASE_MODULES = ['node:sqlite', 'better-sqlite3', 'sqlite3', 'sql.js', 'lowdb', 'level', 'nedb']
for (const moduleName of OWN_DATABASE_MODULES) {
  test(`no-own-database catches an import of ${moduleName}`, (t) => expectViolation(t, `import Database from '${moduleName}'\n`, 'no-own-database'))
}

const NETWORK_MODULES = ['node:http', 'node:https', 'node:net', 'node:tls', 'undici', 'axios', 'node-fetch', 'got', 'ws']
for (const moduleName of NETWORK_MODULES) {
  test(`no-direct-network catches an import of ${moduleName}`, (t) => expectViolation(t, `import client from '${moduleName}'\n`, 'no-direct-network'))
}

const NETWORK_GLOBALS: readonly { readonly name: string; readonly code: string }[] = [
  { name: 'fetch', code: "const answer = fetch('/x')\n" },
  { name: 'WebSocket', code: "const socket = new WebSocket('ws://example.com')\n" },
  { name: 'XMLHttpRequest', code: 'const request = new XMLHttpRequest()\n' },
  { name: 'globalThis.fetch', code: "const answer = globalThis.fetch('/x')\n" },
]
for (const { name, code } of NETWORK_GLOBALS) {
  test(`no-direct-network catches the global ${name}`, (t) => expectViolation(t, code, 'no-direct-network'))
}

test('no-direct-network treats a locally declared fetch as local', async (t) => {
  await expectClean(t, `function fetch(url: string): string {
  return url
}
const answer = fetch('/local')
`, 'no-direct-network')
})

test('no-direct-network treats ctx.http.fetch as the approved path', async (t) => {
  await expectClean(t, `export async function apply(ctx: { http: { fetch(url: string): Promise<unknown> } }): Promise<void> {
  await ctx.http.fetch('https://api.example.com/x')
}
`, 'no-direct-network')
})

test('no-direct-network is not fooled by a string or a comment', async (t) => {
  await expectClean(t, `// fetch('https://example.com') stays a comment
const text = "fetch('https://example.com')"
export const seen = text
`, 'no-direct-network')
})

test('no-direct-network ignores a local object that happens to offer fetch', async (t) => {
  await expectClean(t, `const WebSocket = { open: () => 'local' }
export const opener = WebSocket.open
`, 'no-direct-network')
})

const CORDIS_MODULES = ['cordis', '@deepseek-ai/cordis']
for (const moduleName of CORDIS_MODULES) {
  test(`no-cordis catches an import of ${moduleName}`, (t) => expectViolation(t, `import { Context } from '${moduleName}'\n`, 'no-cordis'))
}

const DSH_MODULES = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-subprocess-local']
for (const moduleName of DSH_MODULES) {
  test(`no-dsh catches an import of ${moduleName}`, (t) => expectViolation(t, `import thing from '${moduleName}'\n`, 'no-dsh'))
}

const CHILD_PROCESS_COMMANDS = ['spawn', 'exec', 'execFile']
for (const command of CHILD_PROCESS_COMMANDS) {
  test(`no-dsh catches child_process.${command}("dsh")`, (t) => expectViolation(t, `import { ${command} } from 'node:child_process'\n${command}('dsh', [])\n`, 'no-dsh', 3))
}

test('no-dsh catches a namespace import calling exec', (t) => expectViolation(t, `import cp from 'node:child_process'\ncp.exec('dsh')\n`, 'no-dsh', 3))

test('no-dsh catches require("child_process").execFile', (t) => expectViolation(t, `require('node:child_process').execFile('dsh', [])\n`, 'no-dsh'))

test('no-dsh leaves another command alone', async (t) => {
  await expectClean(t, `import { spawn } from 'node:child_process'
spawn('node', ['--version'])
spawn('dsh-helper', [])
`, 'no-dsh')
})

const DSH_HOME_CASES: readonly { readonly label: string; readonly code: string }[] = [
  { label: 'a forward-slash path', code: "const home = '/home/u/.dsh/sessions'\n" },
  { label: 'a backslash path', code: "const home = 'C:\\\\Users\\\\u\\\\.dsh\\\\sessions'\n" },
  { label: 'a bare .dsh segment', code: "const name = '.dsh'\n" },
  { label: 'a template literal head', code: 'const home = `${base}/.dsh/sessions`\n' },
  { label: 'a template literal span', code: 'const home = `${base}/.dsh/${name}`\n' },
  { label: 'the DSH_HOME variable name', code: "const key = 'DSH_HOME'\n" },
  { label: 'process.env.DSH_HOME', code: 'const home = process.env.DSH_HOME\n' },
]
for (const { label, code } of DSH_HOME_CASES) {
  test(`no-dsh-home catches ${label}`, (t) => expectViolation(t, code, 'no-dsh-home'))
}

test('no-dsh-home leaves .dshrc alone', async (t) => {
  await expectClean(t, "const file = '/home/u/.dshrc/settings'\n", 'no-dsh-home')
})

const FS_WRITES = [
  'writeFile', 'appendFile', 'mkdir', 'rm', 'rmdir', 'unlink', 'rename', 'copyFile', 'cp', 'createWriteStream', 'symlink',
] as const
const FS_WRITE_NAMES = FS_WRITES.flatMap((name) => (name === 'createWriteStream' ? [name] : [name, `${name}Sync`]))
for (const name of FS_WRITE_NAMES) {
  test(`no-fs-write catches an import of ${name}`, (t) => expectViolation(t, `import { ${name} } from 'node:fs/promises'\n`, 'no-fs-write'))
}

const FS_MODULES = ['node:fs', 'fs', 'node:fs/promises', 'fs/promises']
for (const moduleName of FS_MODULES) {
  test(`no-fs-write catches a write imported from ${moduleName}`, (t) => expectViolation(t, `import { writeFile } from '${moduleName}'\n`, 'no-fs-write'))
}

test('no-fs-write catches a namespace call', (t) => expectViolation(t, `import * as fs from 'node:fs'\nfs.mkdirSync('state')\n`, 'no-fs-write', 3))

test('no-fs-write catches a require at the call site', (t) => expectViolation(t, "require('node:fs').rmSync('x')\n", 'no-fs-write'))

test('no-fs-write catches a destructured require', (t) => expectViolation(t, "const { unlinkSync } = require('node:fs')\n", 'no-fs-write'))

test('no-fs-write catches fs.promises', (t) => expectViolation(t, `import fs from 'node:fs'\nfs.promises.writeFile('x', 'y')\n`, 'no-fs-write', 3))

test('no-fs-write catches a renamed promises namespace', (t) => expectViolation(t, `import { promises as fsp } from 'node:fs'\nfsp.rm('x')\n`, 'no-fs-write', 3))

test('no-fs-write catches promises destructured from require', (t) => expectViolation(t, `const { promises: fsp } = require('node:fs')\nfsp.unlinkSync('x')\n`, 'no-fs-write', 3))

test('no-fs-write leaves a local promises object alone', async (t) => {
  await expectClean(t, `const fs = { promises: { writeFile: () => 'local' } }
export const run = () => fs.promises.writeFile()
`, 'no-fs-write')
})

test('no-fs-write leaves readFile alone', async (t) => {
  await expectClean(t, `import { readFile } from 'node:fs/promises'
export const read = () => readFile('x')
`, 'no-fs-write')
})

test('no-fs-write leaves an unrelated object alone', async (t) => {
  await expectClean(t, `const fs = { writeFile: () => 'local' }
export const run = () => fs.writeFile()
`, 'no-fs-write')
})

const LOG_LEVELS = ['info', 'warn', 'error'] as const
const RAW_LOG_KEYS = ['content', 'text', 'message', 'body', 'prompt'] as const
for (const level of LOG_LEVELS) {
  for (const key of RAW_LOG_KEYS) {
    test(`no-raw-log catches ctx.logger.${level} with ${key}`, (t) => expectViolation(
      t,
      `export function apply(ctx: { logger: Record<'${level}', (event: string, fields?: object) => void } }): void {\n  ctx.logger.${level}('boot', { ${key}: 'hello' })\n}\n`,
      'no-raw-log',
      3,
    ))
  }
}

test('no-raw-log follows a renamed apply parameter', (t) => expectViolation(
  t,
  `export function apply(context: { logger: { info(event: string, fields?: object): void } }): void {\n  context.logger.info('boot', { content: 'hello' })\n}\n`,
  'no-raw-log',
  3,
))

test('no-raw-log follows a destructured logger', (t) => expectViolation(
  t,
  `export const apply = ({ logger }: { logger: { warn(event: string, fields?: object): void } }) => {\n  logger.warn('boot', { text: 'hello' })\n}\n`,
  'no-raw-log',
  3,
))

test('no-raw-log leaves harmless fields alone', async (t) => {
  await expectClean(t, `export function apply(ctx: { logger: { info(event: string, fields?: object): void } }): void {
  ctx.logger.info('boot', { count: 2, ok: true })
}
`, 'no-raw-log')
})

test('no-raw-log ignores a logger that is not the apply context', async (t) => {
  await expectClean(t, `function helper(logger: { info(event: string, fields?: object): void }): void {
  logger.info('boot', { content: 'hello' })
}
export const run = helper
`, 'no-raw-log')
})

test('prefer-typescript is a should finding when there is no TypeScript source', async (t) => {
  const dir = await createPlugin(t, { mainName: 'main.mjs', main: 'export function apply() {}\n' })
  const report = await checkPlugin(dir)
  const finding = only(report.findings, 'prefer-typescript')
  assert.equal(finding.level, 'should')
  assert.equal(finding.file, undefined)
  assert.equal(report.ok, true, 'a should finding does not fail the report')
})

test('prefer-typescript stays quiet for a .mts main', async (t) => {
  const dir = await createPlugin(t)
  const report = await checkPlugin(dir)
  assert.deepEqual(report.findings.filter((finding) => finding.rule === 'prefer-typescript'), [])
})

test('the scan skips node_modules, test directories and dist beside src', async (t) => {
  const dir = await createPlugin(t, {
    files: {
      'node_modules/dep/bad.ts': "import Database from 'node:sqlite'\n",
      'test/bad.ts': "import Database from 'node:sqlite'\n",
      'tests/bad.ts': "import Database from 'node:sqlite'\n",
      '__tests__/bad.ts': "import Database from 'node:sqlite'\n",
      'dist/bad.ts': "import Database from 'node:sqlite'\n",
      '.git/hooks/bad.ts': "import Database from 'node:sqlite'\n",
      'src/ok.ts': 'export const fine = 1\n',
      'src/deep/node_modules/bad.ts': "import Database from 'node:sqlite'\n",
    },
  })
  const report = await checkPlugin(dir)
  assert.deepEqual(report.findings.filter((finding) => finding.rule === 'no-own-database'), [])
})

test('the scan still walks dist when there is no src', async (t) => {
  const dir = await createPlugin(t, { files: { 'dist/bad.ts': "import Database from 'node:sqlite'\n" } })
  const report = await checkPlugin(dir)
  assert.equal(only(report.findings, 'no-own-database').file, 'dist/bad.ts')
})

test('the scan reports the file that is caught beside the ignored ones', async (t) => {
  const dir = await createPlugin(t, {
    files: {
      'test/bad.ts': "import Database from 'node:sqlite'\n",
      'lib/bad.ts': "\nimport Database from 'node:sqlite'\n",
    },
  })
  const report = await checkPlugin(dir)
  const finding = only(report.findings, 'no-own-database')
  assert.equal(finding.file, 'lib/bad.ts')
  assert.equal(finding.line, 2)
})

test('no-direct-network treats a parameter named fetch as local', async (t) => {
  await expectClean(t, `export function call(fetch: (url: string) => string): string {
  return fetch('/local')
}
`, 'no-direct-network')
})

test('no-own-database catches a literal dynamic import', (t) => expectViolation(t, "export const load = () => import('node:sqlite')\n", 'no-own-database'))

test('no-raw-log catches a shorthand and a quoted key', async (t) => {
  const shorthand = await createPlugin(t, {
    main: `const content = 'hello'
export function apply(ctx: { logger: { info(event: string, fields?: object): void } }): void {
  ctx.logger.info('boot', { content })
}
`,
  })
  assert.equal(only((await checkPlugin(shorthand)).findings, 'no-raw-log').line, 3)
  const quoted = await createPlugin(t, {
    main: `export function apply(ctx: { logger: { info(event: string, fields?: object): void } }): void {
  ctx.logger.info('boot', { 'body': 'hello' })
}
`,
  })
  assert.equal(only((await checkPlugin(quoted)).findings, 'no-raw-log').line, 2)
})

test('the scan parses code instead of matching text', async (t) => {
  await expectClean(t, `// import Database from 'node:sqlite'
const text = "import Database from 'node:sqlite'"
export const seen = text
`, 'no-own-database')
})

test('the scan reads .js, .mjs, .ts and .mts', async (t) => {
  const dir = await createPlugin(t, {
    files: {
      'a.js': "import Database from 'node:sqlite'\n",
      'b.mjs': "import Database from 'node:sqlite'\n",
      'c.ts': "import Database from 'node:sqlite'\n",
      'd.mts': "import Database from 'node:sqlite'\n",
    },
  })
  const report = await checkPlugin(dir)
  assert.deepEqual(
    report.findings.filter((finding) => finding.rule === 'no-own-database').map((finding) => finding.file).sort(),
    ['a.js', 'b.mjs', 'c.ts', 'd.mts'],
  )
})

/* Review round two: lock the behaviour each of these mutations would otherwise change unnoticed. */

test('no-cordis catches a subpath of the Cordis package', (t) => expectViolation(t, `import { Context } from 'cordis/foo'\n`, 'no-cordis'))

test('no-own-database catches a re-export from the module', (t) => expectViolation(t, `export { Database } from 'better-sqlite3'\n`, 'no-own-database'))

test('no-own-database catches an import equals require', (t) => expectViolation(t, `import Database = require('sqlite3')\n`, 'no-own-database'))

test('no-raw-log follows a renamed destructured logger', (t) => expectViolation(
  t,
  `export function apply({ logger: log }: { logger: { info(event: string, fields?: object): void } }): void {\n  log.info('boot', { content: 'hello' })\n}\n`,
  'no-raw-log',
  3,
))

test('no-raw-log follows an apply property holding an arrow function', (t) => expectViolation(
  t,
  `export default {
  apply: (ctx: { logger: { info(event: string, fields?: object): void } }) => {
    ctx.logger.info('boot', { text: 'hello' })
  },
}
`,
  'no-raw-log',
  4,
))

test('no-dsh-home catches a .dsh path opening a template literal', (t) => expectViolation(t, 'const home = `.dsh/${session}`\n', 'no-dsh-home'))

test('no-raw-log matches a key whatever its case', (t) => expectViolation(
  t,
  `export function apply(ctx: { logger: { info(event: string, fields?: object): void } }): void {\n  ctx.logger.info('boot', { Content: 'hello' })\n}\n`,
  'no-raw-log',
  3,
))

test('no-direct-network ignores the name of a declaration and of a parameter', async (t) => {
  await expectClean(t, `const fetch = ctx.http.fetch
function f(fetch: (url: string) => string): string {
  return fetch('/local')
}
export const use = f
`, 'no-direct-network')
})

test('no-direct-network ignores a catch binding named fetch', async (t) => {
  await expectClean(t, `try {
  throw new Error('x')
} catch (fetch) {
  fetch('/local')
}
`, 'no-direct-network')
})

test('no-direct-network resolves a var hoisted out of a block', async (t) => {
  await expectClean(t, `export function f(): string {
  {
    var fetch = (url: string) => url
  }
  return fetch('/local')
}
`, 'no-direct-network')
})

test('no-direct-network does not let a block-scoped const escape its block', (t) => expectViolation(t, `{
  const fetch = (url: string) => url
}
fetch('/local')
`, 'no-direct-network', 5))

test('no-direct-network does not read a var declaration name as the global', async (t) => {
  // The scanner does not enter an unbraced `var` into its scope bookkeeping, so the declaration
  // name itself is what keeps this from being reported as the global fetch.
  await expectClean(t, 'if (true) var fetch = (url: string) => url\n', 'no-direct-network')
})
