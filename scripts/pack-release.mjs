import { execFileSync } from 'node:child_process'
import console from 'node:console'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const root = path.join(import.meta.dirname, '..')
const packages = [
  ['packages/sdk', ['generated', 'guides', 'README.md']],
  ['packages/shared', ['README.md']],
  ['packages/chat-kit', ['README.md']],
  ['packages/testkit', ['README.md']],
  ['packages/satellite-bundle', ['patches', 'README.md']],
  ['packages/satellite-host', ['README.md']],
  ['packages/legacy-cleanup', ['README.md']],
  ['packages/create-brain-plugin', ['templates', 'README.md']],
  ['apps/console', ['dist-web', 'README.md']],
  ['apps/kernel', ['roles']],
  ['plugins/console-chat', ['README.md']],
  ['plugins/web-reader', ['README.md']],
  ['plugins/memory-vector', ['README.md']],
  ['plugins/qq-channel', ['migrations', 'README.md']],
]

function readJson(filename) {
  return JSON.parse(readFileSync(filename, 'utf8'))
}

function publishedPath(filename) {
  return filename?.replace(/\.ts$/, '.js')
}

function rewritePaths(entries) {
  if (entries === undefined) return undefined
  return Object.fromEntries(Object.entries(entries).map(([name, filename]) => [name, publishedPath(filename)]))
}

function writeConsoleNotices(source, staging) {
  const seen = new Set()
  const notices = []

  function collect(name, from) {
    const require = createRequire(path.join(from, 'package.json'))
    let dir = path.dirname(require.resolve(name))
    while (!existsSync(path.join(dir, 'package.json')) || readJson(path.join(dir, 'package.json')).name !== name) {
      const parent = path.dirname(dir)
      if (parent === dir) throw new Error(`Cannot locate the manifest for ${name}`)
      dir = parent
    }
    if (seen.has(dir)) return
    seen.add(dir)
    const manifest = readJson(path.join(dir, 'package.json'))
    const license = readdirSync(dir).find((file) => /^(?:licen[cs]e|copying)(?:\.(?:md|txt))?$/i.test(file))
    if (license === undefined) throw new Error(`Cannot locate the license for ${name}`)
    notices.push(`${name}@${manifest.version}\n\n${readFileSync(path.join(dir, license), 'utf8').trim()}`)
    for (const dependency of Object.keys(manifest.dependencies ?? {})) collect(dependency, dir)
  }

  for (const name of ['lucide-react', 'motion', 'react', 'react-dom', 'tailwindcss', 'three']) collect(name, source)
  writeFileSync(path.join(staging, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n\n----------------------------------------\n\n') + '\n')
}

/** Keep package-local links; turn links to omitted repository files into public URLs. */
function rewriteMarkdownLinks(staging, source, relFile = 'README.md') {
  const filename = path.join(staging, relFile)
  if (!existsSync(filename)) return
  const stagingDir = path.dirname(filename)
  const sourceDir = path.dirname(path.join(source, relFile))

  const inside = (base, target) => {
    const relative = path.relative(base, target)
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  }
  function resolveTarget(target) {
    // External URLs, protocol-relative URLs and same-page anchors need no filesystem lookup.
    if (target === '' || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) return target
    const boundary = target.search(/[?#]/)
    const pathname = boundary < 0 ? target : target.slice(0, boundary)
    const suffix = boundary < 0 ? '' : target.slice(boundary)
    const decoded = decodeURIComponent(pathname.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~\\])/g, '$1'))
    const packaged = path.resolve(stagingDir, decoded)
    if (inside(staging, packaged) && existsSync(packaged)) return target
    const original = path.resolve(sourceDir, decoded)
    if (!inside(root, original) || !existsSync(original)) {
      throw new Error(`Broken Markdown link in ${path.relative(root, path.join(source, relFile)) || relFile}: ${target}`)
    }
    const kind = statSync(original).isDirectory() ? 'tree' : 'blob'
    const relative = path.relative(root, original).split(path.sep).map(encodeURIComponent).join('/')
    return `https://github.com/y083245/dsh-brain-core-sdk/${kind}/main/${relative}${suffix}`
  }

  function rewriteProse(markdown) {
    let result = ''
    let copied = 0
    for (let i = 0; i < markdown.length; i += 1) {
      if (markdown[i] === '\\') { i += 1; continue }
      // Backtick spans may contain examples that look exactly like Markdown links.
      if (markdown[i] === '`') {
        const ticks = /^`+/.exec(markdown.slice(i))[0]
        const runs = /`+/g
        runs.lastIndex = i + ticks.length
        let close
        while ((close = runs.exec(markdown)) !== null && close[0].length !== ticks.length) { /* find matching run */ }
        i = close === null ? i + ticks.length - 1 : close.index + ticks.length - 1
        continue
      }
      if (markdown[i] !== '[') continue
      let labelEnd = i + 1
      let depth = 1
      for (; labelEnd < markdown.length; labelEnd += 1) {
        const char = markdown[labelEnd]
        if (char === '\\') { labelEnd += 1; continue }
        if (char === '[') depth += 1
        if (char === ']' && --depth === 0) break
      }
      if (depth !== 0 || markdown[labelEnd + 1] !== '(') continue
      let start = labelEnd + 2
      while (/\s/.test(markdown[start] ?? '') && start < markdown.length) start += 1
      const angle = markdown[start] === '<'
      if (angle) start += 1
      let end = start
      let parentheses = 0
      for (; end < markdown.length; end += 1) {
        const char = markdown[end]
        if (char === '\\') { end += 1; continue }
        if (angle) { if (char === '>') break }
        else {
          if (char === '(') parentheses += 1
          else if (char === ')') { if (parentheses === 0) break; parentheses -= 1 }
          else if (/\s/.test(char) && parentheses === 0) break
        }
      }
      if (end === markdown.length || (angle && markdown[end] !== '>')) continue
      const tail = markdown.slice(end + (angle ? 1 : 0))
      // Preserve optional titles, angle delimiters, whitespace and the label verbatim.
      const closing = /^(?:\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\)))?\s*\)/.exec(tail)
      if (closing === null) continue
      const target = markdown.slice(start, end)
      result += markdown.slice(copied, start) + resolveTarget(target)
      copied = end
      i = end + (angle ? 1 : 0) + closing[0].length - 1
    }
    return result + markdown.slice(copied)
  }

  let fence
  let prose = ''
  let result = ''
  for (const line of readFileSync(filename, 'utf8').split(/(?<=\n)/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line)
    if (fence !== undefined) {
      result += line
      if (marker !== null && marker[1][0] === fence[0] && marker[1].length >= fence.length && marker[2].trim() === '') fence = undefined
    } else if (marker !== null || /^(?: {4}|\t)/.test(line)) {
      result += rewriteProse(prose) + line
      prose = ''
      if (marker !== null) fence = marker[1]
    } else prose += line
  }
  writeFileSync(filename, result + rewriteProse(prose))
}

function pack(source, assets, manifest, version, names, staging, output) {
  const publishable = { ...manifest }
  delete publishable.private
  delete publishable.scripts
  delete publishable.devDependencies
  publishable.version = version
  publishable.engines = { node: '>=24.12.0' }
  publishable.publishConfig = { access: 'public', registry: 'https://registry.npmjs.org/' }
  publishable.homepage = 'https://github.com/y083245/dsh-brain-core-sdk#readme'
  publishable.bugs = { url: 'https://github.com/y083245/dsh-brain-core-sdk/issues' }
  publishable.repository = { type: 'git', url: 'git+https://github.com/y083245/dsh-brain-core-sdk.git', directory: path.relative(root, source).split(path.sep).join('/') }
  publishable.main = publishedPath(manifest.main)
  publishable.bin = rewritePaths(manifest.bin)
  publishable.exports = rewritePaths(manifest.exports)
  if (manifest.brain?.config !== undefined) publishable.brain.config = publishedPath(manifest.brain.config)
  if (manifest.brain?.process?.command === 'node') {
    publishable.brain.process.args = manifest.brain.process.args.map(publishedPath)
  }
  for (const [name, range] of Object.entries(publishable.dependencies ?? {})) {
    if (!range.startsWith('workspace:')) continue
    if (range !== 'workspace:*' || !names.has(name)) throw new Error(`Unresolved workspace dependency ${name}@${range}`)
    publishable.dependencies[name] = version
  }

  const satelliteBundle = manifest.name === '@dsh-brain-core/satellite-bundle'
  const runtimeDir = satelliteBundle ? 'dist' : 'src'
  const compiled = satelliteBundle ? 'dist' : path.join('dist', 'src')
  cpSync(path.join(source, compiled), path.join(staging, runtimeDir), { recursive: true })
  for (const asset of assets) cpSync(path.join(source, asset), path.join(staging, asset), { recursive: true })
  cpSync(path.join(root, 'LICENSE'), path.join(staging, 'LICENSE'))
  if (manifest.name === '@dsh-brain-core/kernel' && existsSync(path.join(root, 'README.md'))) {
    cpSync(path.join(root, 'README.md'), path.join(staging, 'README.md'))
  }
  if (manifest.name === 'create-brain-plugin') {
    // The template contains __KINDS__ and other placeholders, so it is not JSON yet.
    const template = path.join(staging, 'templates', 'node', 'package.json')
    const content = readFileSync(template, 'utf8').replace(
      /("@dsh-brain-core\/(?:sdk|testkit)"\s*:\s*)"[^"]*"/g,
      `$1"^${version}"`,
    )
    writeFileSync(template, content)
  }
  if (manifest.name === '@dsh-brain-core/console') writeConsoleNotices(source, staging)

  const entryPoints = [publishable.main, ...Object.values(publishable.bin ?? {}), ...Object.values(publishable.exports ?? {})]
  for (const filename of entryPoints) {
    if (filename !== undefined && !existsSync(path.join(staging, filename))) throw new Error(`Missing entry point ${filename} in ${manifest.name}`)
  }
  writeFileSync(path.join(staging, 'package.json'), JSON.stringify(publishable, null, 2) + '\n')
  const readmeSource = manifest.name === '@dsh-brain-core/kernel' ? root : source
  rewriteMarkdownLinks(staging, readmeSource, 'README.md')
  const guidesDir = path.join(staging, 'guides')
  if (existsSync(guidesDir)) {
    for (const entry of readdirSync(guidesDir).sort()) {
      if (entry.endsWith('.md')) rewriteMarkdownLinks(staging, source, path.join('guides', entry))
    }
  }
  const [result] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts'], {
    cwd: staging, encoding: 'utf8', shell: process.platform === 'win32',
  }))
  cpSync(path.join(staging, result.filename), path.join(output, result.filename))
  console.log(`${result.name}@${result.version} ${result.filename} (${result.entryCount} files)`)
}

const [version, directory] = process.argv.slice(2)
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? '') || directory === undefined) {
  console.error('usage: node scripts/pack-release.mjs <major.minor.patch[-prerelease]> <new-output-directory>')
  process.exit(2)
}

const output = path.resolve(directory)
mkdirSync(output)
const inputs = packages.map(([dir, assets]) => {
  const source = path.join(root, dir)
  return { source, assets, manifest: readJson(path.join(source, 'package.json')) }
})
const names = new Set(inputs.map(({ manifest }) => manifest.name))
for (const { source, assets, manifest } of inputs) {
  const staging = mkdtempSync(path.join(os.tmpdir(), 'brain-core-npm-'))
  try {
    pack(source, assets, manifest, version, names, staging, output)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}
