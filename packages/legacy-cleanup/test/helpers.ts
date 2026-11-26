/** Fixtures for the legacy-cleanup tests. Everything lives under a fresh temp directory. */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const CLI = path.resolve(import.meta.dirname, '..', 'src', 'cli.ts')

export interface Fixture {
  readonly root: string
  readonly dshHome: string
  readonly brainHome: string
  readonly repo: string
  readonly profiles: readonly string[]
}

export const PROFILE_NAMES = ['web', 'desktop'] as const

/** Windows junctions need no administrator rights; elsewhere a directory symlink is the equivalent. */
export const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'

export function packageJsonText(dshHome: string, profile: string, legacy: boolean): string {
  const dependencies: Record<string, string> = {}
  if (legacy) {
    dependencies['qq-agent-presets'] = `link:${path.join(dshHome, 'plugins', 'qq-agent-presets')}`
    dependencies['qq-mode-console'] = `link:${path.join(dshHome, 'plugins', 'qq-mode-console')}`
  }
  dependencies['user-plugin'] = '1.2.3'
  const bundles = ['@deepseek-ai/dsh-base']
  if (legacy) bundles.push('qq-agent-presets', 'qq-mode-console')
  bundles.push('user-plugin')
  return `${JSON.stringify({
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies,
    dsh: { profile: { bundles } },
    custom: { keep: true },
  }, null, 2)}\n`
}

export const LEGACY_PATCH = `# 用户自己的注释，清理必须保留
- id: user-tool
  name: some-user-plugin
  config:
    keep: true

# === qq-bridge MCP BEGIN ===
# 由 scripts/setup-dsh.mjs 维护；这段区块会被整体替换，请勿手工编辑内部条目。
- insert:
    - id: mcp-snowluma
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: snowluma
        transport: stdio
        command: '/usr/bin/node'
        args:
          - '/old/src/mcp-snowluma-safe.js'
- insert:
    - id: mcp-snowluma-host
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: snowluma-host
- insert:
    - id: mcp-web-search-safe
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: web-search-safe
# === qq-bridge MCP END ===
# 用户插在中间的注释
- insert:
    - id: preset-qq-chat
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: qq-chat
        name: QQ 聊天角色
        order: 10
    - id: user-preset
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: user-preset
        order: 99
- id: preset-qq-chat-v2
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: qq-chat-v2
    order: 11
- id: qq-mode
  name: qq-mode-console
  config:
    mode: reserved2
    ownerQQ: '12345'
- id: user-tool-2
  name: another-user-plugin
  config:
    keep:
      - a
      - b
`

export const CLEANED_PATCH = `# 用户自己的注释，清理必须保留
- id: user-tool
  name: some-user-plugin
  config:
    keep: true

# 用户插在中间的注释
- insert:
    - id: user-preset
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: user-preset
        order: 99
- id: user-tool-2
  name: another-user-plugin
  config:
    keep:
      - a
      - b
`

export const USER_ONLY_PATCH = `# 用户自己的注释，清理必须保留
- id: user-tool
  name: some-user-plugin
  config:
    keep: true

- id: user-tool-2
  name: another-user-plugin
  config:
    keep:
      - a
      - b
`

export const CREDENTIALS = 'refs:\n  DEEPSEEK_API_KEY: not-a-real-key\n'

export async function createFixture(options: { legacy: boolean }): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-legacy-cleanup-'))
  const dshHome = path.join(root, 'dsh')
  const brainHome = path.join(root, 'brain')
  const repo = path.join(root, 'repo')
  await fs.mkdir(path.join(repo, 'plugins', 'qq-mode-console'), { recursive: true })
  await fs.mkdir(path.join(repo, 'plugins', 'qq-agent-presets'), { recursive: true })
  await fs.mkdir(path.join(repo, 'plugins', 'user-plugin'), { recursive: true })
  await fs.mkdir(dshHome, { recursive: true })
  await fs.writeFile(path.join(dshHome, '.credentials.yaml'), CREDENTIALS, 'utf8')

  if (options.legacy) {
    await fs.mkdir(path.join(dshHome, 'plugins'), { recursive: true })
    for (const bundle of ['qq-mode-console', 'qq-agent-presets']) {
      await fs.symlink(path.join(repo, 'plugins', bundle), path.join(dshHome, 'plugins', bundle), LINK_TYPE)
    }
  }

  for (const profile of PROFILE_NAMES) {
    const profileDir = path.join(dshHome, 'profiles', profile)
    await fs.mkdir(profileDir, { recursive: true })
    await fs.writeFile(path.join(profileDir, 'package.json'), packageJsonText(dshHome, profile, options.legacy), 'utf8')
    await fs.writeFile(path.join(profileDir, 'cordis.patch.yml'), options.legacy ? LEGACY_PATCH : USER_ONLY_PATCH, 'utf8')
    if (!options.legacy) continue
    for (const bundle of ['qq-mode-console', 'qq-agent-presets']) {
      const installLink = path.join(dshHome, 'plugins', bundle)
      const nodeModulesLink = path.join(profileDir, 'node_modules', bundle)
      await fs.mkdir(path.dirname(nodeModulesLink), { recursive: true })
      await fs.symlink(installLink, nodeModulesLink, LINK_TYPE)
    }
    const userLink = path.join(profileDir, 'node_modules', 'user-plugin')
    await fs.symlink(path.join(repo, 'plugins', 'user-plugin'), userLink, LINK_TYPE)
  }
  return { root, dshHome, brainHome, repo, profiles: PROFILE_NAMES }
}

export async function removeFixture(fixture: Fixture): Promise<void> {
  await fs.chmod(path.join(fixture.dshHome, '.credentials.yaml'), 0o600).catch(() => undefined)
  await fs.rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

export interface FingerprintOptions {
  /** Skip hashing these POSIX-style relative paths (mode-only entries are still listed). */
  readonly metadataOnly?: (relativePath: string) => boolean
}

/** Hash every file, record every link target and directory, so "nothing changed" is provable. */
export async function fingerprintTree(root: string, options: FingerprintOptions = {}): Promise<string[]> {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true })
  const result: string[] = []
  for (const entry of entries) {
    const absolute = path.join(entry.parentPath, entry.name)
    const relative = path.relative(root, absolute).split(path.sep).join('/')
    const info = await fs.lstat(absolute)
    if (info.isSymbolicLink()) {
      result.push(`${relative} -> ${await fs.readlink(absolute)}`)
    } else if (info.isDirectory()) {
      result.push(`${relative}/`)
    } else if (info.isFile()) {
      const hash = options.metadataOnly?.(relative) === true
        ? `size=${info.size}`
        : createHash('sha256').update(await fs.readFile(absolute)).digest('hex')
      result.push(`${relative} ${hash}`)
    }
  }
  // readdir order is not guaranteed; sort for a stable comparison.
  return result.sort()
}

export interface CliResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Run the CLI with an explicit environment; HOME is never inherited. */
export function runCli(args: readonly string[], options: { readonly brainHome?: string } = {}): CliResult {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' }
  for (const key of ['SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  if (options.brainHome !== undefined) env.BRAIN_HOME = options.brainHome
  const run = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env })
  if (run.error !== undefined) throw run.error
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

/** List `<brainHome>/state/legacy-cleanup` without assuming it exists. */
export async function backupDirectories(brainHome: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(path.join(brainHome, 'state', 'legacy-cleanup'), { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
