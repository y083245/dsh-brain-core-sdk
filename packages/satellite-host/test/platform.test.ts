import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { isPathInside, isProcessAlive, killProcessTree } from '../src/platform.ts'

test('isPathInside handles posix paths', () => {
  assert.equal(isPathInside('/home/a/.dsh/x', '/home/a/.dsh', path.posix), true)
  assert.equal(isPathInside('/home/a/.dsh', '/home/a/.dsh', path.posix), true)
  assert.equal(isPathInside('/home/a/.dshx', '/home/a/.dsh', path.posix), false)
  assert.equal(isPathInside('/home/a/..dsh/x', '/home/a', path.posix), true)
})

test('isPathInside handles windows paths without regard to case', () => {
  assert.equal(isPathInside('C:\\Users\\A\\.dsh\\x', 'c:\\users\\a\\.dsh', path.win32), true)
  assert.equal(isPathInside('D:\\brain', 'C:\\Users\\A\\.dsh', path.win32), false)
})

test('killProcessTree stops a running process and tolerates a dead one', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const exited = new Promise(resolve => child.once('exit', resolve))
  const pid = child.pid
  assert.ok(pid !== undefined)
  assert.equal(isProcessAlive(pid), true)
  await killProcessTree(pid)
  await exited
  assert.equal(isProcessAlive(pid), false)
  await killProcessTree(pid)
})
