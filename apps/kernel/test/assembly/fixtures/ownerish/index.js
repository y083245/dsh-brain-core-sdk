export async function apply(ctx) {
  ctx.tools.register({
    name: 'ping',
    description: 'owner only',
    parameters: { type: 'object', properties: {} },
    async handler() { return 'owner-ok' },
  })
}
