import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const webDir = path.dirname(fileURLToPath(import.meta.url))
const consoleDir = path.resolve(webDir, '..')
const configPath = path.join(webDir, 'vite.config.ts')
const require = createRequire(import.meta.url)
const viteEntry = require.resolve('vite')
const viteBin = path.resolve(path.dirname(viteEntry), '..', '..', 'bin', 'vite.js')

execFileSync(process.execPath, [viteBin, 'build', '--config', configPath], {
  cwd: consoleDir,
  stdio: 'inherit',
})
