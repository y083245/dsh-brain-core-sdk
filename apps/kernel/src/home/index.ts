import path from 'node:path'
import { assertOutsideDshHome } from '@dsh-brain-core/satellite-host'
import { ensurePrivateDir } from '@dsh-brain-core/shared'

export interface BrainPaths {
  readonly home: string
  readonly state: string
  readonly satellite: string
  readonly satelliteDshHome: string
  readonly satelliteOsHome: string
  readonly satelliteTmp: string
  readonly workspaceChat: string
  readonly workspaceActivity: string
  readonly memory: string
  readonly plugins: string
  readonly secretsFile: string
}

/** BRAIN_HOME when set and not blank, otherwise <userHome>/.brain-core; always absolute. */
export function resolveBrainHome(env: NodeJS.ProcessEnv, userHome: string): string {
  const configured = env.BRAIN_HOME?.trim() ?? ''
  return path.resolve(configured === '' ? path.join(userHome, '.brain-core') : configured)
}

/** Refuses a home inside a DSH home, then creates every directory of RFC 9.4 with mode 700. */
export async function prepareBrainHome(options: { readonly env: NodeJS.ProcessEnv; readonly userHome: string }): Promise<BrainPaths> {
  const home = resolveBrainHome(options.env, options.userHome)
  // 先拒绝：检查失败时不能留下任何目录。
  assertOutsideDshHome(home, options.env, options.userHome)

  const state = path.join(home, 'state')
  const satellite = path.join(state, 'satellite')
  const paths: BrainPaths = {
    home,
    state,
    satellite,
    satelliteDshHome: path.join(satellite, 'dsh-home'),
    satelliteOsHome: path.join(satellite, 'os-home'),
    satelliteTmp: path.join(satellite, 'tmp'),
    workspaceChat: path.join(satellite, 'workspace', 'chat'),
    workspaceActivity: path.join(satellite, 'workspace', 'activity'),
    memory: path.join(state, 'memory'),
    plugins: path.join(state, 'plugins'),
    secretsFile: path.join(state, 'secrets.json'),
  }
  const directories = [
    paths.home, paths.state, paths.satellite, paths.satelliteDshHome, paths.satelliteOsHome, paths.satelliteTmp,
    paths.workspaceChat, paths.workspaceActivity, paths.memory, paths.plugins,
  ]
  for (const dir of directories) await ensurePrivateDir(dir)
  return paths
}
