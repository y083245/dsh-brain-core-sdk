import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { diffSnapshots, encodeSessionId, removeTree, snapshotTree } from '@brain-core/satellite-host'
import { scriptedTools } from '../src/fake-deepseek.ts'
import { withRig } from '../src/rig.ts'

const sessionId = encodeSessionId({ agentClass: 'chat', channel: 'test:chat:e1', generation: 0 })

async function fakeOwnerHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'brain-fake-owner-'))
  await mkdir(path.join(home, '.dsh', 'profiles', 'web'), { recursive: true })
  await mkdir(path.join(home, '.dsh', 'sessions', 'project'), { recursive: true })
  await writeFile(path.join(home, '.dsh', '.credentials.yaml'), 'refs:\n  DEEPSEEK_API_KEY: sentinel\n')
  await writeFile(path.join(home, '.dsh', '.env'), 'DEEPSEEK_API_KEY=sentinel\n')
  await writeFile(path.join(home, '.dsh', 'cordis.patch.yml'), '- insert:\n    - id: poison\n      name: /nonexistent/poison.js\n')
  await writeFile(path.join(home, '.dsh', 'profiles', 'web', 'package.json'), '{"name":"owner"}')
  await writeFile(path.join(home, '.dsh', 'sessions', 'project', 'owner.jsonl'), '{}\n')
  return home
}

test('a whole turn leaves the owner home untouched, even with DSH_HOME pointing at it', async t => {
  const fakeHome = await fakeOwnerHome()
  t.after(() => removeTree(fakeHome))
  const before = await snapshotTree(fakeHome)
  const parentEnv = {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    DSH_HOME: path.join(fakeHome, '.dsh'),
    XDG_CONFIG_HOME: path.join(fakeHome, '.config'),
    DEEPSEEK_API_KEY: 'owner-key-must-not-be-used',
  }
  await withRig({ script: scriptedTools('demo__a'), satellite: { parentEnv } }, async ({ brainHome, bridge, satellite, gateway }) => {
    bridge.setSurface(sessionId, ['demo__a'])
    const result = await satellite.run(sessionId, 'hello')
    assert.equal(result.finalResponse, 'done')
    assert.equal(gateway.requests.length, 2)

    // The poison patch in the fake home would have stopped DSH booting had it been read.
    const sessions = path.join(brainHome, 'state', 'satellite', 'dsh-home', 'sessions')
    assert.ok((await readdir(sessions)).length > 0, 'sessions belong in the dedicated home')
    await access(path.join(brainHome, 'state', 'satellite', 'workspace', 'chat'))
  })
  assert.deepEqual(diffSnapshots(before, await snapshotTree(fakeHome)), [])
})

test('the system prompt reaching the model is exactly the persona, with no added prose', async () => {
  await withRig({ script: scriptedTools() }, async ({ bridge, satellite, gateway }) => {
    bridge.setSurface(sessionId, ['demo__a'])
    await satellite.run(sessionId, 'hello')
    assert.equal(gateway.requests[0]?.system, 'You are a test persona.')
  })
})
