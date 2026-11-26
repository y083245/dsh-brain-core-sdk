export async function apply(ctx) {
  for (let index = 1; index <= 9; index += 1) {
    ctx.tools.register({
      name: `t${index}`,
      description: `tool ${index}`,
      parameters: { type: 'object' },
      async handler() { return 'ok' },
    })
  }
}
