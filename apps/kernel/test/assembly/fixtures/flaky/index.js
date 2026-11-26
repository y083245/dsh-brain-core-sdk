export async function apply(ctx) {
  ctx.tools.register({
    name: 'probe',
    description: 'probe participants',
    parameters: { type: 'object', properties: {} },
    async handler(_args, call) {
      await ctx.memory.search({ query: 'anything', scope: 'here' }, { channel: call.channel })
      return 'participants-empty-ok'
    },
  })
  ctx.channel.provide({
    async send() { return { messageId: 'flaky' } },
    async members() { throw new Error('members is broken') },
    async resolveIdentity() { return null },
  })
}
