import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { API_DOC_PATH, generateApiDocs } from '../scripts/gen-api-docs.ts'

const CONTEXT_MEMBERS = [
  'plugin', 'memory', 'agent', 'tools', 'channel', 'identity', 'scheduler', 'events',
  'http', 'console', 'config', 'secrets', 'storage', 'logger', 'llm',
] as const

const INTERFACE_METHODS: Readonly<Record<string, readonly string[]>> = {
  'ctx.memory': ['ingest', 'record', 'update', 'remove', 'search', 'readChannelEvent', 'context', 'forget'],
  'ctx.agent': ['session', 'wake'],
  'ctx.tools': ['register'],
  'ctx.channel': ['provide', 'send'],
  'ctx.identity': ['resolve', 'link'],
  'ctx.scheduler': ['every', 'at', 'ownTime'],
  'ctx.events': ['on', 'emit'],
  'ctx.http': ['route', 'fetch', 'subscribeWebSocket'],
  'ctx.console': ['page'],
  'ctx.secrets': ['get'],
  'ctx.storage': ['read', 'write', 'remove', 'list'],
  'ctx.logger': ['info', 'warn', 'error'],
  'ctx.llm': ['complete'],
}

/** The text of one `##` section, without the following sections. */
function section(doc: string, heading: string): string {
  const start = doc.indexOf(`## \`${heading}\``)
  assert.ok(start >= 0, `missing section ${heading}`)
  const next = doc.indexOf('\n## ', start + 1)
  return next < 0 ? doc.slice(start) : doc.slice(start, next)
}

test('the API document is generated deterministically', () => {
  assert.equal(generateApiDocs(), generateApiDocs())
})

test('the local api.md matches the generated document when present', async (t) => {
  const local = await readFile(API_DOC_PATH, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (local === undefined) {
    t.skip('Local API document is absent in this checkout')
    return
  }
  assert.equal(local.replace(/\r\n/g, '\n'), generateApiDocs())
})

test('every BrainContext member has a section', () => {
  const doc = generateApiDocs()
  for (const member of CONTEXT_MEMBERS) {
    assert.ok(section(doc, `ctx.${member}`).length > 0, `ctx.${member} is missing`)
  }
})

test('every method of every ctx interface is documented', () => {
  const doc = generateApiDocs()
  for (const [member, methods] of Object.entries(INTERFACE_METHODS)) {
    const body = section(doc, member)
    for (const method of methods) {
      assert.match(body, new RegExp(`\\b${method}\\??\\(`), `${member}.${method} is missing`)
    }
  }
})

test('the permission comments survive into the document', () => {
  const doc = generateApiDocs()
  for (const permission of [
    'memory.ingest', 'memory.record', 'memory.search', 'memory.context', 'memory.forget',
    'agent.session', 'tools.register', 'channel.provide', 'channel.send', 'identity.link',
    'schedule.ownTime', 'network:<host>', 'lan:config:<key>', 'secrets:<name>', 'llm.invoke',
  ]) {
    assert.ok(doc.includes(`// ${permission}`), `the document does not mention // ${permission}`)
  }
})

test('JSDoc on a method is carried over', () => {
  const doc = generateApiDocs()
  assert.ok(section(doc, 'ctx.agent').includes('Resolves when the turn that took this input ends'))
  assert.ok(section(doc, 'ctx.events').includes('Only names starting with'))
})
