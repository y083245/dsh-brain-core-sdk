/** Runs one turn with a hostile parent env. e1-strace.sh runs this under strace on Linux. */
import path from 'node:path'
import { encodeSessionId } from '@dsh-brain-core/satellite-host'
import { scriptedTools } from './fake-deepseek.ts'
import { withRig } from './rig.ts'

const fakeHome = process.argv[2]
if (fakeHome === undefined) throw new Error('usage: e1-one-turn <fake-home>')

const parentEnv = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, DSH_HOME: path.join(fakeHome, '.dsh'), XDG_CONFIG_HOME: path.join(fakeHome, '.config') }
const sessionId = encodeSessionId({ agentClass: 'chat', channel: 'test:chat:e1', generation: 0 })

await withRig({ script: scriptedTools('demo__a'), satellite: { parentEnv } }, async ({ bridge, satellite }) => {
  bridge.setSurface(sessionId, ['demo__a'])
  const result = await satellite.run(sessionId, 'hello')
  if (result.finalResponse !== 'done') throw new Error(`unexpected reply: ${result.finalResponse}`)
  console.log('one turn finished')
})
