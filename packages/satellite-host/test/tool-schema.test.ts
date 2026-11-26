import assert from 'node:assert/strict'
import test from 'node:test'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { toDshParameters } from '../src/index.ts'

test('an object root keeps scalars and marks required properties', () => {
  assert.deepEqual(toDshParameters({
    type: 'object',
    properties: { name: { type: 'string' }, age: { type: 'number', description: 'years' } },
    required: ['name'],
  }), {
    name: { type: 'string', required: true },
    age: { type: 'number', description: 'years' },
  })
})

test('nested objects keep their openness and their own required list', () => {
  assert.deepEqual(toDshParameters({
    type: 'object',
    properties: {
      outer: {
        type: 'object',
        properties: { inner: { type: 'boolean' } },
        required: ['inner'],
      },
      closed: { type: 'object', properties: {}, additionalProperties: false },
    },
  }), {
    outer: { type: 'object', properties: { inner: { type: 'boolean', required: true } }, additionalProperties: true },
    closed: { type: 'object', properties: {}, additionalProperties: false },
  })
})

test('arrays keep their items and scalars keep enum and const', () => {
  assert.deepEqual(toDshParameters({
    type: 'object',
    properties: {
      tags: { type: 'array', items: { type: 'string' } },
      anything: { type: 'array' },
      colour: { type: 'string', enum: ['red', 'blue'] },
      fixed: { type: 'integer', const: 3 },
      nullable: { type: 'null' },
    },
  }), {
    tags: { type: 'array', items: { type: 'string' } },
    anything: { type: 'array' },
    colour: { type: 'string', enum: ['red', 'blue'] },
    fixed: { type: 'integer', const: 3 },
    nullable: { type: 'null' },
  })
})

test('oneOf becomes a union of converted nodes', () => {
  assert.deepEqual(toDshParameters({
    type: 'object',
    properties: {
      value: {
        oneOf: [{ type: 'string' }, { type: 'object', properties: { n: { type: 'number' } }, additionalProperties: false }],
      },
      tooShort: { oneOf: [{ type: 'string' }] },
    },
  }), {
    value: {
      oneOf: [
        { type: 'string' },
        { type: 'object', properties: { n: { type: 'number' } }, additionalProperties: false },
      ],
    },
    tooShort: { type: 'json' },
  })
})

test('annotations survive but unsupported validation keywords are dropped', () => {
  assert.deepEqual(toDshParameters({
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'a code',
        title: 'Code',
        default: 'abc',
        examples: ['abc', 'def'],
        format: 'email',
        pattern: '^[a-z]+$',
        minLength: 1,
      },
      count: { type: 'integer', minimum: 0, maximum: 10 },
    },
  }), {
    code: {
      type: 'string',
      description: 'a code',
      title: 'Code',
      default: 'abc',
      examples: ['abc', 'def'],
    },
    count: { type: 'integer' },
  })
})

test('nodes without a single supported type become json', () => {
  for (const schema of [
    { type: ['string', 'null'] },
    { anyOf: [{ type: 'string' }, { type: 'number' }] },
    { $ref: '#/definitions/x' },
    { minimum: 1 },
    { type: 'unknown' },
  ]) {
    assert.deepEqual(toDshParameters({ type: 'object', properties: { value: schema } }).value, { type: 'json' })
  }
})

test('a non-object root throws RangeError', () => {
  assert.throws(() => toDshParameters({ type: 'string' }), RangeError)
  assert.throws(() => toDshParameters({ type: 'array', items: { type: 'string' } }), RangeError)
  assert.throws(() => toDshParameters({}), RangeError)
})

test('real defineTool accepts the converted parameters', () => {
  const parameters = toDshParameters({
    type: 'object',
    required: ['text'],
    properties: {
      text: { type: 'string', description: 'what to say' },
      options: {
        type: 'object',
        properties: {
          loud: { type: 'boolean' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
      either: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
    },
  })
  assert.doesNotThrow(() => defineTool({
    name: 'demo__echo',
    description: 'Echo a string.',
    parameters: parameters as never,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async () => 'ok',
  }))
})
