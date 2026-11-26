/** Builds the satellite's complete environment from a whitelist; nothing else is inherited. */

export interface SatelliteEnvInput {
  readonly parent: NodeJS.ProcessEnv
  readonly platform: NodeJS.Platform
  readonly osHome: string
  readonly tmpDir: string
  readonly apiKey: string
  readonly systemPrompt: string
  readonly bridgeUrl: string
  readonly bridgeToken: string
  readonly maxOldSpaceMb: number
  readonly proxy?: { readonly http?: string; readonly https?: string; readonly no?: string }
  /** Points the adapter at a fake gateway in tests. */
  readonly baseUrl?: string
}

const INHERITED = ['PATH', 'LANG', 'LC_ALL', 'TZ']
const INHERITED_ON_WINDOWS = ['SystemRoot', 'ComSpec', 'PATHEXT', 'WINDIR']

/** Windows variable names are case-insensitive, and Node keeps whatever case the shell used. */
function lookup(parent: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return parent[name]
  const key = Object.keys(parent).find(candidate => candidate.toUpperCase() === name.toUpperCase())
  return key === undefined ? undefined : parent[key]
}

export function buildSatelliteEnv(input: SatelliteEnvInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  const names = input.platform === 'win32' ? [...INHERITED, ...INHERITED_ON_WINDOWS] : INHERITED
  for (const name of names) {
    const value = lookup(input.parent, name, input.platform)
    if (value !== undefined) env[name] = value
  }
  env.HOME = input.osHome
  env.USERPROFILE = input.osHome
  env.TMPDIR = input.tmpDir
  env.TEMP = input.tmpDir
  env.TMP = input.tmpDir
  env.DEEPSEEK_API_KEY = input.apiKey
  env.DSH_SYSTEM_PROMPT = input.systemPrompt
  env.BRAIN_BRIDGE_URL = input.bridgeUrl
  env.BRAIN_BRIDGE_TOKEN = input.bridgeToken
  env.NODE_OPTIONS = `--max-old-space-size=${input.maxOldSpaceMb}`
  if (input.proxy?.http !== undefined) env.HTTP_PROXY = input.proxy.http
  if (input.proxy?.https !== undefined) env.HTTPS_PROXY = input.proxy.https
  if (input.proxy?.no !== undefined) env.NO_PROXY = input.proxy.no
  if (input.baseUrl !== undefined) env.DEEPSEEK_BASE_URL = input.baseUrl
  return env
}
