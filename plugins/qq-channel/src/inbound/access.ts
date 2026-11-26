// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

export interface AccessConfig {
  readonly allowPrivate: readonly string[]
  readonly allowGroups: readonly string[]
  readonly denyPrivate?: readonly string[]
  readonly denyGroups?: readonly string[]
  readonly ignoredSenders?: readonly string[]
  readonly allowAllWhenEmpty?: boolean
}

/** Deny wins. An empty allowlist is closed unless the owner explicitly opens it. */
export function allowed(
  config: AccessConfig,
  kind: 'private' | 'group',
  channelId: string,
  senderId?: string,
): boolean {
  if (!/^[1-9]\d*$/.test(channelId)) return false
  if (senderId !== undefined && (!/^[1-9]\d*$/.test(senderId) || config.ignoredSenders?.includes(senderId))) return false
  const deny = kind === 'private' ? config.denyPrivate : config.denyGroups
  const allow = kind === 'private' ? config.allowPrivate : config.allowGroups
  return (
    !deny?.includes(channelId) &&
    (allow.includes(channelId) || (allow.length === 0 && config.allowAllWhenEmpty === true))
  )
}
