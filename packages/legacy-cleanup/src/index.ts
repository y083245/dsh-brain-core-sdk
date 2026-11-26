export * from './types.ts'
export { buildPlan, LEGACY_PROFILES } from './plan.ts'
export { applyPlan, readManifest, restoreBackup } from './backup.ts'
export type { BackupItem, BackupManifest } from './backup.ts'
export {
  LEGACY_BUNDLES,
  LEGACY_MCP_IDS,
  LEGACY_PRESET_IDS,
  LEGACY_PRESET_ROW_IDS,
  LEGACY_QQMODE_ID,
  planCordisPatch,
} from './cordis-patch.ts'
export { planPackageJson } from './package-json.ts'
