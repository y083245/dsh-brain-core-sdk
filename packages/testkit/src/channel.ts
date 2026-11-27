import type { ChannelProvider, OutboundMessage } from '@dsh-brain-core/sdk'

export interface FakeChannel extends ChannelProvider {
  readonly sent: readonly { readonly channel: string; readonly message: OutboundMessage }[]
  setMembers(channel: string, people: readonly string[]): void
}

class FakeChannelImplementation implements FakeChannel {
  readonly sent: { readonly channel: string; readonly message: OutboundMessage }[] = []
  readonly #members = new Map<string, readonly string[]>()

  setMembers(channel: string, people: readonly string[]): void {
    this.#members.set(channel, [...people])
  }

  async send(channel: string, message: OutboundMessage): Promise<{ readonly messageId?: string }> {
    this.sent.push({ channel, message })
    return { messageId: `msg_${this.sent.length}` }
  }

  async members(channel: string): Promise<readonly string[]> {
    return this.#members.get(channel) ?? []
  }

  async resolveIdentity(account: string): Promise<{ readonly displayName?: string } | null> {
    void account
    return null
  }
}

/** A provider a test plugin can hand to `ctx.channel.provide`: it records sends and returns set members. */
export function createFakeChannel(): FakeChannel {
  return new FakeChannelImplementation()
}
