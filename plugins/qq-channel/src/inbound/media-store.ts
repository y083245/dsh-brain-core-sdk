// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

export interface MediaEntry {
  readonly recordId: string
  readonly media: readonly Readonly<Record<string, unknown>>[]
  readonly forwardIds: readonly string[]
}
/** Bounded, channel-scoped, disposable indexes. Authorization is checked at every read. */
export class MediaStore {
  private readonly entries = new Map<string, MediaEntry>()
  private readonly capacity: number
  constructor(capacity = 2000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('invalid capacity')
    this.capacity = capacity
  }
  private key(channel: string, messageId: string): string {
    return JSON.stringify([channel, messageId])
  }
  put(channel: string, messageId: string, entry: MediaEntry): void {
    const key = this.key(channel, messageId)
    this.entries.delete(key)
    this.entries.set(key, entry)
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }
  revoke(channel: string, messageId: string): void {
    this.entries.delete(this.key(channel, messageId))
  }
  has(channel: string, messageId: string): boolean {
    return this.entries.has(this.key(channel, messageId))
  }
  async readForward(
    channel: string,
    forwardId: string,
    authorize: (recordId: string) => Promise<boolean>,
  ): Promise<MediaEntry | undefined> {
    for (const [key, entry] of this.entries) {
      const [entryChannel] = JSON.parse(key) as [string, string]
      if (
        entryChannel === channel &&
        entry.forwardIds.includes(forwardId) &&
        (await authorize(entry.recordId)) &&
        this.entries.get(key) === entry
      )
        return entry
    }
    return undefined
  }
  async read(
    channel: string,
    messageId: string,
    authorize: (recordId: string) => Promise<boolean>,
  ): Promise<MediaEntry | undefined> {
    const key = this.key(channel, messageId),
      entry = this.entries.get(key)
    if (!entry || !(await authorize(entry.recordId)) || this.entries.get(key) !== entry)
      return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry
  }
}
