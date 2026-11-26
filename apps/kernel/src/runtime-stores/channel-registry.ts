import { BrainError } from '@brain-core/sdk'
import type { ChannelProvider } from '@brain-core/sdk'
import type { ChannelRegistry } from '../contracts/index.ts'

/**
 * Finds a provider by the first segment of a channel (`<source>:<kind>:<id>`), which is the plugin id.
 * A plugin provides once; providing twice without disposing the first is a programming error.
 */
export function createChannelRegistry(): ChannelRegistry {
  const providers = new Map<string, {
    readonly provider: ChannelProvider
    readonly acceptsProactive: ((channel: string) => boolean) | undefined
  }>()

  function lookup(channel: string) {
    const owner = channel.split(':')[0]
    return owner === undefined || owner === '' ? undefined : providers.get(owner)
  }

  return {
    provide(owner, provider, acceptsProactive) {
      if (providers.has(owner)) throw new BrainError('CONFLICT', `a channel provider for ${owner} is already registered`)
      const entry = { provider, acceptsProactive }
      providers.set(owner, entry)
      let active = true
      return () => {
        if (!active) return
        active = false
        if (providers.get(owner) === entry) providers.delete(owner)
      }
    },

    providerOf(channel) {
      return lookup(channel)?.provider
    },

    proactiveProviderOf(channel) {
      if (channel.split(':')[1] !== 'private') return undefined
      const entry = lookup(channel)
      return entry?.acceptsProactive?.(channel) === true ? entry.provider : undefined
    },
  }
}
