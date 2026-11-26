/** Shared shapes for the cleanup plan. Nothing here touches the filesystem. */

/** One file that will be edited, with both the current and the planned text. */
export interface FileChange {
  readonly kind: 'file-edit'
  /** Absolute path of the profile file. */
  readonly path: string
  /** Path relative to the DSH home, POSIX-style, for reports and backups. */
  readonly relativePath: string
  /** UTF-8 text read during the plan; apply refuses to run if the file changed. */
  readonly originalText: string
  /** Text after removing the legacy entries. */
  readonly nextText: string
  /** Human-readable list of what will disappear. */
  readonly removals: readonly string[]
}

/** One old symlink or Windows junction that will be removed. */
export interface SymlinkChange {
  readonly kind: 'symlink-remove'
  readonly path: string
  readonly relativePath: string
  /** The link target recorded during the plan. */
  readonly target: string
  readonly removals: readonly string[]
}

export type PlannedChange = FileChange | SymlinkChange

/** Something the cleanup deliberately leaves alone because editing it would be unsafe. */
export interface ManualItem {
  readonly path: string
  readonly relativePath: string
  readonly reason: string
}

export interface CleanupPlan {
  readonly dshHome: string
  readonly changes: readonly PlannedChange[]
  readonly manual: readonly ManualItem[]
}

export interface ApplyResult {
  /** The backup directory, or null when there was nothing to do. */
  readonly backupDir: string | null
  readonly applied: number
}
