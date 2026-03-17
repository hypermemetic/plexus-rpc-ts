import { test, expect, describe } from 'bun:test'
import { method } from '../method'
import { Type } from '@sinclair/typebox'

describe('method()', () => {
  test('returns _type: method', () => {
    const m = method({ description: 'test', params: Type.Object({}), run: () => ({}) })
    expect(m._type).toBe('method')
  })

  test('preserves description', () => {
    const m = method({ description: 'hello world', params: Type.Object({}), run: () => ({}) })
    expect(m.description).toBe('hello world')
  })

  test('preserves params schema', () => {
    const params = Type.Object({ x: Type.String() })
    const m = method({ description: 'x', params, run: (p) => p.x })
    expect(m.params).toBe(params)
  })

  test('streaming defaults to false', () => {
    const m = method({ description: 'x', params: Type.Object({}), run: () => ({}) })
    expect(m.streaming).toBe(false)
  })

  test('streaming can be set to true', () => {
    const m = method({ description: 'x', params: Type.Object({}), streaming: true, run: async function*() { yield 1 } })
    expect(m.streaming).toBe(true)
  })
})
