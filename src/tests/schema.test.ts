import { test, expect, describe } from 'bun:test'
import { hashOf, schemaFor, schemaMap } from '../schema'
import { plugin } from '../plugin'
import { method } from '../method'
import { Type } from '@sinclair/typebox'

describe('hashOf()', () => {
  test('returns 16-char lowercase hex string', () => {
    const h = hashOf({})
    expect(h).toMatch(/^[0-9a-f]{16}$/)
  })

  test('is stable — same input gives same output', () => {
    expect(hashOf({ a: 1, b: 'x' })).toBe(hashOf({ a: 1, b: 'x' }))
  })

  test('is key-order independent', () => {
    expect(hashOf({ a: 1, b: 2 })).toBe(hashOf({ b: 2, a: 1 }))
  })

  test('changes when content changes', () => {
    expect(hashOf({ a: 1 })).not.toBe(hashOf({ a: 2 }))
  })
})

describe('schemaFor()', () => {
  const leafPlugin = plugin('echo', {
    version: '1.0.0',
    description: 'Echo',
    methods: {
      ping: method({ description: 'Ping', params: Type.Object({}), run: () => ({ pong: true }) }),
    },
  })

  const hubPlugin = plugin('solar', {
    version: '1.0.0',
    description: 'Solar',
    children: [
      plugin('earth', { version: '1.0.0', description: 'Earth', methods: {
        info: method({ description: 'Info', params: Type.Object({}), run: () => ({}) }),
      }}),
    ],
  })

  test('leaf plugin has children: undefined', () => {
    const s = schemaFor(leafPlugin)
    expect(s.children).toBeUndefined()
  })

  test('hub plugin has children array', () => {
    const s = schemaFor(hubPlugin)
    expect(Array.isArray(s.children)).toBe(true)
    expect(s.children!.length).toBe(1)
  })

  test('namespace is full dot path', () => {
    const s = schemaFor(hubPlugin)
    expect(s.namespace).toBe('solar')
    const child = schemaFor(hubPlugin.children[0]!, ['solar'])
    expect(child.namespace).toBe('solar.earth')
  })

  test('child summary uses single segment as namespace', () => {
    const s = schemaFor(hubPlugin)
    expect(s.children![0]!.namespace).toBe('earth')
  })

  test('hash is 16 hex chars', () => {
    const s = schemaFor(leafPlugin)
    expect(s.hash).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('schemaMap()', () => {
  const tree = plugin('root', {
    version: '1.0.0',
    description: 'Root',
    children: [
      plugin('alpha', { version: '1.0.0', description: 'Alpha', methods: {
        go: method({ description: 'Go', params: Type.Object({}), run: () => ({}) }),
      }}),
    ],
  })

  test('contains root and all descendants', () => {
    const m = schemaMap(tree)
    expect(m.has('root')).toBe(true)
    expect(m.has('root.alpha')).toBe(true)
  })

  test('namespaces are full paths', () => {
    const m = schemaMap(tree)
    expect(m.get('root.alpha')!.namespace).toBe('root.alpha')
  })
})
