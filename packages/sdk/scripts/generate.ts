import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SCHEMAS } from '../src/schema.ts'
import { ERROR_CODES, type ErrorCode } from '../src/types.ts'
import { toJsonSchema, type JsonSchema } from '../src/json-schema.ts'

const JSON_SCHEMA_URL = 'https://json-schema.org/draft/2020-12/schema'

export const GENERATED_DIR = fileURLToPath(new URL('../generated/', import.meta.url))

function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n'
}

function ref(name: string): JsonSchema {
  return { $ref: `#/components/schemas/${name}` }
}

function successEnvelope(data: JsonSchema): JsonSchema {
  return {
    allOf: [
      ref('Envelope'),
      {
        type: 'object',
        required: ['ok', 'data'],
        properties: { ok: { const: true }, data },
      },
    ],
  }
}

function errorEnvelope(): JsonSchema {
  return {
    allOf: [
      ref('Envelope'),
      {
        type: 'object',
        required: ['ok', 'error'],
        properties: { ok: { const: false }, error: { type: 'object' } },
      },
    ],
  }
}

function jsonBody(name: string, description: string): JsonSchema {
  return {
    required: true,
    description,
    content: { 'application/json': { schema: ref(name) } },
  }
}

function jsonResponse(description: string, data: JsonSchema): JsonSchema {
  return {
    description,
    content: { 'application/json': { schema: successEnvelope(data) } },
  }
}

function errorResponsesByStatus(): Map<number, ErrorCode[]> {
  const byStatus = new Map<number, ErrorCode[]>()
  for (const code of Object.keys(ERROR_CODES) as ErrorCode[]) {
    const status = ERROR_CODES[code]
    const codes = byStatus.get(status) ?? []
    codes.push(code)
    byStatus.set(status, codes)
  }
  return new Map([...byStatus.entries()].sort(([a], [b]) => a - b))
}

const PATH_ID = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string' },
}

const IF_MATCH = {
  name: 'If-Match',
  in: 'header',
  required: true,
  description: 'The record version the update expects (optimistic lock). A mismatch returns CONFLICT.',
  schema: { type: 'integer' },
}

function buildOpenApi(components: Record<string, JsonSchema>): JsonSchema {
  const errorResponses: Record<string, JsonSchema> = {}
  const errorResponseRefs: Record<string, JsonSchema> = {}
  for (const [status, codes] of errorResponsesByStatus()) {
    const name = `Error${status}`
    errorResponses[name] = {
      description: `${codes.join(' / ')} (HTTP ${status})`,
      content: { 'application/json': { schema: errorEnvelope() } },
    }
    errorResponseRefs[String(status)] = { $ref: `#/components/responses/${name}` }
  }

  const responses = (description: string, data: JsonSchema, status = '200'): JsonSchema => ({
    [status]: jsonResponse(description, data),
    ...errorResponseRefs,
  })

  const objectData: JsonSchema = { type: 'object' }

  const paths: JsonSchema = {
    '/api/v1/memory/events': {
      post: {
        operationId: 'ingestEvent',
        summary: 'Append an L0 event',
        requestBody: jsonBody('IngestEvent', 'The event to append. idempotencyKey is required.'),
        responses: responses('Event accepted for asynchronous ingest', {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        }, '202'),
      },
    },
    '/api/v1/memory/records': {
      post: {
        operationId: 'createRecord',
        summary: 'Write an L1 or L2 record',
        requestBody: jsonBody('RecordInput', 'The record to write. evidence is required.'),
        responses: responses('Record created', ref('MemoryRecord')),
      },
    },
    '/api/v1/memory/records/{id}': {
      patch: {
        operationId: 'updateRecord',
        summary: 'Update a record with optimistic locking',
        parameters: [PATH_ID, IF_MATCH],
        requestBody: jsonBody('RecordPatch', 'The fields to change.'),
        responses: responses('Record updated', ref('MemoryRecord')),
      },
      delete: {
        operationId: 'deleteRecord',
        summary: 'Tombstone a record',
        parameters: [PATH_ID],
        responses: responses('Record tombstoned', { type: 'object', properties: {} }),
      },
    },
    '/api/v1/memory/search': {
      post: {
        operationId: 'searchMemory',
        summary: 'Search memory',
        requestBody: jsonBody('SearchRequest', 'Query, scope and optional filters.'),
        responses: responses('Search results; pagination is in meta.nextCursor and degradation in meta.degraded', {
          type: 'object',
          required: ['items'],
          properties: {
            items: { type: 'array', items: ref('SearchHit') },
          },
        }),
      },
    },
    '/api/v1/memory/context': {
      post: {
        operationId: 'getContext',
        summary: 'Assemble the context bundle for one wake',
        requestBody: jsonBody('ContextRequest', 'The channel to assemble for.'),
        responses: responses('Context bundle', ref('ContextBundle')),
      },
    },
    '/api/v1/memory/forget': {
      post: {
        operationId: 'forgetMemory',
        summary: 'Forget records and cascade to higher layers',
        requestBody: jsonBody('ForgetSelector', 'What to forget.'),
        responses: responses('Forget report', ref('ForgetReport')),
      },
    },
    '/api/v1/memory/jobs': {
      post: {
        operationId: 'createJob',
        summary: 'Start a maintenance job',
        requestBody: {
          required: true,
          description: 'Job shape is not final yet; any object is accepted for now.',
          content: { 'application/json': { schema: objectData } },
        },
        responses: responses('Job accepted', objectData),
      },
    },
    '/api/v1/memory/jobs/{id}': {
      get: {
        operationId: 'getJob',
        summary: 'Read a maintenance job',
        parameters: [PATH_ID],
        responses: responses('Job status', objectData),
      },
    },
    '/api/v1/memory/health': {
      get: {
        operationId: 'getHealth',
        summary: 'Read component health',
        responses: responses('Health by component', {
          type: 'object',
          additionalProperties: { enum: ['ok', 'degraded', 'down'] },
        }),
      },
    },
  }

  return {
    openapi: '3.1.0',
    info: { title: 'Brain Core Memory API', version: '1.0' },
    paths,
    components: { schemas: components, responses: errorResponses },
  }
}

/** Build every generated file, keyed by its path relative to `generated/`. */
export function generateFiles(): Record<string, string> {
  const components: Record<string, JsonSchema> = {}
  const files: Record<string, string> = {}
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    const json = toJsonSchema(schema)
    components[name] = json
    files[`json-schema/${name}.json`] = serialize({ $schema: JSON_SCHEMA_URL, title: name, ...json })
  }
  files['openapi.json'] = serialize(buildOpenApi(components))
  return files
}

/** Replace `dir` with exactly the generated tree. */
export async function writeGenerated(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
  for (const [path, contents] of Object.entries(generateFiles())) {
    const target = join(dir, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, contents, 'utf8')
  }
}

export interface GeneratedMismatch {
  path: string
  reason: 'missing' | 'unexpected' | 'different'
}

async function readTree(dir: string, base = dir): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>()
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      for (const [path, contents] of await readTree(full, base)) files.set(path, contents)
    } else if (entry.isFile()) {
      files.set(relative(base, full).split(sep).join('/'), await readFile(full))
    }
  }
  return files
}

/** Compare what is on disk with what `generateFiles()` produces. */
export async function compareGenerated(dir: string): Promise<GeneratedMismatch[]> {
  const expected = generateFiles()
  const actual = await readTree(dir).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map<string, Buffer>()
    throw error
  })
  const mismatches: GeneratedMismatch[] = []
  for (const path of Object.keys(expected).sort()) {
    const contents = actual.get(path)
    if (!contents) {
      mismatches.push({ path, reason: 'missing' })
    } else if (!contents.equals(Buffer.from(expected[path]!, 'utf8'))) {
      mismatches.push({ path, reason: 'different' })
    }
  }
  for (const path of [...actual.keys()].sort()) {
    if (!(path in expected)) mismatches.push({ path, reason: 'unexpected' })
  }
  return mismatches
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) {
  await writeGenerated(GENERATED_DIR)
  console.log(`Generated ${Object.keys(generateFiles()).length} files in ${GENERATED_DIR}`)
}
