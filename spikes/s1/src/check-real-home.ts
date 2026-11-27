/**
 * Proves the owner's real DSH home did not change. Close the owner's DSH first.
 * Only profile config is hashed; credentials, sessions and the rest are compared by
 * size and mtime without opening them. Output lists paths only, never contents.
 *
 *   node spikes/s1/src/check-real-home.ts snapshot <file>
 *   node spikes/s1/src/check-real-home.ts compare <before-file> <after-file>
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { diffSnapshots, snapshotTree, type FileFingerprint } from '@dsh-brain-core/satellite-host'

const [command, first, second] = process.argv.slice(2)
const root = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const hashable = (relative: string) => relative === 'cordis.patch.yml' || (relative.startsWith('profiles/') && !relative.includes('node_modules/'))

if (command === 'snapshot' && first !== undefined) {
  const files = await snapshotTree(root, { metadataOnly: relative => !hashable(relative) })
  await mkdir(path.dirname(first), { recursive: true })
  await writeFile(first, JSON.stringify(files))
  console.log(`${files.length} files recorded from ${root}`)
} else if (command === 'compare' && first !== undefined && second !== undefined) {
  const load = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as FileFingerprint[]
  const changes = diffSnapshots(await load(first), await load(second))
  console.log(changes.length === 0 ? 'unchanged' : changes.join('\n'))
  process.exitCode = changes.length === 0 ? 0 : 1
} else {
  throw new Error('usage: check-real-home snapshot <file> | compare <before> <after>')
}
