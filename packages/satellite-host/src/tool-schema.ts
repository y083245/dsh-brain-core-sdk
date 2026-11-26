const ANNOTATIONS = ['description', 'title', 'default', 'examples'] as const
const SCALARS = new Set(['string', 'number', 'integer', 'boolean', 'null'])

function node(schema: unknown): Record<string, unknown> {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return { type: 'json' }
  const input = schema as Record<string, unknown>
  const notes = Object.fromEntries(ANNOTATIONS.filter(key => input[key] !== undefined).map(key => [key, input[key]]))
  if (Array.isArray(input.oneOf) && input.oneOf.length >= 2) return { ...notes, oneOf: input.oneOf.map(node) }
  if (typeof input.type !== 'string') return { ...notes, type: 'json' }
  if (SCALARS.has(input.type)) {
    return {
      ...notes,
      type: input.type,
      ...(Array.isArray(input.enum) ? { enum: input.enum } : {}),
      ...(input.const !== undefined ? { const: input.const } : {}),
    }
  }
  if (input.type === 'array') return { ...notes, type: 'array', ...(input.items === undefined ? {} : { items: node(input.items) }) }
  if (input.type === 'object') {
    return { ...notes, type: 'object', properties: properties(input), additionalProperties: input.additionalProperties !== false }
  }
  return { ...notes, type: 'json' }
}

function properties(schema: Record<string, unknown>): Record<string, unknown> {
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  const entries = Object.entries((schema.properties ?? {}) as Record<string, unknown>)
  return Object.fromEntries(entries.map(([key, value]) => [key, { ...node(value), ...(required.has(key) ? { required: true } : {}) }]))
}

/** ToolParameters to DSH's parameter DSL. Throws RangeError when the root is not an object. */
export function toDshParameters(schema: Readonly<Record<string, unknown>>): Record<string, unknown> {
  if (schema.type !== 'object') throw new RangeError('tool parameters must have an object root')
  return properties(schema)
}
