import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { validateManifest, type PluginKind } from '@brain-core/sdk'
import { checkPlugin } from '@brain-core/testkit'
import {
  generateProject, idError, parseArgs, resolveOptions, runCli, USAGE,
  type PromptIo, type Runtime,
} from '../src/index.ts'
import { linkWorkspace, PluginProcess, run, tempDir } from './helpers.ts'

const KINDS: readonly PluginKind[] = ['channel', 'activity', 'capability', 'memory-provider']
const RUNTIMES: readonly Runtime[] = ['node', 'process']
const NODE_FILES = [
  '.github/workflows/ci.yml', 'README.md', 'package.json', 'src/config.ts', 'src/index.ts',
  'test/plugin.test.ts', 'tsconfig.json',
]
const PROCESS_FILES = ['README.md', 'main.py', 'package.json', 'pyproject.toml']

interface GeneratedPackage {
  readonly brain?: Record<string, unknown>
  readonly scripts?: Record<string, string>
  readonly [key: string]: unknown
}

async function generatedPackage(dir: string): Promise<GeneratedPackage> {
  return JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as GeneratedPackage
}

async function scaffoldInto(t: TestContext, kind: PluginKind, runtime: Runtime): Promise<string> {
  const parent = await tempDir(t, 'scaffold')
  const dir = path.join(parent, 'demo-plugin')
  await generateProject({ dir, id: 'demo-plugin', kind, runtime })
  return dir
}

/** Every file written by a template, so a leftover placeholder cannot hide in an untested corner. */
async function treeFiles(root: string, base = root): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...await treeFiles(full, base))
    else files.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return files.sort()
}

function answers(...values: readonly string[]): PromptIo & { readonly prompts: string[] } {
  const prompts: string[] = []
  const queue = [...values]
  return {
    prompts,
    stdout: () => undefined,
    stderr: () => undefined,
    question: async (prompt: string) => {
      prompts.push(prompt)
      const value = queue.shift()
      if (value === undefined) throw new Error(`unexpected prompt: ${prompt}`)
      return value
    },
  }
}

function silent(): PromptIo & { readonly prompts: string[] } {
  const prompts: string[] = []
  return {
    prompts,
    stdout: () => undefined,
    stderr: () => undefined,
    question: async (prompt: string) => {
      prompts.push(prompt)
      throw new Error(`unexpected prompt: ${prompt}`)
    },
  }
}

for (const runtime of RUNTIMES) {
  for (const kind of KINDS) {
    test(`generates the ${runtime} ${kind} template, and the manifest validates`, async (t) => {
      const dir = await scaffoldInto(t, kind, runtime)
      const pkg = await generatedPackage(dir)
      const manifest = validateManifest(pkg.brain)
      assert.equal(manifest.ok, true, manifest.ok ? '' : JSON.stringify(manifest.errors))
      assert.equal((pkg.brain as { readonly id: string }).id, 'demo-plugin')
      assert.deepEqual((pkg.brain as { readonly kinds: readonly string[] }).kinds, [kind])
      assert.deepEqual(await treeFiles(dir), runtime === 'node' ? NODE_FILES : PROCESS_FILES)
      assert.equal(pkg.scripts?.test, runtime === 'node' ? 'node --test "test/*.test.ts"' : undefined)

      for (const file of await treeFiles(dir)) {
        const text = await readFile(path.join(dir, ...file.split('/')), 'utf8')
        assert.equal(text.includes('__ID__'), false, `${file} still contains __ID__`)
        assert.equal(/__[A-Z][A-Z0-9_]*__/.test(text), false, `${file} still contains a template placeholder`)
      }
    })
  }
}

const EXPECTED_PERMISSIONS: Readonly<Record<PluginKind, readonly string[]>> = {
  channel: ['channel.provide', 'channel.send', 'agent.session', 'memory.ingest', 'tools.register'],
  activity: ['schedule.ownTime', 'agent.session', 'memory.ingest', 'tools.register'],
  capability: ['tools.register'],
  'memory-provider': ['memory.readL0', 'memory.writeDerived', 'tools.register'],
}

for (const kind of KINDS) {
  test(`the ${kind} template declares its permissions`, async (t) => {
    const dir = await scaffoldInto(t, kind, 'node')
    const manifest = (await generatedPackage(dir)).brain as {
      readonly permissions: readonly string[]
      readonly tools: readonly Record<string, unknown>[]
      readonly source?: { readonly channels: readonly string[]; readonly eventKinds: readonly string[]; readonly trust: string }
    }
    for (const permission of EXPECTED_PERMISSIONS[kind]) {
      assert.ok(manifest.permissions.includes(permission), `${kind} is missing ${permission}`)
    }
    assert.equal(manifest.permissions.length, new Set(manifest.permissions).size)
    assert.equal(manifest.tools.length, 1)
    assert.equal(manifest.tools[0]!.name, 'hello')
    if (kind === 'channel' || kind === 'activity') {
      assert.ok(manifest.source, `${kind} writes memory and needs source`)
      assert.equal(manifest.source.channels[0], 'demo-plugin:note:example')
      assert.deepEqual(manifest.source.eventKinds, ['demo-plugin.note'])
      assert.equal(manifest.source.trust, kind === 'activity' ? 'external' : 'member')
    } else {
      assert.equal(manifest.source, undefined, `${kind} must not declare source`)
    }
  })
}

test('the node template registers hello and writes memory only when it may', async (t) => {
  for (const kind of KINDS) {
    const dir = await scaffoldInto(t, kind, 'node')
    const source = await readFile(path.join(dir, 'src', 'index.ts'), 'utf8')
    assert.ok(source.includes("name: 'hello'"), `${kind} does not register hello`)
    const writes = source.includes('await ctx.memory.ingest')
    assert.equal(writes, kind === 'channel' || kind === 'activity', `${kind} ingest mismatch`)
  }
})

for (const kind of KINDS) {
  test(`the node ${kind} template passes checkPlugin and its own tests`, async (t) => {
    const dir = await scaffoldInto(t, kind, 'node')
    await linkWorkspace(dir)
    const report = await checkPlugin(dir)
    assert.equal(report.ok, true, JSON.stringify(report.findings, null, 2))
    assert.ok(report.contract.length > 0, 'the contract tests should run')
    assert.ok(report.contract.every((result) => result.ok), JSON.stringify(report.contract, null, 2))

    const result = await run(process.execPath, ['--test', 'test/plugin.test.ts'], dir)
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
  })
}

test('the generated test checks memory by permission, not by kind', async (t) => {
  const dir = await scaffoldInto(t, 'capability', 'node')
  await linkWorkspace(dir)

  const pkg = await generatedPackage(dir)
  const brain = pkg.brain as Record<string, unknown>
  brain['permissions'] = [...(brain['permissions'] as readonly string[]), 'memory.ingest']
  brain['source'] = {
    channels: ['demo-plugin:note:example'],
    eventKinds: ['demo-plugin.note', 'demo-plugin.other'],
    defaultVisibility: 'open',
    trust: 'owner',
  }
  await writeFile(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)

  const sourcePath = path.join(dir, 'src', 'index.ts')
  const generated = await readFile(sourcePath, 'utf8')
  const comment = '  // This kind does not write memory, so there is no ctx.memory.ingest call here.'
  assert.ok(generated.includes(comment), 'the capability template explains why it has no ingest')
  const ingest = [
    '  await ctx.memory.ingest({',
    "    kind: 'demo-plugin.note',",
    "    channel: 'demo-plugin:note:example',",
    '    subjects: [],',
    "    actor: 'demo-plugin',",
    "    content: { text: 'a note' },",
    '    tEvent: Date.now(),',
    "    idempotencyKey: 'note:1',",
    '  })',
  ].join('\n')
  const writing = generated.replace(comment, ingest)
  await writeFile(sourcePath, writing)

  const passing = await run(process.execPath, ['--test', 'test/plugin.test.ts'], dir)
  assert.equal(passing.code, 0, `${passing.stdout}\n${passing.stderr}`)

  // A record with the wrong kind proves the generated test really reads records().
  await writeFile(sourcePath, writing.replace("kind: 'demo-plugin.note'", "kind: 'demo-plugin.other'"))
  const failing = await run(process.execPath, ['--test', 'test/plugin.test.ts'], dir)
  assert.notEqual(failing.code, 0, 'the generated test should fail when the record does not match')
  assert.match(`${failing.stdout}\n${failing.stderr}`, /demo-plugin\.note/)
})

for (const kind of KINDS) {
  test(`the process ${kind} template passes checkPlugin and speaks protocol v0`, async (t) => {
    const dir = await scaffoldInto(t, kind, 'process')
    const downloaded = await generatedPackage(dir)
    const processSpec = (downloaded.brain as {
      readonly runtime: string
      readonly process: { readonly command: string; readonly args: readonly string[] }
    })
    assert.equal(processSpec.runtime, 'process')
    assert.equal(processSpec.process.command, 'uv')
    assert.deepEqual(processSpec.process.args, ['run', '--no-sync', 'python', 'main.py'])

    const report = await checkPlugin(dir)
    assert.equal(report.ok, true, JSON.stringify(report.findings, null, 2))

    const plugin = new PluginProcess(processSpec.process.command, processSpec.process.args, dir)
    try {
      plugin.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { apiVersion: '1.0.0', pluginId: 'demo-plugin', version: '0.1.0', config: {}, permissions: [] },
      })
      const initialized = await plugin.waitFor((message) => message.id === 1)
      assert.deepEqual(initialized.result, { apiVersion: '1.0.0' })

      const registered = await plugin.waitFor((message) => message.method === 'tools.register')
      assert.ok(registered.id !== undefined, 'the kernel answers tools.register, so it is a request')
      assert.equal(registered.params?.name, 'hello')
      assert.deepEqual(registered.params?.parameters, { type: 'object', properties: {} })

      const ready = await plugin.waitFor((message) => message.method === 'plugin.ready')
      assert.equal(ready.jsonrpc, '2.0')
      assert.equal(ready.params, undefined, 'plugin.ready takes no params')

      plugin.send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tool.invoke',
        params: { name: 'hello', args: {}, call: { channel: 'demo-plugin:note:example', wakeId: 'wake-1' } },
      })
      const invoked = await plugin.waitFor((message) => message.id === 2)
      assert.equal(invoked.result, 'hello from demo-plugin')
      assert.equal(invoked.error, undefined)

      plugin.send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tool.invoke',
        params: { name: 'missing', args: {}, call: { channel: 'demo-plugin:note:example', wakeId: 'wake-1' } },
      })
      const refused = await plugin.waitFor((message) => message.id === 3)
      assert.equal(refused.error?.code, -32602)
      assert.match(refused.error?.message ?? '', /unknown tool: missing/)
    } finally {
      const code = await plugin.stop()
      assert.equal(code, 0, plugin.stderr)
    }
  })
}

test('--yes takes the defaults without asking anything', async () => {
  const io = silent()
  const options = await resolveOptions(parseArgs(['my-plugin', '--yes']), io)
  assert.deepEqual(options, { dir: 'my-plugin', id: 'my-plugin', kind: 'capability', runtime: 'node' })
  assert.deepEqual(io.prompts, [])
})

test('missing answers fall back to the same defaults after prompting', async () => {
  const io = answers('', '', '')
  const options = await resolveOptions(parseArgs(['my-plugin']), io)
  assert.deepEqual(options, { dir: 'my-plugin', id: 'my-plugin', kind: 'capability', runtime: 'node' })
  assert.equal(io.prompts.length, 3)
})

test('answers and options override the defaults', async () => {
  const io = answers('from-answer', '')
  const options = await resolveOptions(parseArgs(['my-plugin', '--kind', 'channel']), io)
  assert.deepEqual(options, { dir: 'my-plugin', id: 'from-answer', kind: 'channel', runtime: 'node' })
  assert.equal(io.prompts.length, 2)
  assert.match(io.prompts[0]!, /plugin id/)
  assert.match(io.prompts[1]!, /runtime/)

  const given = await resolveOptions(
    parseArgs(['my-plugin', '--id', 'explicit', '--kind', 'activity', '--runtime', 'process']),
    silent(),
  )
  assert.deepEqual(given, { dir: 'my-plugin', id: 'explicit', kind: 'activity', runtime: 'process' })
})

test('an invalid id is refused before anything is written', async (t) => {
  const manifest = validateManifest({ id: 'Bad_Id', kinds: ['capability'], api: '^1.0.0', runtime: 'node', permissions: ['tools.register'] })
  assert.equal(manifest.ok, false)
  assert.match(idError('Bad_Id') ?? '', /id must match/)
  assert.equal(idError('good-id'), undefined)
  assert.match(idError('memory') ?? '', /reserved/)
  assert.match(idError('a'.repeat(32)) ?? '', /id must match/)

  const parent = await tempDir(t, 'bad-id')
  const dir = path.join(parent, 'Bad_Id')
  await assert.rejects(
    generateProject({ dir, id: 'Bad_Id', kind: 'capability', runtime: 'node' }),
    /invalid plugin id "Bad_Id"/,
  )
  await assert.rejects(readdir(dir), 'a refused id must not create the directory')
})

test('an invalid id is refused when options are resolved', async () => {
  await assert.rejects(
    resolveOptions(parseArgs(['demo', '--id', 'Bad_Id', '--yes']), silent()),
    /invalid plugin id "Bad_Id"/,
  )
  await assert.rejects(
    resolveOptions(parseArgs(['demo']), answers('Bad_Id', '', '')),
    /invalid plugin id "Bad_Id"/,
  )
})

test('an unknown kind or runtime is refused when options are resolved', async () => {
  await assert.rejects(
    resolveOptions(parseArgs(['my-plugin', '--kind', 'plugin', '--yes']), silent()),
    /invalid kind "plugin"/,
  )
  await assert.rejects(
    resolveOptions(parseArgs(['my-plugin', '--runtime', 'python', '--yes']), silent()),
    /invalid runtime "python"/,
  )
})

test('the command line parser rejects unknown options and missing values', () => {
  assert.throws(() => parseArgs(['my-plugin', '--wat']), /unknown option: --wat/)
  assert.throws(() => parseArgs(['my-plugin', '--id']), /--id needs a value/)
  assert.equal(parseArgs(['--help']).help, true)
})

test('a non-empty directory is refused and never overwritten', async (t) => {
  const parent = await tempDir(t, 'occupied')
  const dir = path.join(parent, 'demo-plugin')
  await mkdir(dir)
  await writeFile(path.join(dir, 'keep.txt'), 'do not touch\n')
  await assert.rejects(
    generateProject({ dir, id: 'demo-plugin', kind: 'capability', runtime: 'node' }),
    /already exists and is not empty/,
  )
  assert.equal(await readFile(path.join(dir, 'keep.txt'), 'utf8'), 'do not touch\n')
  assert.deepEqual(await readdir(dir), ['keep.txt'])
})

test('an existing empty directory is filled in place', async (t) => {
  const parent = await tempDir(t, 'empty')
  const dir = path.join(parent, 'demo-plugin')
  await mkdir(dir)
  const written = await generateProject({ dir, id: 'demo-plugin', kind: 'capability', runtime: 'node' })
  assert.deepEqual([...written].sort(), NODE_FILES)
})

test('a file in the way is refused', async (t) => {
  const parent = await tempDir(t, 'file')
  const dir = path.join(parent, 'demo-plugin')
  await writeFile(dir, 'not a directory\n')
  await assert.rejects(
    generateProject({ dir, id: 'demo-plugin', kind: 'capability', runtime: 'node' }),
    /not a directory/,
  )
})

test('the CLI prints usage, reports a missing directory, and drives a full generation', async (t) => {
  const parent = await tempDir(t, 'cli')
  const dir = path.join(parent, 'cli-plugin')
  const out: string[] = []
  const err: string[] = []
  const io: PromptIo = {
    stdout: (text) => { out.push(text) },
    stderr: (text) => { err.push(text) },
    question: async () => '',
  }

  assert.equal(await runCli(['--help'], io), 0)
  assert.ok(out.join('').includes(USAGE.trim()))
  assert.equal(await runCli([], io), 2)
  assert.match(err.join(''), /a directory is required/)

  assert.equal(await runCli([dir, '--id', 'cli-plugin', '--yes'], io), 0)
  assert.match(out.join(''), /created cli-plugin/)
  const manifest = (await generatedPackage(dir)).brain
  assert.equal(validateManifest(manifest).ok, true)
})

test('the CLI reports a refused generation without a stack trace', async (t) => {
  const parent = await tempDir(t, 'cli-fail')
  const dir = path.join(parent, 'demo-plugin')
  await mkdir(dir)
  await writeFile(path.join(dir, 'keep.txt'), 'x\n')
  const err: string[] = []
  const io: PromptIo = {
    stdout: () => undefined,
    stderr: (text) => { err.push(text) },
    question: async () => '',
  }
  assert.equal(await runCli([dir, '--id', 'demo-plugin', '--yes'], io), 1)
  assert.match(err.join(''), /already exists and is not empty/)
  assert.equal(err.join('').includes('at '), false, 'the CLI must not print a stack trace')
})
