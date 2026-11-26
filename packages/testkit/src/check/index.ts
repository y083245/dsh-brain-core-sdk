import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateManifest, type ManifestResult, type PluginApply } from '@brain-core/sdk'
import { runPluginContractTests, type ContractResult } from '../contract.ts'
import { SCAN_RULES, scanSources } from './scan.ts'
import type { CheckFinding, CheckReport } from './types.ts'

export type { CheckFinding, CheckReport } from './types.ts'

/** Fixed note: these three are invisible to a static scan and are covered by permissions and processes. */
const UNSEEN_NOTE = '动态 import()、拼出来的模块名、eval 拦不住，靠权限和进程外运行兜底'
const PROCESS_NOTE = '进程外插件的契约请用 Python 或自己的测试跑'

let loadCount = 0

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function readPackageJson(root: string): Promise<{ readonly ok: true; readonly json: Record<string, unknown> } | { readonly ok: false; readonly message: string }> {
  let text: string
  try {
    text = await readFile(path.join(root, 'package.json'), 'utf8')
  } catch {
    return { ok: false, message: 'package.json not found' }
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, message: 'package.json is not an object' }
    }
    return { ok: true, json: parsed as Record<string, unknown> }
  } catch (error) {
    return { ok: false, message: `package.json is not valid JSON: ${messageOf(error)}` }
  }
}

/** A fresh URL per run so a file rewritten between two checks is never served from the module cache. */
async function loadPluginModule(file: string): Promise<Record<string, unknown>> {
  loadCount += 1
  const url = `${pathToFileURL(file).href}?brain-plugin-check=${loadCount}`
  return await import(url) as Record<string, unknown>
}

/**
 * Every check `brain plugin check` runs: the manifest, the testkit contract for an in-process plugin,
 * and the static rules. A failing manifest stops the other steps, as the work order asks.
 */
export async function checkPlugin(dir: string): Promise<CheckReport> {
  const root = path.resolve(dir)
  const notes: string[] = [UNSEEN_NOTE]
  const findings: CheckFinding[] = []

  const pkg = await readPackageJson(root)
  if (!pkg.ok) {
    const manifest: ManifestResult = { ok: false, errors: [{ field: '', message: pkg.message }] }
    findings.push({ rule: 'manifest', level: 'must', message: pkg.message })
    return { ok: false, manifest, contract: [], findings, notes }
  }

  const brain = pkg.json.brain
  const manifest = validateManifest(brain)
  if (!manifest.ok) {
    findings.push({
      rule: 'manifest',
      level: 'must',
      file: 'package.json',
      message: manifest.errors.map((error) => `${error.field}: ${error.message}`).join('; '),
    })
    return { ok: false, manifest, contract: [], findings, notes }
  }

  if (manifest.manifest.runtime === 'process') {
    notes.push(PROCESS_NOTE)
    return { ok: true, manifest, contract: [], findings, notes }
  }

  const contract: ContractResult[] = []
  const main = pkg.json.main
  const failApply = (message: string, file?: string): void => {
    findings.push({ rule: 'apply', level: 'must', message, ...(file === undefined ? {} : { file }) })
  }
  if (typeof main !== 'string' || main === '') {
    failApply('package.json has no "main", so the plugin cannot be loaded', 'package.json')
  } else {
    let loaded: Record<string, unknown> | undefined
    try {
      loaded = await loadPluginModule(path.resolve(root, main))
    } catch (error) {
      failApply(`cannot import "${main}": ${messageOf(error)}`, main)
    }
    if (loaded !== undefined) {
      const apply = loaded.apply
      if (typeof apply !== 'function') {
        failApply(`"${main}" does not export an apply function`, main)
      } else {
        const results = await runPluginContractTests({ apply: apply as PluginApply }, brain)
        contract.push(...results)
        for (const result of results) {
          if (!result.ok) findings.push({ rule: result.name, level: 'must', message: result.message })
        }
      }
    }
  }

  findings.push(...await scanSources(root))
  const ok = findings.every((finding) => finding.level !== 'must')
  return { ok, manifest, contract, findings, notes }
}

function describe(finding: CheckFinding): string {
  const location = finding.file === undefined
    ? ''
    : `${finding.file}${finding.line === undefined ? '' : `:${finding.line}`} `
  return `  ${location}[${finding.level}] ${finding.rule}: ${finding.message}`
}

function formatReport(report: CheckReport, dir: string): string {
  const lines: string[] = [`brain plugin check: ${dir}`, '']
  const manifestFindings = report.findings.filter((finding) => finding.rule === 'manifest')
  lines.push(`manifest: ${report.manifest.ok ? 'pass' : 'fail'}`)
  for (const finding of manifestFindings) lines.push(describe(finding))

  if (!report.manifest.ok) {
    lines.push('contract: skipped (the manifest is invalid)')
    lines.push('scan: skipped (the manifest is invalid)')
  } else if (report.manifest.manifest.runtime === 'process') {
    lines.push('contract: skipped (process runtime)')
    lines.push('scan: skipped (process runtime)')
  } else {
    const contractFailed = report.contract.some((result) => !result.ok)
      || report.findings.some((finding) => finding.rule === 'apply')
    lines.push(`contract: ${contractFailed ? 'fail' : report.contract.length === 0 ? 'skipped' : 'pass'}`)
    for (const result of report.contract) {
      lines.push(`  ${result.name}: ${result.ok ? 'pass' : 'fail'} — ${result.message}`)
    }
    for (const finding of report.findings.filter((item) => item.rule === 'apply' || (!SCAN_RULES.has(item.rule) && item.rule !== 'manifest'))) {
      lines.push(describe(finding))
    }

    const staticFindings = report.findings.filter((finding) => SCAN_RULES.has(finding.rule))
    lines.push(`scan: ${staticFindings.some((finding) => finding.level === 'must') ? 'fail' : 'pass'}`)
    for (const finding of staticFindings) lines.push(describe(finding))
  }

  if (report.notes.length > 0) {
    lines.push('notes:')
    for (const note of report.notes) lines.push(`  - ${note}`)
  }
  const must = report.findings.filter((finding) => finding.level === 'must').length
  const should = report.findings.filter((finding) => finding.level === 'should').length
  lines.push('', report.ok
    ? (should === 0 ? 'result: pass' : `result: pass (0 must, ${should} should)`)
    : `result: fail (${must} must, ${should} should)`)
  return `${lines.join('\n')}\n`
}

const USAGE = 'usage: brain plugin check [--json] [dir]\n'

/** Prints the report; returns the exit code, 1 when any 'must' item fails. */
export async function runCheckCli(
  argv: readonly string[],
  io: { readonly stdout: (text: string) => void; readonly stderr: (text: string) => void },
): Promise<number> {
  let json = false
  const positional: string[] = []
  for (const argument of argv) {
    if (argument === '--json') json = true
    else if (argument === '--help' || argument === '-h') {
      io.stdout(`${USAGE}\nChecks a plugin directory against RFC 8.7 and runs the testkit contract.\n`)
      return 0
    } else if (argument.startsWith('-')) {
      io.stderr(`unknown option: ${argument}\n${USAGE}`)
      return 2
    } else positional.push(argument)
  }
  if (positional.length > 1) {
    io.stderr(`expected one directory, got ${positional.length}\n${USAGE}`)
    return 2
  }
  const dir = positional[0] ?? process.cwd()
  let report: CheckReport
  try {
    report = await checkPlugin(dir)
  } catch (error) {
    io.stderr(`brain plugin check failed: ${messageOf(error)}\n`)
    return 2
  }
  io.stdout(json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report, dir))
  return report.ok ? 0 : 1
}
