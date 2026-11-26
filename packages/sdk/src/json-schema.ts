/** A JSON Schema value. Only the subset this SDK generates is ever produced. */
export type JsonSchema = Record<string, unknown>

interface SchemaNode {
  type: string
  meta?: {
    required?: boolean
    min?: number
    max?: number
    step?: number
    pattern?: { source: string; flags?: string }
  }
  value?: unknown
  dict?: Record<string, number>
  list?: number[]
  inner?: number
  sKey?: number
}

interface SchemaDocument {
  uid: number
  refs: Record<string, SchemaNode>
}

/**
 * Convert a Schemastery schema into standard JSON Schema.
 *
 * Schemastery's own `toJSON()` output is a graph of `refs` keyed by internal
 * uids. This walks that graph and produces a plain tree, dropping the uids so
 * the result depends only on the schema shape and key order.
 *
 * Unsupported schema types are an error, never silently skipped.
 */
export function toJsonSchema(schema: { toJSON(): unknown }): JsonSchema {
  const document = schema.toJSON() as SchemaDocument
  const { refs } = document
  const converting = new Set<number>()

  function nodeOf(ref: number): SchemaNode {
    const node = refs[String(ref)]
    if (!node) throw new Error(`schema ref ${ref} is missing`)
    return node
  }

  function convertRef(ref: number): JsonSchema {
    const node = nodeOf(ref)
    if (converting.has(ref)) {
      throw new Error(`schema ref ${ref} is recursive; recursive schemas are not supported`)
    }
    converting.add(ref)
    try {
      return convertNode(node)
    } finally {
      converting.delete(ref)
    }
  }

  function convertNode(node: SchemaNode): JsonSchema {
    switch (node.type) {
      case 'any':
        return {}
      case 'string': {
        const out: JsonSchema = { type: 'string' }
        if (typeof node.meta?.min === 'number') out.minLength = node.meta.min
        if (typeof node.meta?.max === 'number') out.maxLength = node.meta.max
        if (node.meta?.pattern) {
          if (node.meta.pattern.flags) throw new Error('string pattern flags are not supported')
          out.pattern = node.meta.pattern.source
        }
        return out
      }
      case 'number': {
        const out: JsonSchema = { type: 'number' }
        if (typeof node.meta?.min === 'number') out.minimum = node.meta.min
        if (typeof node.meta?.max === 'number') out.maximum = node.meta.max
        if (typeof node.meta?.step === 'number') out.multipleOf = node.meta.step
        return out
      }
      case 'boolean':
        return { type: 'boolean' }
      case 'const':
        return { const: node.value }
      case 'array': {
        if (node.inner === undefined) throw new Error('array schema is missing its item schema')
        const out: JsonSchema = { type: 'array', items: convertRef(node.inner) }
        if (typeof node.meta?.min === 'number') out.minItems = node.meta.min
        if (typeof node.meta?.max === 'number') out.maxItems = node.meta.max
        return out
      }
      case 'dict': {
        if (node.inner === undefined) throw new Error('dict schema is missing its value schema')
        if (node.sKey !== undefined && nodeOf(node.sKey).type !== 'string') {
          throw new Error('dict schema keys must be strings')
        }
        return { type: 'object', additionalProperties: convertRef(node.inner) }
      }
      case 'object': {
        const properties: JsonSchema = {}
        const required: string[] = []
        for (const [key, ref] of Object.entries(node.dict ?? {})) {
          properties[key] = convertRef(ref)
          if (nodeOf(ref).meta?.required) required.push(key)
        }
        const out: JsonSchema = { type: 'object', properties }
        if (required.length > 0) out.required = required
        return out
      }
      case 'union': {
        const members = (node.list ?? []).map(convertRef)
        const enumMembers = members.every((member) => {
          const keys = Object.keys(member)
          return keys.length === 1 && keys[0] === 'const'
        })
        if (members.length > 0 && enumMembers) {
          return { enum: members.map((member) => member.const) }
        }
        return { anyOf: members }
      }
      default:
        throw new Error(`unsupported schema type "${node.type}"`)
    }
  }

  return convertRef(document.uid)
}
