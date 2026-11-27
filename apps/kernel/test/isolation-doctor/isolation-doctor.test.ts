import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveDshHome, runDoctor } from '../../src/isolation-doctor/index.ts'

const IS_WINDOWS = process.platform === 'win32'
/** A fixed timestamp keeps "same size and mtime" tests exact across file systems. */
const FIXED_MTIME = 1_700_000_000_000

interface Fixture {
  readonly root: string
  readonly home: string
  readonly file: string
}

async function makeWritable(root: string): Promise<void> {
  try {
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue
      await chmod(path.join(entry.parentPath, entry.name), 0o600).catch(() => undefined)
    }
  } catch {
    // Best effort: the test's own cleanup failures must not hide the real result.
  }
}

async function makeFixture(t: test.TestContext): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brain-doctor-'))
  const home = path.join(root, 'dsh')
  await mkdir(home, { recursive: true })
  t.after(async () => {
    await makeWritable(root)
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })
  return { root, home, file: path.join(root, 'snapshot.json') }
}

/** Writes a fixture file with a known mtime, so later edits can keep both size and time stable. */
async function put(home: string, relative: string, content: string): Promise<string> {
  const file = path.join(home, ...relative.split('/'))
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content)
  await utimes(file, new Date(FIXED_MTIME), new Date(FIXED_MTIME))
  return file
}

async function keepMtime(file: string): Promise<void> {
  await utimes(file, new Date(FIXED_MTIME), new Date(FIXED_MTIME))
}

/** A fake main DSH home with no Brain entries; the only files check is allowed to read. */
async function cleanHome(home: string): Promise<void> {
  await put(home, 'cordis.patch.yml', '- id: user-tool\n  name: some-user-plugin\n')
  await put(home, 'notes.txt', 'ordinary file\n')
  await put(home, 'profiles/web/package.json', JSON.stringify({
    name: 'dsh-profile-web',
    dependencies: { 'user-plugin': '1.2.3' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, null, 2))
  await put(home, 'profiles/web/cordis.patch.yml', '- id: user-tool\n  name: some-user-plugin\n')
  await put(home, 'profiles/desktop/package.json', JSON.stringify({
    name: 'dsh-profile-desktop',
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, null, 2))
  await put(home, 'profiles/web/node_modules/dep/index.js', 'module.exports = 1\n')
}

function cleanProcesses(): Promise<readonly { readonly pid: number; readonly ppid: number; readonly command: string }[]> {
  return Promise.resolve([{ pid: process.pid, ppid: 1, command: 'node brain' }])
}

test('resolveDshHome prefers the flag, then DSH_HOME, then <userHome>/.dsh', () => {
  const userHome = path.resolve(path.sep, 'tmp', 'doctor-user-home')
  const flagHome = path.resolve(path.sep, 'tmp', 'flag-home')
  const envHome = path.resolve(path.sep, 'tmp', 'env-home')
  assert.equal(resolveDshHome(flagHome, { DSH_HOME: envHome }, userHome), flagHome)
  assert.equal(resolveDshHome(undefined, { DSH_HOME: envHome }, userHome), envHome)
  assert.equal(resolveDshHome(undefined, {}, userHome), path.join(userHome, '.dsh'))
})

test('resolveDshHome ignores blank values and resolves relative paths', () => {
  const userHome = path.resolve(path.sep, 'tmp', 'doctor-user-home')
  assert.equal(resolveDshHome('   ', { DSH_HOME: '  ' }, userHome), path.join(userHome, '.dsh'))
  assert.equal(resolveDshHome(undefined, { DSH_HOME: 'relative/dsh' }, userHome), path.resolve('relative/dsh'))
  assert.equal(resolveDshHome('relative/flag-dsh', {}, userHome), path.resolve('relative/flag-dsh'))
})

test('snapshot and compare require a file', async (t) => {
  const { home } = await makeFixture(t)
  await cleanHome(home)
  await assert.rejects(runDoctor({ mode: 'snapshot', dshHome: home }), /requires .*file|file is required/)
  await assert.rejects(runDoctor({ mode: 'compare', dshHome: home }), /requires .*file|file is required/)
})

test('snapshot counts files and compare reports no change for the same tree', async (t) => {
  const { home, file } = await makeFixture(t)
  await cleanHome(home)
  assert.deepEqual(await runDoctor({ mode: 'snapshot', dshHome: home, file }), { kind: 'snapshot', file, entries: 6 })
  assert.deepEqual(await runDoctor({ mode: 'compare', dshHome: home, file }), {
    kind: 'compare', unchanged: true, added: [], removed: [], changed: [],
  })
})

test('compare reports added, removed and changed paths', async (t) => {
  const { home, file } = await makeFixture(t)
  await cleanHome(home)
  await runDoctor({ mode: 'snapshot', dshHome: home, file })

  await put(home, 'profiles/web/added.txt', 'new')
  await rm(path.join(home, 'notes.txt'))
  await put(home, 'profiles/desktop/package.json', JSON.stringify({
    name: 'dsh-profile-desktop',
    dependencies: { changed: '1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, null, 2))

  assert.deepEqual(await runDoctor({ mode: 'compare', dshHome: home, file }), {
    kind: 'compare',
    unchanged: false,
    added: ['profiles/web/added.txt'],
    removed: ['notes.txt'],
    changed: ['profiles/desktop/package.json'],
  })
})

test('hashes cordis.patch.yml and profile files even when size and mtime do not change', async (t) => {
  const { home, file } = await makeFixture(t)
  await cleanHome(home)
  await put(home, 'cordis.patch.yml', 'a'.repeat(64))
  await put(home, 'profiles/web/data.json', 'b'.repeat(64))
  await runDoctor({ mode: 'snapshot', dshHome: home, file })

  await put(home, 'cordis.patch.yml', 'c'.repeat(64))
  await put(home, 'profiles/web/data.json', 'd'.repeat(64))
  assert.equal((await stat(path.join(home, 'cordis.patch.yml'))).size, 64)
  assert.equal((await stat(path.join(home, 'cordis.patch.yml'))).mtimeMs, FIXED_MTIME)

  assert.deepEqual(await runDoctor({ mode: 'compare', dshHome: home, file }), {
    kind: 'compare',
    unchanged: false,
    added: [],
    removed: [],
    changed: ['cordis.patch.yml', 'profiles/web/data.json'],
  })
})

test('other files are compared by size and mtime only, without opening them', async (t) => {
  const { home, file } = await makeFixture(t)
  await cleanHome(home)
  await runDoctor({ mode: 'snapshot', dshHome: home, file })

  const notes = path.join(home, 'notes.txt')
  await writeFile(notes, 'ORDINARY file\n')
  await keepMtime(notes)
  assert.deepEqual(await runDoctor({ mode: 'compare', dshHome: home, file }), {
    kind: 'compare', unchanged: true, added: [], removed: [], changed: [],
  })
})

test('node_modules under profiles is never hashed', async (t) => {
  const { home, file } = await makeFixture(t)
  await cleanHome(home)
  const dep = path.join(home, 'profiles', 'web', 'node_modules', 'dep', 'index.js')
  await runDoctor({ mode: 'snapshot', dshHome: home, file })

  await writeFile(dep, 'module.exports = 2\n')
  await keepMtime(dep)
  assert.deepEqual(await runDoctor({ mode: 'compare', dshHome: home, file }), {
    kind: 'compare', unchanged: true, added: [], removed: [], changed: [],
  })

  const entries = JSON.parse(await readFile(file, 'utf8')) as { path: string; sha256?: string }[]
  const byPath = new Map(entries.map(entry => [entry.path, entry]))
  assert.equal(byPath.get('profiles/web/node_modules/dep/index.js')?.sha256, undefined)
  assert.equal(byPath.get('notes.txt')?.sha256, undefined)
  assert.match(byPath.get('cordis.patch.yml')?.sha256 ?? '', /^[a-f0-9]{64}$/)
  assert.match(byPath.get('profiles/web/package.json')?.sha256 ?? '', /^[a-f0-9]{64}$/)
})

test('never opens credentials, .env or sessions files', { skip: IS_WINDOWS ? 'chmod 000 does not block reads on Windows' : false }, async (t) => {
  const { home, file } = await makeFixture(t)
  await cleanHome(home)
  const secrets: readonly (readonly [string, string])[] = [
    ['.credentials.yaml', 'token: SENTINEL-CREDENTIALS-4a1'],
    ['.env', 'KEY=SENTINEL-ENV-7b2'],
    ['profiles/web/.env', 'KEY=SENTINEL-PROFILE-ENV-8c3'],
    ['sessions/2026/chat.jsonl', '{"text":"SENTINEL-SESSION-9d4"}'],
  ]
  for (const [relative, content] of secrets) {
    const absolute = await put(home, relative, content)
    await chmod(absolute, 0o000)
  }

  const snapshot = await runDoctor({ mode: 'snapshot', dshHome: home, file })
  const compare = await runDoctor({ mode: 'compare', dshHome: home, file })
  const check = await runDoctor({ mode: 'check', dshHome: home, listProcesses: cleanProcesses })
  const snapshotText = await readFile(file, 'utf8')
  for (const sentinel of ['SENTINEL-CREDENTIALS-4a1', 'SENTINEL-ENV-7b2', 'SENTINEL-PROFILE-ENV-8c3', 'SENTINEL-SESSION-9d4']) {
    for (const output of [JSON.stringify(snapshot), JSON.stringify(compare), JSON.stringify(check), snapshotText]) {
      assert.equal(output.includes(sentinel), false)
    }
  }

  const entries = JSON.parse(snapshotText) as { path: string; sha256?: string }[]
  const byPath = new Map(entries.map(entry => [entry.path, entry]))
  for (const [relative] of secrets) {
    assert.equal(byPath.get(relative)?.sha256, undefined)
  }
  assert.equal(snapshot.kind, 'snapshot')
  if (snapshot.kind !== 'snapshot') return
  assert.equal(snapshot.entries, 10)
})

test('results and snapshot files never contain file contents', async (t) => {
  const { home, file } = await makeFixture(t)
  const sentinel = 'SENTINEL-CONTENT-9f3c'
  await cleanHome(home)
  await put(home, 'notes.txt', `${sentinel}\n`)
  await put(home, 'profiles/web/package.json', JSON.stringify({ name: 'web', note: sentinel }, null, 2))
  await put(home, 'profiles/web/cordis.patch.yml', `# ${sentinel}\n- id: user-tool\n  name: some-user-plugin\n`)

  const snapshot = await runDoctor({ mode: 'snapshot', dshHome: home, file })
  const compare = await runDoctor({ mode: 'compare', dshHome: home, file })
  const check = await runDoctor({ mode: 'check', dshHome: home, listProcesses: cleanProcesses })
  const snapshotText = await readFile(file, 'utf8')
  for (const output of [JSON.stringify(snapshot), JSON.stringify(compare), JSON.stringify(check), snapshotText]) {
    assert.equal(output.includes(sentinel), false)
  }
})

test('writes the snapshot file with mode 600', { skip: IS_WINDOWS ? 'POSIX file modes are not available on Windows' : false }, async (t) => {
  const { home, file } = await makeFixture(t)
  await cleanHome(home)
  await writeFile(file, 'old', { mode: 0o644 })
  await chmod(file, 0o644)
  assert.equal((await stat(file)).mode & 0o777, 0o644)

  await runDoctor({ mode: 'snapshot', dshHome: home, file })
  assert.equal((await stat(file)).mode & 0o777, 0o600)
})

test('check passes a clean fake DSH home', async (t) => {
  const { home } = await makeFixture(t)
  await cleanHome(home)
  assert.deepEqual(await runDoctor({ mode: 'check', dshHome: home, listProcesses: cleanProcesses }), {
    kind: 'check', ok: true, problems: [],
  })
})

for (const marker of ['brain-bridge', '@brain-core/', '@dsh-brain-core/', 'satellite-bundle'] as const) {
  for (const name of ['package.json', 'cordis.patch.yml'] as const) {
    test(`check reports ${marker} in a profile ${name}`, async (t) => {
      const { home } = await makeFixture(t)
      await cleanHome(home)
      const content = name === 'package.json'
        ? JSON.stringify({ name: 'web', dependencies: { [marker]: '1.0.0' } }, null, 2)
        : `- id: injected\n  name: '${marker}'\n`
      await put(home, `profiles/web/${name}`, content)

      const result = await runDoctor({ mode: 'check', dshHome: home, listProcesses: cleanProcesses })
      assert.equal(result.kind, 'check')
      if (result.kind !== 'check') return
      assert.equal(result.ok, false)
      assert.ok(
        result.problems.some(problem => problem.includes(`profiles/web/${name}`) && problem.includes(marker)),
        JSON.stringify(result.problems),
      )
    })
  }
}

test('check accepts DSH descendants launched with sdk-minimal only', async (t) => {
  const { home } = await makeFixture(t)
  await cleanHome(home)
  const processes = [
    { pid: process.pid, ppid: 1, command: 'node brain' },
    { pid: 100, ppid: process.pid, command: '/opt/dsh/bin/dsh --profile sdk-minimal' },
    { pid: 200, ppid: 100, command: 'dsh sdk-minimal' },
  ]
  assert.deepEqual(await runDoctor({ mode: 'check', dshHome: home, listProcesses: async () => processes }), {
    kind: 'check', ok: true, problems: [],
  })
})

test('check finds a descendant even when the root process is absent from the list', async (t) => {
  const { home } = await makeFixture(t)
  await cleanHome(home)
  const processes = [{ pid: 100, ppid: process.pid, command: 'dsh sdk-minimal' }]
  assert.deepEqual(await runDoctor({ mode: 'check', dshHome: home, listProcesses: async () => processes }), {
    kind: 'check', ok: true, problems: [],
  })
})

test('check reports a descendant DSH that the kernel did not launch', async (t) => {
  const { home } = await makeFixture(t)
  await cleanHome(home)
  const processes = [
    { pid: process.pid, ppid: 1, command: 'node brain' },
    { pid: 100, ppid: process.pid, command: '/usr/local/bin/dsh --profile web' },
  ]
  const result = await runDoctor({ mode: 'check', dshHome: home, listProcesses: async () => processes })
  assert.equal(result.kind, 'check')
  if (result.kind !== 'check') return
  assert.equal(result.ok, false)
  assert.ok(result.problems.some(problem => problem.includes('100')), JSON.stringify(result.problems))
})

test('check ignores DSH processes outside the kernel process tree', async (t) => {
  const { home } = await makeFixture(t)
  await cleanHome(home)
  const processes = [
    { pid: process.pid, ppid: 1, command: 'node brain' },
    { pid: 100, ppid: process.pid, command: 'dsh sdk-minimal' },
    { pid: 999, ppid: 1, command: '/usr/local/bin/dsh --profile web' },
  ]
  assert.deepEqual(await runDoctor({ mode: 'check', dshHome: home, listProcesses: async () => processes }), {
    kind: 'check', ok: true, problems: [],
  })
})

test('compare fails clearly when the snapshot file is missing', async (t) => {
  const { home, file } = await makeFixture(t)
  await cleanHome(home)
  await assert.rejects(runDoctor({ mode: 'compare', dshHome: home, file }), /snapshot file not found/)
})

test('compare fails clearly when the snapshot file is not valid JSON', async (t) => {
  const { home, file } = await makeFixture(t)
  await cleanHome(home)
  await writeFile(file, 'not json', 'utf8')
  await assert.rejects(runDoctor({ mode: 'compare', dshHome: home, file }), /not valid JSON/)
})

test('compare fails clearly when the snapshot file is not a fingerprint list', async (t) => {
  const { home, file } = await makeFixture(t)
  await cleanHome(home)
  for (const content of ['{}', '[{"path":"a","size":"big","mtimeMs":0}]', '[{"path":1,"size":1,"mtimeMs":1}]']) {
    await writeFile(file, content, 'utf8')
    await assert.rejects(runDoctor({ mode: 'compare', dshHome: home, file }), /file fingerprint list/)
  }
})

test('check can list the real process tree on this platform', async (t) => {
  const { home } = await makeFixture(t)
  await cleanHome(home)
  const result = await runDoctor({ mode: 'check', dshHome: home })
  assert.equal(result.kind, 'check')
})

test('check problems do not echo the process command line', async (t) => {
  const { home } = await makeFixture(t)
  await cleanHome(home)
  const secret = 'SENTINEL-COMMAND-KEY-1a2'
  const processes = [
    { pid: process.pid, ppid: 1, command: 'node brain' },
    { pid: 100, ppid: process.pid, command: `/usr/local/bin/dsh --profile web --api-key=${secret}` },
  ]
  const result = await runDoctor({ mode: 'check', dshHome: home, listProcesses: async () => processes })
  assert.equal(result.kind, 'check')
  if (result.kind !== 'check') return
  assert.equal(result.ok, false)
  assert.equal(JSON.stringify(result).includes(secret), false)
  assert.equal(JSON.stringify(result).includes('/usr/local/bin/dsh'), false)
})

// ---- Second review round: tests for implementation lines a mutation left uncovered. ----

/** Polls until `ready` resolves true; a freshly spawned process is not in `ps` instantly. */
async function waitUntil(ready: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await ready()) return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return false
}

async function failureMessage(action: Promise<unknown>): Promise<string> {
  try {
    await action
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('expected the doctor to fail')
}

test('never opens credentials, .env or sessions files nested under profiles', { skip: IS_WINDOWS ? 'chmod 000 does not block reads on Windows' : false }, async (t) => {
  const { home, file } = await makeFixture(t)
  await cleanHome(home)
  // These are hash targets by path, so only the never-read guard keeps them from being opened.
  const secrets: readonly (readonly [string, string])[] = [
    ['profiles/web/.credentials.yaml', 'token: SENTINEL-NESTED-CREDENTIALS-5e1'],
    ['profiles/web/.env', 'KEY=SENTINEL-NESTED-ENV-6f2'],
    ['profiles/web/sessions/2026/chat.jsonl', '{"text":"SENTINEL-NESTED-SESSION-7a3"}'],
  ]
  for (const [relative, content] of secrets) {
    const absolute = await put(home, relative, content)
    await chmod(absolute, 0o000)
  }

  const snapshot = await runDoctor({ mode: 'snapshot', dshHome: home, file })
  assert.equal(snapshot.kind, 'snapshot')
  assert.deepEqual(await runDoctor({ mode: 'compare', dshHome: home, file }), {
    kind: 'compare', unchanged: true, added: [], removed: [], changed: [],
  })

  const snapshotText = await readFile(file, 'utf8')
  assert.equal(snapshotText.includes('SENTINEL-NESTED-'), false)
  const entries = JSON.parse(snapshotText) as { path: string; sha256?: string }[]
  const byPath = new Map(entries.map(entry => [entry.path, entry]))
  for (const [relative] of secrets) {
    assert.ok(byPath.has(relative), relative)
    assert.equal(byPath.get(relative)?.sha256, undefined, relative)
  }
})

test('compare error messages name the doctor and the snapshot file', async (t) => {
  const { home, file } = await makeFixture(t)
  await cleanHome(home)

  assert.equal(
    await failureMessage(runDoctor({ mode: 'compare', dshHome: home, file })),
    `doctor: snapshot file not found: ${file}`,
  )

  // Node's own SyntaxError also says "not valid JSON", so the full message pins our wrapper.
  await writeFile(file, 'not json', 'utf8')
  assert.equal(
    await failureMessage(runDoctor({ mode: 'compare', dshHome: home, file })),
    `doctor: snapshot file is not valid JSON: ${file}`,
  )

  await writeFile(file, '{}', 'utf8')
  assert.equal(
    await failureMessage(runDoctor({ mode: 'compare', dshHome: home, file })),
    `doctor: snapshot file is not a file fingerprint list: ${file}`,
  )
})

test('check finds a DSH grandchild through a non-DSH intermediate process', async (t) => {
  const { home } = await makeFixture(t)
  await cleanHome(home)
  const processes = [
    { pid: process.pid, ppid: 1, command: 'node brain' },
    { pid: 100, ppid: process.pid, command: 'node helper.js' },
    { pid: 200, ppid: 100, command: '/usr/local/bin/dsh --profile web' },
  ]
  const result = await runDoctor({ mode: 'check', dshHome: home, listProcesses: async () => processes })
  assert.equal(result.kind, 'check')
  if (result.kind !== 'check') return
  assert.equal(result.ok, false)
  assert.equal(result.problems.length, 1)
  assert.ok(result.problems[0]?.includes('200'), JSON.stringify(result.problems))
})

test('check reports a DSH grandchild below an sdk-minimal DSH', async (t) => {
  const { home } = await makeFixture(t)
  await cleanHome(home)
  const processes = [
    { pid: process.pid, ppid: 1, command: 'node brain' },
    { pid: 100, ppid: process.pid, command: 'dsh --profile sdk-minimal' },
    { pid: 200, ppid: 100, command: 'dsh --profile web' },
  ]
  const result = await runDoctor({ mode: 'check', dshHome: home, listProcesses: async () => processes })
  assert.equal(result.kind, 'check')
  if (result.kind !== 'check') return
  assert.equal(result.ok, false)
  assert.equal(result.problems.length, 1)
  assert.ok(result.problems[0]?.includes('200'), JSON.stringify(result.problems))
})

test('check never reports the kernel process itself, even inside a parent cycle', async (t) => {
  const { home } = await makeFixture(t)
  await cleanHome(home)
  const processes = [
    // Following ppid links from the kernel reaches the kernel again, so it needs its own guard.
    { pid: process.pid, ppid: 300, command: 'node dsh-kernel' },
    { pid: 300, ppid: process.pid, command: 'node worker.js' },
    // A cycle outside the kernel tree must end on the visited set instead of spinning.
    { pid: 400, ppid: 500, command: 'dsh --profile web' },
    { pid: 500, ppid: 400, command: 'node helper.js' },
  ]
  assert.deepEqual(await runDoctor({ mode: 'check', dshHome: home, listProcesses: async () => processes }), {
    kind: 'check', ok: true, problems: [],
  })
})

test('check ignores kernel descendants that are not DSH processes', async (t) => {
  const { home } = await makeFixture(t)
  await cleanHome(home)
  const processes = [
    { pid: process.pid, ppid: 1, command: 'node brain' },
    { pid: 300, ppid: process.pid, command: 'node worker.js' },
  ]
  assert.deepEqual(await runDoctor({ mode: 'check', dshHome: home, listProcesses: async () => processes }), {
    kind: 'check', ok: true, problems: [],
  })
})

test('check finds a real child process from the platform process list', async (t) => {
  const { home } = await makeFixture(t)
  await cleanHome(home)
  // "dsh-doctor-probe" makes the command line look like a DSH the kernel did not launch.
  const probe = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', 'dsh-doctor-probe'], { stdio: 'ignore' })
  t.after(() => { probe.kill() })
  const pid = probe.pid
  assert.notEqual(pid, undefined, 'the probe process did not start')

  let problems: readonly string[] = []
  const appeared = await waitUntil(async () => {
    const result = await runDoctor({ mode: 'check', dshHome: home })
    if (result.kind !== 'check') return false
    problems = result.problems
    return result.problems.some(problem => problem.includes(String(pid)))
  }, 30_000)
  assert.ok(appeared, `probe ${pid} never showed up in problems: ${JSON.stringify(problems)}`)
})

test('check reports an unreadable profile file instead of aborting', async (t) => {
  const { home } = await makeFixture(t)
  // A directory named package.json makes readFile fail with EISDIR on every platform.
  await mkdir(path.join(home, 'profiles', 'broken', 'package.json'), { recursive: true })
  await put(home, 'profiles/broken/cordis.patch.yml', '- id: user-tool\n')

  const result = await runDoctor({ mode: 'check', dshHome: home, listProcesses: cleanProcesses })
  assert.equal(result.kind, 'check')
  if (result.kind !== 'check') return
  assert.equal(result.ok, false)
  assert.ok(
    result.problems.some(problem => problem.includes('cannot read profiles/broken/package.json')),
    JSON.stringify(result.problems),
  )
})

test('check passes when the fake home has no profiles directory', async (t) => {
  const { home } = await makeFixture(t)
  assert.deepEqual(await runDoctor({ mode: 'check', dshHome: home, listProcesses: async () => [] }), {
    kind: 'check', ok: true, problems: [],
  })
})

test('parses ps output whose pid column is right-aligned', { skip: IS_WINDOWS ? 'Windows uses the PowerShell branch, which has no pid column' : false }, async (t) => {
  const { root, home } = await makeFixture(t)
  await cleanHome(home)
  // A stand-in ps keeps the pid width deterministic: a five-digit pid has no leading space.
  const bin = path.join(root, 'bin')
  await mkdir(bin, { recursive: true })
  const script = path.join(bin, 'ps')
  const probePid = 4242
  await writeFile(script, [
    '#!/bin/sh',
    "cat <<'PS'",
    '  PID  PPID ARGS',
    `${String(process.pid).padStart(5)}     1 node brain`,
    `${String(probePid).padStart(5)} ${String(process.pid).padStart(5)} /usr/local/bin/dsh --profile web`,
    'PS',
    '',
  ].join('\n'))
  await chmod(script, 0o755)

  const originalPath = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`
  t.after(() => { process.env.PATH = originalPath })

  const result = await runDoctor({ mode: 'check', dshHome: home })
  assert.equal(result.kind, 'check')
  if (result.kind !== 'check') return
  assert.equal(result.ok, false)
  assert.ok(result.problems.some(problem => problem.includes(String(probePid))), JSON.stringify(result.problems))
})
