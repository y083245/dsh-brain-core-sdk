import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { TestContext } from 'node:test'
import type { CheckFinding } from '../../src/index.ts'

/** The smallest plugin the contract tests accept: no tools, an apply that does nothing. */
export const COMPLIANT_MAIN = `export function apply() {
}
`

export function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'demo',
    kinds: ['capability'],
    api: '^1.0.0',
    runtime: 'node',
    permissions: [],
    ...overrides,
  }
}

export interface PluginOptions {
  readonly brain?: unknown
  /** Defaults to {@link COMPLIANT_MAIN}. */
  readonly main?: string
  /** Defaults to `main.mts`; `.mjs` and `.ts` are useful too. */
  readonly mainName?: string
  readonly packageExtra?: Readonly<Record<string, unknown>>
  /** Relative path to contents. Parent directories are created. */
  readonly files?: Readonly<Record<string, string>>
}

/** Writes a throwaway plugin package outside the repository and removes it after the test. */
export async function createPlugin(t: TestContext, options: PluginOptions = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brain-check-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const mainName = options.mainName ?? 'main.mts'
  const pkg: Record<string, unknown> = {
    name: 'fixture-plugin',
    version: '1.0.0',
    type: 'module',
    main: `./${mainName}`,
    brain: options.brain ?? manifest(),
    ...options.packageExtra,
  }
  await writeFile(path.join(root, 'package.json'), JSON.stringify(pkg, null, 2))
  await writeFile(path.join(root, mainName), options.main ?? COMPLIANT_MAIN)
  for (const [relative, text] of Object.entries(options.files ?? {})) {
    const full = path.join(root, relative)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, text)
  }
  return root
}

/** Exactly one finding for `rule`, so a broken rule cannot pass by reporting twice. */
export function only(findings: readonly CheckFinding[], rule: string): CheckFinding {
  const matching = findings.filter((finding) => finding.rule === rule)
  assert.equal(matching.length, 1, `expected one ${rule} finding, got ${matching.length}: ${JSON.stringify(findings)}`)
  return matching[0]!
}

export function rules(findings: readonly CheckFinding[]): string[] {
  return findings.map((finding) => finding.rule)
}

export interface CapturedIo {
  readonly stdout: readonly string[]
  readonly stderr: readonly string[]
  readonly io: { readonly stdout: (text: string) => void; readonly stderr: (text: string) => void }
}

export function capture(): CapturedIo {
  const stdout: string[] = []
  const stderr: string[] = []
  return { stdout, stderr, io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) } }
}
