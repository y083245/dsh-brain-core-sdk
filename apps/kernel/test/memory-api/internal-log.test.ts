import assert from 'node:assert/strict'
import test from 'node:test'
import { createLogger } from '../../src/log/index.ts'
import { createMemoryApiServer } from '../../src/memory-api/index.ts'
import { openTempBrain } from './helpers.ts'

test('http.internal logs only safe error names / string codes and keeps the response generic', async (t) => {
  const brain = await openTempBrain()
  t.after(() => brain.close())
  const lines: string[] = []
  const log = createLogger({ write: (line) => { lines.push(line) } })
  let thrown: unknown
  const server = createMemoryApiServer({
    ...brain.memory,
    service: { ...brain.memory.service, health: async () => { throw thrown } },
  }, { token: 'internal-log-test', port: 0, log })
  const { port } = await server.listen()
  t.after(() => server.close())

  for (const sample of [
    { error: Object.assign(new TypeError('private path / package output'), { code: 'EINVAL' }), fields: { errorName: 'TypeError', errorCode: 'EINVAL' } },
    { error: new Error('private path / package output'), fields: { errorName: 'Error' } },
    { error: { code: 'ENOENT', message: 'private path / package output' }, fields: { errorCode: 'ENOENT' } },
    { error: Object.assign(new Error('private path / package output'), { name: 'private path / package output', code: 'C:\\private\\path' }), fields: {} },
    { error: Object.assign(new Error('private path / package output'), { code: 7 }), fields: { errorName: 'Error' } },
    { error: 'private path / package output', fields: {} },
  ]) {
    lines.length = 0
    thrown = sample.error
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/memory/health`, {
      headers: { Authorization: 'Bearer internal-log-test' },
    })
    assert.equal(response.status, 500)
    const body = await response.json() as { error: unknown; meta: { requestId: string } }
    assert.deepEqual(body.error, { code: 'INTERNAL', message: 'internal error', details: {} })
    const entry = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line.event === 'http.internal')
    assert.ok(entry)
    const { t: timestamp, level, event, requestId, ...fields } = entry
    assert.equal(typeof timestamp, 'number')
    assert.equal(level, 'error')
    assert.equal(event, 'http.internal')
    assert.equal(requestId, body.meta.requestId)
    assert.deepEqual(fields, sample.fields)
    assert.equal(JSON.stringify(body).includes('private'), false)
    assert.equal(lines.join('\n').includes('private'), false)
  }
})
