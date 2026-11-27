import type { ManifestResult } from '@dsh-brain-core/sdk'
import type { ContractResult } from '../contract.ts'

/** One thing `brain plugin check` found. A `must` finding makes the plugin unfit to install. */
export interface CheckFinding {
  readonly rule: string
  readonly level: 'must' | 'should'
  readonly message: string
  readonly file?: string
  readonly line?: number
}
export interface CheckReport {
  /** No `must` finding. */
  readonly ok: boolean
  readonly manifest: ManifestResult
  readonly contract: readonly ContractResult[]
  readonly findings: readonly CheckFinding[]
  readonly notes: readonly string[]
}
