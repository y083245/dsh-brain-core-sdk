import assert from 'node:assert/strict'
import test from 'node:test'
import { PLAIN_PERMISSIONS, hostAllowed, parsePermission } from '../src/plugin.ts'
import { BrainError } from '../src/types.ts'

function invalidArgument(run: () => unknown): BrainError {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof BrainError, `expected BrainError, got ${String(error)}`)
    assert.equal(error.code, 'INVALID_ARGUMENT')
    assert.equal(error.details.field, 'permissions')
    return error
  }
  assert.fail('expected parsePermission to throw')
}

test('every plain permission parses to its own name', () => {
  assert.equal(PLAIN_PERMISSIONS.length, 14)
  for (const name of PLAIN_PERMISSIONS) {
    assert.deepEqual(parsePermission(name), { kind: 'plain', name })
  }
})

test('network:config:<key> parses with a config key', () => {
  assert.deepEqual(parsePermission('network:config:rssUrl'), { kind: 'network-config', key: 'rssUrl' })
  assert.deepEqual(parsePermission('network:config:a'), { kind: 'network-config', key: 'a' })
  assert.deepEqual(parsePermission(`network:config:${'a'.repeat(64)}`), {
    kind: 'network-config',
    key: 'a'.repeat(64),
  })
  assert.deepEqual(parsePermission('network:config:home_assistant.url'), {
    kind: 'network-config',
    key: 'home_assistant.url',
  })
})

test('network:config rejects bad keys', () => {
  for (const text of [
    'network:config:',
    'network:config:1abc',
    'network:config:_abc',
    'network:config:a b',
    `network:config:${'a'.repeat(65)}`,
    'network:config:key/part',
  ]) {
    invalidArgument(() => parsePermission(text))
  }
})

test('network:<host> parses public hosts and one leading wildcard', () => {
  assert.deepEqual(parsePermission('network:api.bilibili.com'), { kind: 'network', host: 'api.bilibili.com' })
  assert.deepEqual(parsePermission('network:example.com'), { kind: 'network', host: 'example.com' })
  assert.deepEqual(parsePermission('network:*.a.com'), { kind: 'network', host: '*.a.com' })
  assert.deepEqual(parsePermission('network:127.0.0.1'), { kind: 'network', host: '127.0.0.1' })
  assert.deepEqual(parsePermission('network:a-b.example.co'), { kind: 'network', host: 'a-b.example.co' })
})

test('network rejects upper case, empty and malformed hosts', () => {
  for (const text of [
    'network:A.com',
    'network:example.COM',
    'network:',
    'network:*',
    'network:*.',
    'network:*.*.a.com',
    'network:a..com',
    'network:.a.com',
    'network:a.com.',
    'network:-a.com',
    'network:a b.com',
    'network:a.com:443',
  ]) {
    invalidArgument(() => parsePermission(text))
  }
})

test('lan:config:<key> parses with a config key', () => {
  assert.deepEqual(parsePermission('lan:config:home'), { kind: 'lan-config', key: 'home' })
  assert.deepEqual(parsePermission('lan:config:comfyui.url'), { kind: 'lan-config', key: 'comfyui.url' })
  invalidArgument(() => parsePermission('lan:config:'))
  invalidArgument(() => parsePermission('lan:config:9home'))
})

test('lan:<host> parses a private host, IPv4 or bracketed IPv6', () => {
  assert.deepEqual(parsePermission('lan:192.168.1.5'), { kind: 'lan', host: '192.168.1.5' })
  assert.deepEqual(parsePermission('lan:home.local'), { kind: 'lan', host: 'home.local' })
  assert.deepEqual(parsePermission('lan:[::1]'), { kind: 'lan', host: '[::1]' })
  assert.deepEqual(parsePermission('lan:[fd00::1]'), { kind: 'lan', host: '[fd00::1]' })
  assert.deepEqual(parsePermission('lan:[2001:db8::1]'), { kind: 'lan', host: '[2001:db8::1]' })
})

test('lan rejects wildcards, unbracketed IPv6 and bad hosts', () => {
  for (const text of [
    'lan:*.a.com',
    'lan:*.example.com',
    'lan:',
    'lan:8080',
    'lan:::1',
    'lan:2001:db8::1',
    'lan:[:::]',
    'lan:[]',
    'lan:A.com',
    'lan:a b',
    'lan:a.com:443',
  ]) {
    invalidArgument(() => parsePermission(text))
  }
})

test('secrets:<name> parses lower-case names', () => {
  assert.deepEqual(parsePermission('secrets:qq-token'), { kind: 'secret', name: 'qq-token' })
  assert.deepEqual(parsePermission('secrets:a'), { kind: 'secret', name: 'a' })
  assert.deepEqual(parsePermission(`secrets:${'a'.repeat(24)}`), { kind: 'secret', name: 'a'.repeat(24) })
})

test('secrets rejects malformed names', () => {
  for (const text of [
    'secrets:',
    'secrets:Qq',
    'secrets:1qq',
    'secrets:-qq',
    `secrets:${'a'.repeat(25)}`,
    'secrets:qq token',
    'secrets:qq/token',
  ]) {
    invalidArgument(() => parsePermission(text))
  }
})

test('unknown permissions are rejected as INVALID_ARGUMENT', () => {
  for (const text of ['', 'memory.eat', 'Memory.ingest', 'network', 'lan', 'secrets', ' channels']) {
    invalidArgument(() => parsePermission(text))
  }
})

test('hostAllowed compares exact hosts and wildcard subdomains only', () => {
  assert.equal(hostAllowed('example.com', 'example.com'), true)
  assert.equal(hostAllowed('example.com', 'a.example.com'), false)
  assert.equal(hostAllowed('*.example.com', 'a.example.com'), true)
  assert.equal(hostAllowed('*.example.com', 'b.a.example.com'), true)
  assert.equal(hostAllowed('*.example.com', 'example.com'), false)
  assert.equal(hostAllowed('*.example.com', 'evilexample.com'), false)
  assert.equal(hostAllowed('*.example.com', 'notexample.com'), false)
  assert.equal(hostAllowed('api.example.com', 'api.example.com'), true)
  assert.equal(hostAllowed('api.example.com', 'other.example.com'), false)
})

test('network:config and lan:config without a key are rejected, but hosts that only start with config pass', () => {
  invalidArgument(() => parsePermission('network:config'))
  invalidArgument(() => parsePermission('lan:config'))
  assert.deepEqual(parsePermission('network:config.example.com'), { kind: 'network', host: 'config.example.com' })
  assert.deepEqual(parsePermission('lan:config-server'), { kind: 'lan', host: 'config-server' })
})

test('a network wildcard needs a domain of at least two labels that is not an IPv4 address', () => {
  assert.deepEqual(parsePermission('network:*.example.com'), { kind: 'network', host: '*.example.com' })
  assert.deepEqual(parsePermission('network:*.a.example.com'), { kind: 'network', host: '*.a.example.com' })
  for (const text of ['network:*.com', 'network:*.localhost', 'network:*.1.2.3.4']) {
    invalidArgument(() => parsePermission(text))
  }
})

test('lan IPv6 literals need exactly eight groups, or one :: that leaves room', () => {
  assert.deepEqual(parsePermission('lan:[1:2:3:4:5:6:7:8]'), { kind: 'lan', host: '[1:2:3:4:5:6:7:8]' })
  assert.deepEqual(parsePermission('lan:[1::7]'), { kind: 'lan', host: '[1::7]' })
  for (const text of [
    'lan:[1:2:3:4:5:6:7:8::9]',
    'lan:[1:2:3]',
    'lan:[1::2::3]',
  ]) {
    invalidArgument(() => parsePermission(text))
  }
})
