// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

const STATE_FILE = 'qq-state.json'

/**
 * Initial schema migration for @dsh-brain-core/plugin-qq.
 * Idempotently records initial plugin state without touching chat content.
 *
 * @param {{ storage: import('@dsh-brain-core/sdk').PluginStorage, logger: import('@dsh-brain-core/sdk').BrainLogger }} ctx
 */
export async function up({ storage, logger }) {
  const existing = await storage.read(STATE_FILE)
  if (existing === undefined) {
    await storage.write(STATE_FILE, `${JSON.stringify({ schemaVersion: 1 }, null, 2)}\n`)
  }
  logger.info('qq.migration.init', { version: 1 })
}
