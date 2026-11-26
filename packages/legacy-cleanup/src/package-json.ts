/** Minimal, text-preserving edits to a DSH profile package.json. */
import path from 'node:path'
import { joinLines, splitLines } from './lines.ts'

export interface PackageJsonPlan {
  /** New text, or null when nothing needs to change. */
  readonly nextText: string | null
  readonly removals: readonly string[]
  readonly manual: readonly string[]
}

function normalizeLinkTarget(target: string): string {
  const normalized = target.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isLegacyLink(value: unknown, dshHome: string, name: string): boolean {
  if (typeof value !== 'string' || !value.startsWith('link:')) return false
  const expected = normalizeLinkTarget(path.join(dshHome, 'plugins', name))
  return normalizeLinkTarget(value.slice('link:'.length)) === expected
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface RemovalSpec {
  readonly kind: 'property' | 'array-element'
  readonly name: string
  readonly label: string
}

interface LocatedRemoval {
  readonly index: number
  readonly label: string
}

/** Plan the removal of the legacy dependency and bundle entries. */
export function planPackageJson(text: string, options: {
  readonly dshHome: string
  readonly bundleNames: readonly string[]
}): PackageJsonPlan {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : ''
  const body = bom === '' ? text : text.slice(1)
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    return { nextText: null, removals: [], manual: [`cannot parse package.json: ${(error as Error).message}`] }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { nextText: null, removals: [], manual: ['package.json is not a JSON object'] }
  }
  const pkg = parsed as Record<string, unknown>
  const dependencies = pkg.dependencies
  const dsh = pkg.dsh
  const profile = dsh !== null && typeof dsh === 'object' && !Array.isArray(dsh)
    ? (dsh as Record<string, unknown>).profile
    : undefined
  const bundles = profile !== null && typeof profile === 'object' && !Array.isArray(profile)
    ? (profile as Record<string, unknown>).bundles
    : undefined

  const specs: RemovalSpec[] = []
  const manual: string[] = []
  for (const name of options.bundleNames) {
    if (dependencies !== null && typeof dependencies === 'object' && !Array.isArray(dependencies)
      && Object.hasOwn(dependencies, name)) {
      const value = (dependencies as Record<string, unknown>)[name]
      if (isLegacyLink(value, options.dshHome, name)) {
        specs.push({ kind: 'property', name, label: `dependency "${name}"` })
      } else {
        manual.push(`dependency "${name}" is not the legacy link: entry, left untouched`)
      }
    }
    if (Array.isArray(bundles) && bundles.includes(name)) {
      if (bundles.filter(entry => entry === name).length > 1) {
        manual.push(`bundle list contains "${name}" more than once, left untouched`)
      } else {
        specs.push({ kind: 'array-element', name, label: `bundle "${name}"` })
      }
    }
  }
  if (specs.length === 0) return { nextText: null, removals: [], manual }
  if (manual.length > 0) return { nextText: null, removals: [], manual }

  const lines = splitLines(body)
  const located: LocatedRemoval[] = []
  for (const spec of specs) {
    const pattern = spec.kind === 'property'
      ? new RegExp(`^\\s*"${escapeRegExp(spec.name)}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*(,?)\\s*$`)
      : new RegExp(`^\\s*"${escapeRegExp(spec.name)}"\\s*(,?)\\s*$`)
    const matches: number[] = []
    for (let index = 0; index < lines.length; index++) {
      if (pattern.test(lines[index]?.text ?? '')) matches.push(index)
    }
    if (matches.length !== 1) {
      manual.push(`${spec.label} is not on its own line, left untouched`)
      continue
    }
    const index = matches[0] ?? -1
    if (spec.kind === 'property' && dependencies !== null && typeof dependencies === 'object') {
      const expected = (dependencies as Record<string, unknown>)[spec.name]
      const match = pattern.exec(lines[index]?.text ?? '')
      const encoded = match?.[1] ?? ''
      let actual: unknown
      try {
        actual = JSON.parse(`"${encoded}"`)
      } catch {
        manual.push(`${spec.label} has an unsupported value, left untouched`)
        continue
      }
      if (actual !== expected) {
        manual.push(`${spec.label} changed while parsing, left untouched`)
        continue
      }
    }
    located.push({ index, label: spec.label })
  }
  if (manual.length > 0) return { nextText: null, removals: [], manual }

  const removalSet = new Set(located.map(item => item.index))
  for (const item of located) {
    const line = lines[item.index]
    if (line === undefined || /,\s*$/.test(line.text)) continue
    let previous = item.index - 1
    while (previous >= 0 && (removalSet.has(previous) || /^\s*$/.test(lines[previous]?.text ?? ''))) previous--
    if (previous < 0) continue
    const previousText = lines[previous]?.text ?? ''
    if (/,\s*$/.test(previousText)) {
      lines[previous]!.text = previousText.replace(/,(\s*)$/, '$1')
      continue
    }
    if (!/(\{|\[)\s*$/.test(previousText)) {
      return {
        nextText: null,
        removals: [],
        manual: [`${item.label} is followed by a missing comma, left untouched`],
      }
    }
  }

  const nextText = `${bom}${joinLines(lines.filter((_, index) => !removalSet.has(index)))}`
  const removals = located.map(item => item.label)
  if (nextText === text) return { nextText: null, removals: [], manual: [] }
  return { nextText, removals, manual: [] }
}
