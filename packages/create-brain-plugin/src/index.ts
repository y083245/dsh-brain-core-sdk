import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLUGIN_KINDS, validateManifest, type PluginKind } from '@dsh-brain-core/sdk'

export type Runtime = 'node' | 'process'

export const RUNTIMES: readonly Runtime[] = ['node', 'process']
export const TEMPLATES_DIR = fileURLToPath(new URL('../templates/', import.meta.url))

export const USAGE = 'usage: create-brain-plugin <dir> [--id <id>] [--kind channel|activity|capability|memory-provider] [--runtime node|process] [--yes]'

export interface ScaffoldOptions {
  /** Where to write the project. It must not exist, or it must be an empty directory. */
  readonly dir: string
  readonly id: string
  readonly kind: PluginKind
  readonly runtime: Runtime
}

export interface ParsedArgs {
  readonly dir: string
  readonly id?: string
  readonly kind?: string
  readonly runtime?: string
  readonly yes: boolean
  readonly help: boolean
}

export interface PromptIo {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
  readonly question: (prompt: string) => Promise<string>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The `validateManifest` rules for `id`, without a second copy of the regular expression. */
export function idError(id: string): string | undefined {
  const result = validateManifest({
    id,
    kinds: ['capability'],
    api: '^1.0.0',
    runtime: 'node',
    permissions: ['tools.register'],
  })
  if (result.ok) return undefined
  return result.errors.find((error) => error.field === 'id')?.message
}

function takesValue(argument: string): argument is '--id' | '--kind' | '--runtime' {
  return argument === '--id' || argument === '--kind' || argument === '--runtime'
}

/** Splits the command line. Errors are usage errors; the CLI turns them into exit code 2. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let dir = ''
  let id: string | undefined
  let kind: string | undefined
  let runtime: string | undefined
  let yes = false
  let help = false

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument === '--yes') {
      yes = true
    } else if (argument === '--help' || argument === '-h') {
      help = true
    } else if (takesValue(argument)) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${argument} needs a value`)
      index += 1
      if (argument === '--id') id = value
      else if (argument === '--kind') kind = value
      else runtime = value
    } else if (argument.startsWith('-')) {
      throw new Error(`unknown option: ${argument}`)
    } else if (dir === '') {
      dir = argument
    } else {
      throw new Error(`unexpected argument: ${argument}`)
    }
  }

  return {
    dir,
    ...(id === undefined ? {} : { id }),
    ...(kind === undefined ? {} : { kind }),
    ...(runtime === undefined ? {} : { runtime }),
    yes,
    help,
  }
}

async function ask(parsed: ParsedArgs, io: PromptIo, label: string, fallback: string): Promise<string> {
  if (parsed.yes) return fallback
  const answer = (await io.question(`${label} (default "${fallback}"): `)).trim()
  return answer === '' ? fallback : answer
}

/** Turns parsed arguments into validated options, prompting for whatever the command line left out. */
export async function resolveOptions(parsed: ParsedArgs, io: PromptIo): Promise<ScaffoldOptions> {
  if (parsed.dir === '') throw new Error('a directory is required')
  const fallbackId = path.basename(path.resolve(parsed.dir))
  const id = parsed.id ?? await ask(parsed, io, 'plugin id', fallbackId)
  const kind = parsed.kind ?? await ask(parsed, io, 'kind (channel/activity/capability/memory-provider)', 'capability')
  const runtime = parsed.runtime ?? await ask(parsed, io, 'runtime (node/process)', 'node')

  const reason = idError(id)
  if (reason !== undefined) throw new Error(`invalid plugin id "${id}": ${reason}`)
  if (!(PLUGIN_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`invalid kind "${kind}": expected ${PLUGIN_KINDS.join(', ')}`)
  }
  if (runtime !== 'node' && runtime !== 'process') {
    throw new Error(`invalid runtime "${runtime}": expected node or process`)
  }
  return { dir: parsed.dir, id, kind: kind as PluginKind, runtime }
}

const PERMISSIONS: Readonly<Record<PluginKind, readonly string[]>> = {
  channel: ['channel.provide', 'channel.send', 'agent.session', 'memory.ingest', 'tools.register'],
  activity: ['schedule.ownTime', 'agent.session', 'memory.ingest', 'tools.register'],
  capability: ['tools.register'],
  'memory-provider': ['memory.readL0', 'memory.writeDerived', 'tools.register'],
}

function writesMemory(kind: PluginKind): boolean {
  return kind === 'channel' || kind === 'activity'
}

function sourceLine(id: string, kind: PluginKind): string {
  const trust = kind === 'activity' ? 'external' : 'member'
  return [
    '    "source": {',
    `      "channels": ["${id}:note:example"],`,
    `      "eventKinds": ["${id}.note"],`,
    '      "defaultVisibility": "open",',
    `      "trust": "${trust}"`,
    '    },',
  ].join('\n')
}

function ingestBlock(id: string): string {
  return [
    '  await ctx.memory.ingest({',
    `    kind: '${id}.note',`,
    `    channel: '${id}:note:example',`,
    '    subjects: [],',
    `    actor: '${id}',`,
    "    content: { text: 'the plugin started' },",
    '    tEvent: Date.now(),',
    `    idempotencyKey: \`${id}:start:\${Date.now()}\`,`,
    '  })',
  ].join('\n')
}

const NO_INGEST = '  // This kind does not write memory, so there is no ctx.memory.ingest call here.'

function placeholders(options: ScaffoldOptions): Readonly<Record<string, string>> {
  return {
    __ID__: options.id,
    __KINDS__: JSON.stringify([options.kind]),
    __PERMISSIONS__: JSON.stringify(PERMISSIONS[options.kind]),
    __SOURCE_LINE__: writesMemory(options.kind) ? sourceLine(options.id, options.kind) : '',
    __INGEST__: writesMemory(options.kind) ? ingestBlock(options.id) : NO_INGEST,
  }
}

const TEMPLATE_SUFFIX = '.tmpl'
const PLACEHOLDER = /__[A-Z][A-Z0-9_]*__/g

function fill(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(PLACEHOLDER, (token) => {
    const value = values[token]
    if (value === undefined) throw new Error(`unknown template placeholder ${token}`)
    return value
  })
}

async function readTree(root: string, base = root): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  const entries = await readdir(root, { withFileTypes: true })
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      for (const [name, contents] of await readTree(full, base)) files.set(name, contents)
    } else if (entry.isFile()) {
      const contents = (await readFile(full, 'utf8')).replace(/\r\n/g, '\n')
      files.set(path.relative(base, full).split(path.sep).join('/'), contents)
    }
  }
  return files
}

async function assertWritable(dir: string): Promise<void> {
  let existing
  try {
    existing = await stat(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!existing.isDirectory()) throw new Error(`"${dir}" exists and is not a directory`)
  const entries = await readdir(dir)
  if (entries.length > 0) throw new Error(`directory "${dir}" already exists and is not empty`)
}

/** Writes the template into `options.dir` and returns the files it created, relative to that directory. */
export async function generateProject(options: ScaffoldOptions): Promise<readonly string[]> {
  const reason = idError(options.id)
  if (reason !== undefined) throw new Error(`invalid plugin id "${options.id}": ${reason}`)
  const dir = path.resolve(options.dir)
  await assertWritable(dir)

  const values = placeholders(options)
  const templateDir = path.join(TEMPLATES_DIR, options.runtime)
  const files = await readTree(templateDir)
  const written: string[] = []
  for (const [relative, contents] of files) {
    const name = relative.endsWith(TEMPLATE_SUFFIX) ? relative.slice(0, -TEMPLATE_SUFFIX.length) : relative
    const target = path.join(dir, ...name.split('/'))
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, fill(contents, values))
    written.push(name)
  }
  return written.sort()
}

/** Runs the CLI and returns its exit code. 0 means success, 2 a usage error and 1 a refused generation. */
export async function runCli(argv: readonly string[], io: PromptIo): Promise<number> {
  let parsed: ParsedArgs
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    io.stderr(`${messageOf(error)}\n${USAGE}\n`)
    return 2
  }
  if (parsed.help) {
    io.stdout(`${USAGE}\n\nCreates a Brain Core plugin from a template. With --yes the defaults are `
      + 'the directory name for id, capability for kind and node for runtime.\n')
    return 0
  }
  if (parsed.dir === '') {
    io.stderr(`a directory is required\n${USAGE}\n`)
    return 2
  }
  try {
    const options = await resolveOptions(parsed, io)
    const files = await generateProject(options)
    io.stdout(`created ${options.id} in ${options.dir} (${files.length} files)\n`)
    io.stdout(`next: cd ${options.dir} && npm install && npm test\n`)
    return 0
  } catch (error) {
    io.stderr(`${messageOf(error)}\n`)
    return 1
  }
}
