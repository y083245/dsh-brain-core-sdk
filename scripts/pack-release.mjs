import { execFileSync } from 'node:child_process'
import console from 'node:console'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const root = path.join(import.meta.dirname, '..')
const packages = [
  ['packages/sdk', ['generated']],
  ['packages/shared', []],
  ['packages/chat-kit', []],
  ['packages/testkit', []],
  ['packages/satellite-bundle', ['patches']],
  ['packages/satellite-host', []],
  ['packages/legacy-cleanup', []],
  ['packages/create-brain-plugin', ['templates']],
  ['apps/console', ['dist-web']],
  ['apps/kernel', ['roles']],
  ['plugins/console-chat', []],
  ['plugins/web-reader', []],
  ['plugins/memory-vector', []],
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

function pack(source, assets, manifest, version, names, staging, output) {
  const publishable = { ...manifest }
  delete publishable.private
  delete publishable.scripts
  delete publishable.devDependencies
  publishable.version = version
  publishable.engines = { node: '>=24.12.0' }
  publishable.publishConfig = { access: 'public', registry: 'https://registry.npmjs.org/' }
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

  const satelliteBundle = manifest.name === '@brain-core/satellite-bundle'
  const runtimeDir = satelliteBundle ? 'dist' : 'src'
  const compiled = satelliteBundle ? 'dist' : path.join('dist', 'src')
  cpSync(path.join(source, compiled), path.join(staging, runtimeDir), { recursive: true })
  for (const asset of assets) cpSync(path.join(source, asset), path.join(staging, asset), { recursive: true })
  cpSync(path.join(root, 'LICENSE'), path.join(staging, 'LICENSE'))
  if (manifest.name === '@brain-core/kernel') cpSync(path.join(root, 'README.md'), path.join(staging, 'README.md'))
  if (manifest.name === '@brain-core/console') writeConsoleNotices(source, staging)

  const entryPoints = [publishable.main, ...Object.values(publishable.bin ?? {}), ...Object.values(publishable.exports ?? {})]
  for (const filename of entryPoints) {
    if (filename !== undefined && !existsSync(path.join(staging, filename))) throw new Error(`Missing entry point ${filename} in ${manifest.name}`)
  }
  writeFileSync(path.join(staging, 'package.json'), JSON.stringify(publishable, null, 2) + '\n')
  const [result] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts'], {
    cwd: staging, encoding: 'utf8', shell: process.platform === 'win32',
  }))
  cpSync(path.join(staging, result.filename), path.join(output, result.filename))
  console.log(`${result.name}@${result.version} ${result.filename} (${result.entryCount} files)`)
}

const [version, directory] = process.argv.slice(2)
if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || directory === undefined) {
  console.error('usage: node scripts/pack-release.mjs <major.minor.patch> <new-output-directory>')
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
