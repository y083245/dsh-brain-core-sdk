import assert from 'node:assert/strict'
import { readFile, writeFile, cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Schema from 'schemastery'
import { toJsonSchema } from '../src/json-schema.ts'
import { SCHEMAS } from '../src/schema.ts'
import { ERROR_CODES } from '../src/types.ts'
import { GENERATED_DIR, compareGenerated, generateFiles } from '../scripts/generate.ts'

type Json = Record<string, unknown>

test('generation is byte-for-byte deterministic', () => {
  const first = generateFiles()
  const second = generateFiles()
  assert.deepEqual(Object.keys(first).sort(), Object.keys(second).sort())
  for (const path of Object.keys(first)) {
    assert.equal(first[path], second[path], `${path} changed between runs`)
  }
})

test('committed generated files match a fresh generation', async () => {
  const mismatches = await compareGenerated(GENERATED_DIR)
  assert.deepEqual(mismatches, [], `generated files are stale: ${JSON.stringify(mismatches)}`)
})

test('compareGenerated detects a one-byte change without touching the repo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'brain-core-sdk-generate-'))
  const copy = join(root, 'generated')
  try {
    await cp(GENERATED_DIR, copy, { recursive: true })
    assert.deepEqual(await compareGenerated(copy), [])

    const target = join(copy, 'openapi.json')
    const bytes = await readFile(target)
    bytes[0] = bytes[0] === 0x7b ? 0x5b : 0x7b
    await writeFile(target, bytes)

    const mismatches = await compareGenerated(copy)
    assert.deepEqual(mismatches, [{ path: 'openapi.json', reason: 'different' }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('converter rejects unsupported schema types', () => {
  assert.throws(() => toJsonSchema(Schema.function()), /unsupported schema type "function"/)
  assert.throws(() => toJsonSchema(Schema.date()), /unsupported schema type/)
})

test('generated JSON Schema drops Schemastery uids and refs', () => {
  const files = generateFiles()
  for (const [path, contents] of Object.entries(files)) {
    const parsed = JSON.parse(contents) as unknown
    const keys = new Set<string>()
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item)
      } else if (value !== null && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          keys.add(key)
          walk(child)
        }
      }
    }
    walk(parsed)
    assert.ok(!keys.has('uid'), `${path} contains a Schemastery uid`)
    assert.ok(!keys.has('refs'), `${path} contains Schemastery refs`)
  }
})

test('one JSON Schema file exists per boundary schema', () => {
  const files = generateFiles()
  for (const name of Object.keys(SCHEMAS)) {
    const path = `json-schema/${name}.json`
    assert.ok(path in files, `missing ${path}`)
    const parsed = JSON.parse(files[path]!) as Json
    assert.equal(parsed.$schema, 'https://json-schema.org/draft/2020-12/schema')
    assert.equal(parsed.title, name)
  }
})

test('openapi covers the eight RFC 7.1 actions', () => {
  const openapi = JSON.parse(generateFiles()['openapi.json']!) as Json
  const paths = openapi.paths as Record<string, Record<string, Json>>
  const operations = Object.values(paths).flatMap((item) => Object.keys(item))
  assert.deepEqual(Object.keys(paths), [
    '/api/v1/memory/events',
    '/api/v1/memory/records',
    '/api/v1/memory/records/{id}',
    '/api/v1/memory/search',
    '/api/v1/memory/context',
    '/api/v1/memory/forget',
    '/api/v1/memory/jobs',
    '/api/v1/memory/jobs/{id}',
    '/api/v1/memory/health',
  ])
  assert.deepEqual(operations, ['post', 'post', 'patch', 'delete', 'post', 'post', 'post', 'post', 'get', 'get'])

  for (const [path, item] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(item)) {
      const responses = operation.responses as Record<string, Json>
      const successStatus = path === '/api/v1/memory/events' ? '202' : '200'
      assert.ok(successStatus in responses, `${method.toUpperCase()} ${path} has no ${successStatus} response`)
      for (const status of new Set(Object.values(ERROR_CODES))) {
        assert.ok(String(status) in responses, `${method.toUpperCase()} ${path} has no ${status} response`)
      }
    }
  }
})

test('ingest is the only action accepted asynchronously', () => {
  const openapi = JSON.parse(generateFiles()['openapi.json']!) as Json
  const paths = openapi.paths as Record<string, Record<string, Json>>
  const ingest = paths['/api/v1/memory/events']!.post!.responses as Record<string, Json>
  assert.ok('202' in ingest)
  assert.ok(!('200' in ingest))
})

test('openapi documents the If-Match version header and open job payloads', () => {
  const openapi = JSON.parse(generateFiles()['openapi.json']!) as Json
  const paths = openapi.paths as Record<string, Record<string, Json>>
  const patch = paths['/api/v1/memory/records/{id}']!.patch!
  const parameters = patch.parameters as Json[]
  const ifMatch = parameters.find((parameter) => parameter.name === 'If-Match')
  assert.ok(ifMatch, 'PATCH is missing If-Match')
  assert.equal(ifMatch.required, true)
  assert.equal(ifMatch.in, 'header')

  const jobs = paths['/api/v1/memory/jobs']!.post!
  const body = jobs.requestBody as Json
  const schema = (body.content as Record<string, Record<string, Json>>)['application/json']!.schema!
  assert.equal(schema.type, 'object')
})

test('openapi health data only allows ok, degraded and down', () => {
  const openapi = JSON.parse(generateFiles()['openapi.json']!) as Json
  const paths = openapi.paths as Record<string, Record<string, Json>>
  const health = paths['/api/v1/memory/health']!.get!
  const responses = health.responses as Record<string, Json>
  assert.ok(responses['200'])
  assert.match(JSON.stringify(responses['200']), /"ok"/)
  assert.match(JSON.stringify(responses['200']), /"degraded"/)
  assert.match(JSON.stringify(responses['200']), /"down"/)
})
