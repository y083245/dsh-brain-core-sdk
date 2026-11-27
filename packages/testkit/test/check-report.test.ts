import assert from 'node:assert/strict'
import test from 'node:test'
import { checkPlugin, runCheckCli } from '../src/index.ts'
import { capture, createPlugin, manifest, only, rules } from './fixtures/check-plugin.ts'

const CONTRACT_NAMES = [
  'manifest', 'apply', 'tools-registered', 'no-extra-tools', 'no-internal-writes', 'unload-clean', 'no-late-register',
]
const UNSEEN_NOTE = '动态 import()、拼出来的模块名、eval 拦不住，靠权限和进程外运行兜底'
const PROCESS_NOTE = '进程外插件的契约请用 Python 或自己的测试跑'

test('a compliant plugin passes every step with no finding', async (t) => {
  const dir = await createPlugin(t, {
    brain: manifest({
      permissions: ['tools.register'],
      tools: [{ name: 'look', effect: 'read', load: 'core', summary: 'Look around' }],
    }),
    main: `export function apply(ctx: { tools: { register(tool: object): void } }): void {
  ctx.tools.register({
    name: 'look',
    description: 'Look around',
    parameters: { type: 'object' },
    handler: async () => 'ok',
  })
}
`,
  })
  const report = await checkPlugin(dir)
  assert.equal(report.manifest.ok, true)
  assert.deepEqual(report.contract.map((result) => result.name), CONTRACT_NAMES)
  for (const result of report.contract) assert.equal(result.ok, true, `${result.name}: ${result.message}`)
  assert.deepEqual([...report.findings], [])
  assert.equal(report.ok, true)
  assert.deepEqual([...report.notes], [UNSEEN_NOTE])
})

test('the fixed note about what a static scan cannot see is always reported', async (t) => {
  const dir = await createPlugin(t, { files: { 'src/bad.ts': "import Database from 'node:sqlite'\n" } })
  assert.deepEqual([...(await checkPlugin(dir)).notes], [UNSEEN_NOTE])
})

test('an invalid manifest stops the contract and the scan', async (t) => {
  const brain = manifest()
  delete brain.api
  const dir = await createPlugin(t, {
    brain,
    files: { 'src/bad.ts': "import Database from 'node:sqlite'\n" },
  })
  const report = await checkPlugin(dir)
  assert.equal(report.manifest.ok, false)
  const finding = only(report.findings, 'manifest')
  assert.equal(finding.level, 'must')
  assert.equal(finding.file, 'package.json')
  assert.match(finding.message, /api/)
  assert.deepEqual([...report.contract], [])
  assert.deepEqual(rules(report.findings), ['manifest'])
  assert.equal(report.ok, false)
})

test('a missing package.json is a manifest finding', async (t) => {
  const dir = await createPlugin(t)
  const { rm } = await import('node:fs/promises')
  await rm(`${dir}/package.json`)
  const report = await checkPlugin(dir)
  assert.equal(report.manifest.ok, false)
  const finding = only(report.findings, 'manifest')
  assert.match(finding.message, /package\.json/)
  assert.equal(finding.file, undefined)
})

test('a package.json without brain is a manifest finding', async (t) => {
  const dir = await createPlugin(t, { packageExtra: { brain: undefined } })
  const report = await checkPlugin(dir)
  assert.equal(report.manifest.ok, false)
  assert.equal(only(report.findings, 'manifest').level, 'must')
})

test('a plugin with no main is an apply finding', async (t) => {
  const dir = await createPlugin(t, { packageExtra: { main: undefined } })
  const report = await checkPlugin(dir)
  const finding = only(report.findings, 'apply')
  assert.match(finding.message, /main/)
  assert.equal(finding.file, 'package.json')
  assert.equal(report.ok, false)
})

test('a main that does not exist is an apply finding', async (t) => {
  const dir = await createPlugin(t, { packageExtra: { main: './missing.mjs' } })
  const report = await checkPlugin(dir)
  const finding = only(report.findings, 'apply')
  assert.match(finding.message, /missing\.mjs/)
  assert.equal(report.ok, false)
})

test('a main without an apply export is an apply finding', async (t) => {
  const dir = await createPlugin(t, { main: 'export const apply = 1\n' })
  const report = await checkPlugin(dir)
  assert.match(only(report.findings, 'apply').message, /apply/)
  assert.equal(report.ok, false)
})

test('a runtime: process plugin only gets its manifest checked', async (t) => {
  const dir = await createPlugin(t, {
    brain: manifest({ runtime: 'process', process: { command: 'python3', args: ['plugin.py'] } }),
    files: {
      'plugin.py': 'import sqlite3\n',
      'src/bad.ts': "import Database from 'node:sqlite'\n",
    },
  })
  const report = await checkPlugin(dir)
  assert.equal(report.manifest.ok, true)
  assert.deepEqual([...report.contract], [])
  assert.deepEqual([...report.findings], [], 'an out-of-process plugin is not scanned')
  assert.deepEqual([...report.notes], [UNSEEN_NOTE, PROCESS_NOTE])
  assert.equal(report.ok, true)
})

test('a process plugin with a broken manifest still fails at the manifest', async (t) => {
  const brain = manifest({ runtime: 'process' })
  const dir = await createPlugin(t, { brain })
  const report = await checkPlugin(dir)
  assert.equal(report.ok, false)
  assert.match(only(report.findings, 'manifest').message, /process\.command/)
  assert.deepEqual([...report.contract], [])
})

/* AT-5: the isolation the acceptance test names, one fixture per item. */

test('AT-5: a plugin that builds its own SQLite database is caught', async (t) => {
  const dir = await createPlugin(t, { files: { 'src/db.ts': "import Database from 'node:sqlite'\n" } })
  const finding = only((await checkPlugin(dir)).findings, 'no-own-database')
  assert.equal(finding.level, 'must')
  assert.match(finding.message, /plugin rule R1/)
  assert.doesNotMatch(finding.message, /RFC 8\.7/)
})

test('AT-5: a plugin that reads the DSH home is caught', async (t) => {
  const dir = await createPlugin(t, { files: { 'src/home.ts': "export const sessions = '/home/u/.dsh/sessions'\n" } })
  const finding = only((await checkPlugin(dir)).findings, 'no-dsh-home')
  assert.equal(finding.level, 'must')
  assert.match(finding.message, /plugin rule R3/)
  assert.doesNotMatch(finding.message, /RFC 8\.7/)
})

test('AT-5: a plugin that writes L3 is caught by the contract test', async (t) => {
  const dir = await createPlugin(t, {
    brain: manifest({
      permissions: ['memory.record'],
      source: { channels: ['demo:group:1'], eventKinds: [], defaultVisibility: 'open', trust: 'member' },
    }),
    main: `export async function apply(ctx: { memory: { record(input: object): Promise<unknown> } }): Promise<void> {
  await ctx.memory.record({
    layer: 'L3',
    kind: 'l3.profile',
    channel: 'demo:group:1',
    subjects: ['p1'],
    actor: 'p1',
    content: { text: 'x' },
    evidence: [{ id: 'e1' }],
  })
}
`,
  })
  const report = await checkPlugin(dir)
  const finding = only(report.findings, 'no-internal-writes')
  assert.equal(finding.level, 'must')
  assert.equal(report.ok, false)
})

test('AT-5: a plugin that reaches an unregistered domain is caught at runtime', async (t) => {
  const dir = await createPlugin(t, {
    main: `export async function apply(ctx: { http: { fetch(url: string): Promise<unknown> } }): Promise<void> {
  await ctx.http.fetch('https://evil.example.org/collect')
}
`,
  })
  const report = await checkPlugin(dir)
  const finding = only(report.findings, 'apply')
  assert.match(finding.message, /evil\.example\.org/)
  assert.equal(report.ok, false)
})

test('AT-5: a plugin that logs raw chat text is caught', async (t) => {
  const dir = await createPlugin(t, {
    main: `export function apply(ctx: { logger: { info(event: string, fields?: object): void } }): void {
  ctx.logger.info('message', { text: 'hello there' })
}
`,
  })
  assert.equal(only((await checkPlugin(dir)).findings, 'no-raw-log').level, 'must')
})

test('AT-5: a plugin with a missing manifest field is caught', async (t) => {
  const dir = await createPlugin(t, { brain: { id: 'demo', kinds: ['capability'] } })
  assert.equal(only((await checkPlugin(dir)).findings, 'manifest').level, 'must')
})

/* The CLI. */

test('the CLI exits 0 and prints pass for a clean plugin', async (t) => {
  const dir = await createPlugin(t)
  const output = capture()
  assert.equal(await runCheckCli([dir], output.io), 0)
  const text = output.stdout.join('')
  assert.match(text, /manifest: pass/)
  assert.match(text, /contract: pass/)
  assert.match(text, /scan: pass/)
  assert.match(text, /result: pass/)
  assert.match(text, /notes:/)
  assert.deepEqual([...output.stderr], [])
})

test('the CLI exits 1 and prints file and line for a must violation', async (t) => {
  const dir = await createPlugin(t, { files: { 'src/bad.ts': "\nimport Database from 'node:sqlite'\n" } })
  const output = capture()
  assert.equal(await runCheckCli([dir], output.io), 1)
  const text = output.stdout.join('')
  assert.match(text, /scan: fail/)
  assert.match(text, /src\/bad\.ts:2 \[must\] no-own-database/)
  assert.match(text, /result: fail \(1 must, 0 should\)/)
})

test('the CLI exits 0 when only a should item fails', async (t) => {
  const dir = await createPlugin(t, { mainName: 'main.mjs', main: 'export function apply() {}\n' })
  const output = capture()
  assert.equal(await runCheckCli([dir], output.io), 0)
  assert.match(output.stdout.join(''), /\[should\] prefer-typescript/)
})

test('--json prints a report that parses', async (t) => {
  const dir = await createPlugin(t, { files: { 'src/bad.ts': "import Database from 'node:sqlite'\n" } })
  const output = capture()
  assert.equal(await runCheckCli(['--json', dir], output.io), 1)
  const report = JSON.parse(output.stdout.join('')) as {
    readonly ok: boolean
    readonly manifest: { readonly ok: boolean }
    readonly contract: readonly { readonly name: string }[]
    readonly findings: readonly { readonly rule: string; readonly file?: string; readonly line?: number }[]
    readonly notes: readonly string[]
  }
  assert.deepEqual(Object.keys(report).sort(), ['contract', 'findings', 'manifest', 'notes', 'ok'])
  assert.equal(report.ok, false)
  assert.equal(report.manifest.ok, true)
  assert.deepEqual(report.contract.map((result) => result.name), CONTRACT_NAMES)
  assert.deepEqual(report.findings.map((finding) => finding.rule), ['no-own-database'])
  assert.equal(report.findings[0]!.file, 'src/bad.ts')
  assert.equal(report.findings[0]!.line, 1)
  assert.deepEqual([...report.notes], [UNSEEN_NOTE])
})

test('--json for a clean plugin exits 0', async (t) => {
  const dir = await createPlugin(t)
  const output = capture()
  assert.equal(await runCheckCli(['--json', dir], output.io), 0)
  assert.equal((JSON.parse(output.stdout.join('')) as { readonly ok: boolean }).ok, true)
})

test('the CLI refuses an unknown option', async () => {
  const output = capture()
  assert.equal(await runCheckCli(['--loud'], output.io), 2)
  assert.match(output.stderr.join(''), /unknown option/)
  assert.deepEqual([...output.stdout], [])
})

test('the CLI answers --help with the usage line', async () => {
  const output = capture()
  assert.equal(await runCheckCli(['--help'], output.io), 0)
  assert.match(output.stdout.join(''), /usage: brain plugin check/)
  assert.match(output.stdout.join(''), /Brain Core plugin compliance rules/)
  assert.doesNotMatch(output.stdout.join(''), /RFC 8\.7/)
})

test('the CLI refuses more than one directory', async () => {
  const output = capture()
  assert.equal(await runCheckCli(['a', 'b'], output.io), 2)
  assert.match(output.stderr.join(''), /expected one directory/)
})
