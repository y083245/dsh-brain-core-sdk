/** Path helpers that never depend on the process working directory. */
import path from 'node:path'

/** True when `child` is `parent` or sits underneath it. */
export function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  if (relative === '') return true
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** A path relative to a root, stored with forward slashes in manifests. */
export function toPosixRelative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/')
}

/** Turn a manifest path back into a platform path, rejecting anything that escapes the root. */
export function fromPosixRelative(root: string, relative: string): string {
  if (relative === '' || relative.startsWith('/') || /^[A-Za-z]:/.test(relative)) {
    throw new Error(`invalid backup path: ${JSON.stringify(relative)}`)
  }
  const parts = relative.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new Error(`invalid backup path: ${JSON.stringify(relative)}`)
  }
  return path.join(root, ...parts)
}

/** Compare two paths after resolving them; Windows paths are case-insensitive. */
export function samePath(left: string, right: string): boolean {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Render a link target for display, stripping a Windows `\\?\` prefix. */
export function displayPath(target: string): string {
  return target.replace(/^\\\\\?\\/, '')
}
