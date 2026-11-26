#!/usr/bin/env node
/** `brain-legacy-cleanup` — remove the old QQ bridge from DSH profiles. */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { applyPlan, readManifest, restoreBackup } from './backup.ts'
import { buildPlan } from './plan.ts'
import type { CleanupPlan } from './types.ts'

const USAGE = `Usage:
  brain-legacy-cleanup plan --dsh-home <dir>
  brain-legacy-cleanup apply --dsh-home <dir> --yes
  brain-legacy-cleanup restore --backup <dir> --dsh-home <dir> --yes

--dsh-home is always required; there is no default. apply needs --yes and first
backs up to $BRAIN_HOME/state/legacy-cleanup/<timestamp>/.`

function usageError(message: string): never {
  console.error(`[legacy-cleanup] ${message}`)
  console.error(USAGE)
  process.exit(2)
}

function refuse(message: string): never {
  console.error(`[legacy-cleanup] refused: ${message}`)
  process.exit(1)
}

function printPlan(plan: CleanupPlan): void {
  console.log(`[legacy-cleanup] DSH home: ${plan.dshHome}`)
  const files = plan.changes.filter(change => change.kind === 'file-edit').length
  const links = plan.changes.length - files
  console.log(`[legacy-cleanup] planned: ${files} file edit(s), ${links} link removal(s), ${plan.manual.length} manual item(s)`)
  for (const change of plan.changes) {
    if (change.kind === 'file-edit') {
      console.log(`  edit    ${change.relativePath}`)
      for (const removal of change.removals) console.log(`            - ${removal}`)
    } else {
      console.log(`  unlink  ${change.relativePath} -> ${change.target}`)
    }
  }
  for (const item of plan.manual) console.log(`  manual  ${item.relativePath}: ${item.reason}`)
}

function resolveBrainHome(): string {
  const configured = process.env.BRAIN_HOME
  const home = configured === undefined || configured.trim() === ''
    ? path.join(os.homedir(), '.brain-core')
    : configured
  return path.resolve(home)
}

async function requireDshHome(value: string | undefined): Promise<string> {
  if (value === undefined) usageError('--dsh-home is required')
  const dshHome = path.resolve(value)
  let info
  try {
    info = await fs.stat(dshHome)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') usageError(`--dsh-home does not exist: ${dshHome}`)
    throw error
  }
  if (!info.isDirectory()) usageError(`--dsh-home is not a directory: ${dshHome}`)
  return dshHome
}

async function main(): Promise<void> {
  let parsed
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        'dsh-home': { type: 'string' },
        backup: { type: 'string' },
        yes: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h' },
      },
    })
  } catch (error) {
    usageError((error as Error).message)
  }
  const { values, positionals } = parsed
  if (values.help === true) {
    console.log(USAGE)
    return
  }
  const command = positionals[0]
  if (command === undefined) usageError('a subcommand is required')
  if (positionals.length > 1) usageError(`unexpected argument: ${positionals[1]}`)

  if (command === 'plan') {
    const dshHome = await requireDshHome(values['dsh-home'])
    printPlan(await buildPlan(dshHome))
    return
  }

  if (command === 'apply') {
    const dshHome = await requireDshHome(values['dsh-home'])
    const plan = await buildPlan(dshHome)
    printPlan(plan)
    if (plan.changes.length === 0) {
      console.log('[legacy-cleanup] nothing to clean up; no backup written')
      return
    }
    if (values.yes !== true) {
      refuse('apply needs --yes; nothing was changed')
    }
    const result = await applyPlan(plan, { brainHome: resolveBrainHome() })
    console.log(`[legacy-cleanup] applied ${result.applied} change(s); backup: ${result.backupDir ?? '(none)'}`)
    return
  }

  if (command === 'restore') {
    if (values.backup === undefined) usageError('--backup is required for restore')
    const dshHome = await requireDshHome(values['dsh-home'])
    const manifest = await readManifest(values.backup)
    console.log(`[legacy-cleanup] backup: ${path.resolve(values.backup)}`)
    console.log(`[legacy-cleanup] restore target: ${dshHome} (backup was taken from ${manifest.dshHome})`)
    for (const item of manifest.items) console.log(`  restore ${item.path}`)
    if (values.yes !== true) refuse('restore needs --yes; nothing was changed')
    const result = await restoreBackup(values.backup, dshHome)
    console.log(`[legacy-cleanup] restored ${result.restored.length} item(s)`)
    return
  }

  usageError(`unknown subcommand: ${command}`)
}

await main().catch(error => {
  console.error(`[legacy-cleanup] error: ${(error as Error).message}`)
  process.exitCode = 1
})
