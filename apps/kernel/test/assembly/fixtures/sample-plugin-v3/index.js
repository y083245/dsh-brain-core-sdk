// The sample plugin used by the S3 gate. It is copied into each test's plugin directory,
// so it keeps its test-visible effects in a global instead of a file.
const sent = (globalThis.__brainSampleSent ??= [])

function textOf(args) {
  const text = args?.text
  if (typeof text !== 'string' || text.trim() === '') throw new Error('参数 text 必填')
  return text
}

let counter = 0

export async function apply(ctx) {
  const forgotten = (globalThis.__brainSampleForgotten ??= [])
  ctx.events.on('memory.forgotten', (payload) => { forgotten.push(payload.ids) })

  ctx.tools.register({
    name: 'remember',
    description: '记下一件事（原文）',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    async handler(args, call) {
      counter += 1
      const text = textOf(args)
      const { id } = await ctx.memory.ingest({
        kind: 'sample.note',
        channel: call.channel,
        subjects: [],
        actor: 'self',
        content: { text },
        tEvent: Date.now(),
        idempotencyKey: `sample-note-${counter}`,
      })
      return `记下了：${id}`
    },
  })

  ctx.tools.register({
    name: 'lookup',
    description: '查一件事',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    async handler(args, call) {
      const query = textOf({ text: args?.query })
      const found = await ctx.memory.search({ query, scope: 'here' }, { channel: call.channel })
      return found.items.map((hit) => hit.record.content.text ?? hit.record.id).join('\n') || '没找到'
    },
  })

  ctx.tools.register({
    name: 'say',
    description: '在通道里说一句话',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    async handler(args, call) {
      const text = textOf(args)
      const result = await ctx.channel.send(call.channel, { text })
      return result.messageId === undefined ? '发出去了' : `发出去了：${result.messageId}`
    },
  })

  ctx.channel.provide({
    async send(channel, message) {
      sent.push({ channel, text: message.text })
      return { messageId: `sample-${sent.length}` }
    },
    async members() {
      return ['p1', 'p2']
    },
    async resolveIdentity(account) {
      return { displayName: `成员 ${account}` }
    },
  })
}
