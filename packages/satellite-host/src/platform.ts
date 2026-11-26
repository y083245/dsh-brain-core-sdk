/** Every OS difference in the satellite host lives here. */
import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import path from 'node:path'

type PathApi = Pick<typeof path, 'resolve' | 'relative' | 'isAbsolute' | 'sep'>

/** True when `child` is `parent` or sits underneath it. */
export function isPathInside(child: string, parent: string, pathApi: PathApi = path): boolean {
  const relative = pathApi.relative(pathApi.resolve(parent), pathApi.resolve(child))
  if (relative === '') return true
  return relative !== '..' && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative)
}

/** Force-stop a process; Windows has no SIGKILL, so it uses taskkill and takes the whole tree. */
export async function killProcessTree(pid: number, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === 'win32') {
    await new Promise<void>(resolve => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve())
    })
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

/** True while the process exists. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Delete a directory tree, retrying while Windows holds files open (EBUSY). */
export function removeTree(target: string): Promise<void> {
  return rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
