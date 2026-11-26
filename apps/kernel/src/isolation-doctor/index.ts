/** `brain doctor --isolation`: proves the kernel left the main DSH home and process tree alone. */
import { execFile } from 'node:child_process'
import { chmod, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { diffSnapshots, snapshotTree, type FileFingerprint } from '@brain-core/satellite-host'

export type DoctorResult =
  | { readonly kind: 'snapshot'; readonly file: string; readonly entries: number }
  | { readonly kind: 'compare'; readonly unchanged: boolean; readonly added: readonly string[]; readonly removed: readonly string[]; readonly changed: readonly string[] }
  | { readonly kind: 'check'; readonly ok: boolean; readonly problems: readonly string[] }

type ProcessList = readonly { readonly pid: number; readonly ppid: number; readonly command: string }[]

export interface DoctorOptions {
  readonly mode: 'snapshot' | 'compare' | 'check'
  readonly dshHome: string
  readonly file?: string
  readonly listProcesses?: () => Promise<ProcessList>
}

/** `--dsh-home`, otherwise DSH_HOME, otherwise <userHome>/.dsh; blank values fall through. */
export function resolveDshHome(flag: string | undefined, env: NodeJS.ProcessEnv, userHome: string): string {
  const fromFlag = flag?.trim() ?? ''
  if (fromFlag !== '') return path.resolve(fromFlag)
  const fromEnv = env.DSH_HOME?.trim() ?? ''
  if (fromEnv !== '') return path.resolve(fromEnv)
  return path.join(userHome, '.dsh')
}

/** The profile config DSH reads; check touches only these two names, never credentials or sessions. */
const PROFILE_FILES = ['package.json', 'cordis.patch.yml'] as const
const FORBIDDEN_MARKERS = ['brain-bridge', '@brain-core/', 'satellite-bundle'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Files whose contents must never be read, not even to hash them. */
function isNeverRead(relativePath: string): boolean {
  const parts = relativePath.split('/')
  const name = parts[parts.length - 1]
  return name === '.credentials.yaml' || name === '.env' || parts.includes('sessions')
}

/** Only cordis.patch.yml and profiles/ are hashed; node_modules under profiles stays metadata-only. */
function isHashTarget(relativePath: string): boolean {
  if (relativePath === 'cordis.patch.yml') return true
  if (!relativePath.startsWith('profiles/')) return false
  return !relativePath.split('/').includes('node_modules')
}

function metadataOnly(relativePath: string): boolean {
  return !isHashTarget(relativePath) || isNeverRead(relativePath)
}

function requireFile(options: DoctorOptions): string {
  const file = options.file?.trim() ?? ''
  if (file === '') throw new Error(`doctor: ${options.mode} mode requires file`)
  return file
}

async function takeSnapshot(dshHome: string): Promise<FileFingerprint[]> {
  return snapshotTree(dshHome, { metadataOnly })
}

async function snapshotMode(options: DoctorOptions): Promise<DoctorResult> {
  const file = requireFile(options)
  const entries = await takeSnapshot(options.dshHome)
  await writeFile(file, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 })
  // An existing file keeps its old mode on writeFile, so make 600 explicit.
  if (process.platform !== 'win32') await chmod(file, 0o600)
  return { kind: 'snapshot', file, entries: entries.length }
}

function isFingerprintList(value: unknown): value is FileFingerprint[] {
  return Array.isArray(value) && value.every(entry => isRecord(entry)
    && typeof entry.path === 'string'
    && typeof entry.size === 'number'
    && typeof entry.mtimeMs === 'number'
    && (entry.sha256 === undefined || typeof entry.sha256 === 'string'))
}

async function readSnapshotFile(file: string): Promise<FileFingerprint[]> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`doctor: snapshot file not found: ${file}`, { cause: error })
    throw new Error(`doctor: cannot read snapshot file ${file}: ${(error as Error).message}`, { cause: error })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`doctor: snapshot file is not valid JSON: ${file}`)
  }
  if (!isFingerprintList(parsed)) throw new Error(`doctor: snapshot file is not a file fingerprint list: ${file}`)
  return parsed
}

async function compareMode(options: DoctorOptions): Promise<DoctorResult> {
  const file = requireFile(options)
  const before = await readSnapshotFile(file)
  const changes = diffSnapshots(before, await takeSnapshot(options.dshHome))
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  for (const change of changes) {
    if (change.startsWith('added ')) added.push(change.slice('added '.length))
    else if (change.startsWith('removed ')) removed.push(change.slice('removed '.length))
    else if (change.startsWith('changed ')) changed.push(change.slice('changed '.length))
  }
  return { kind: 'compare', unchanged: changes.length === 0, added, removed, changed }
}

function execFileText(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error !== null) reject(error)
      else resolve(stdout)
    })
  })
}

function parsePosixProcessList(text: string): ProcessList {
  const processes: { pid: number; ppid: number; command: string }[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*(.*)$/.exec(line)
    if (match === null) continue
    processes.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? '' })
  }
  return processes
}

async function listWindowsProcesses(): Promise<ProcessList> {
  const text = await execFileText('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; '
      + 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
  ])
  const body = text.replace(/^\uFEFF/, '').trim()
  const parsed: unknown = JSON.parse(body === '' ? '[]' : body)
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  const processes: { pid: number; ppid: number; command: string }[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const pid = Number(row.ProcessId)
    const ppid = Number(row.ParentProcessId)
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
    processes.push({ pid, ppid, command: typeof row.CommandLine === 'string' ? row.CommandLine : '' })
  }
  return processes
}

async function defaultListProcesses(): Promise<ProcessList> {
  if (process.platform === 'win32') return listWindowsProcesses()
  return parsePosixProcessList(await execFileText('ps', ['-eo', 'pid,ppid,args']))
}

/** Walks ppid links up from `pid`; the kernel itself is not a descendant of itself. */
function isDescendantOfKernel(pid: number, parents: ReadonlyMap<number, number>): boolean {
  if (pid === process.pid) return false
  const seen = new Set<number>()
  let current = parents.get(pid)
  while (current !== undefined && current !== 0) {
    if (current === process.pid) return true
    if (seen.has(current)) return false
    seen.add(current)
    current = parents.get(current)
  }
  return false
}

function processProblems(processes: ProcessList): string[] {
  const parents = new Map(processes.map(processInfo => [processInfo.pid, processInfo.ppid]))
  const problems: string[] = []
  for (const processInfo of processes) {
    if (!isDescendantOfKernel(processInfo.pid, parents)) continue
    if (!processInfo.command.includes('dsh')) continue
    // The kernel only launches satellite runtimes through sdk-minimal.
    if (processInfo.command.includes('sdk-minimal')) continue
    // Only the pid: a command line can carry credentials and must never reach the output.
    problems.push(`DSH process ${processInfo.pid} was not started by the kernel`)
  }
  return problems
}

/** Reads only each profile's package.json and cordis.patch.yml; never credentials or sessions. */
async function profileProblems(dshHome: string): Promise<string[]> {
  const profilesDir = path.join(dshHome, 'profiles')
  let entries
  try {
    entries = await readdir(profilesDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error(`doctor: cannot read ${profilesDir}: ${(error as Error).message}`, { cause: error })
  }
  const profiles = entries
    .filter(entry => entry.isDirectory() && entry.name !== 'node_modules')
    .sort((a, b) => a.name.localeCompare(b.name))
  const problems: string[] = []
  for (const profile of profiles) {
    for (const name of PROFILE_FILES) {
      const file = path.join(profilesDir, profile.name, name)
      let text: string
      try {
        text = await readFile(file, 'utf8')
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') continue
        problems.push(`cannot read profiles/${profile.name}/${name}: ${(error as Error).message}`)
        continue
      }
      for (const marker of FORBIDDEN_MARKERS) {
        if (text.includes(marker)) problems.push(`profile profiles/${profile.name}/${name} contains ${marker}`)
      }
    }
  }
  return problems
}

async function checkMode(options: DoctorOptions): Promise<DoctorResult> {
  const problems = [...await profileProblems(options.dshHome)]
  const processes = await (options.listProcesses ?? defaultListProcesses)()
  problems.push(...processProblems(processes))
  return { kind: 'check', ok: problems.length === 0, problems }
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  if (options.mode === 'snapshot') return snapshotMode(options)
  if (options.mode === 'compare') return compareMode(options)
  return checkMode(options)
}
