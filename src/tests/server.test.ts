import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { serve } from '../server'
import { plugin } from '../plugin'
import { method } from '../method'
import { Type } from '@sinclair/typebox'
import type { PlexusServer } from '../server'

// ── Test plugin ───────────────────────────────────────────────────────────────

const testPlugin = plugin('echo', {
  version: '1.0.0',
  description: 'Test echo plugin',
  methods: {
    ping: method({
      description: 'Ping',
      params: Type.Object({}),
      run: () => ({ pong: true }),
    }),
    echo: method({
      description: 'Echo',
      params: Type.Object({
        message: Type.String(),
        count:   Type.Optional(Type.Integer({ default: 1 })),
      }),
      run: ({ message, count = 1 }) => ({ message: message.repeat(count) }),
    }),
    stream: method({
      description: 'Stream',
      streaming: true,
      params: Type.Object({ count: Type.Integer() }),
      async *run({ count }) {
        for (let i = 0; i < count; i++) yield { n: i }
      },
    }),
    boom: method({
      description: 'Throws',
      params: Type.Object({}),
      run: () => { throw new Error('intentional error') },
    }),
  },
})

// ── Helpers ───────────────────────────────────────────────────────────────────

let srv: PlexusServer

beforeAll(async () => {
  srv = await serve('echo', { port: 47001 }, testPlugin)
})

afterAll(() => {
  srv.stop()
})

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:47001')
    ws.onopen  = () => resolve(ws)
    ws.onerror = (e) => reject(new Error('WebSocket error'))
  })
}

/** Send a JSON-RPC request, wait for the matching id response. */
function sendRpc(
  ws: WebSocket,
  id: number,
  method: string,
  params: unknown,
): Promise<{ result?: unknown; error?: unknown }> {
  return new Promise((resolve) => {
    const handler = (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string)
      if (msg.id === id) {
        ws.removeEventListener('message', handler)
        resolve(msg)
      }
    }
    ws.addEventListener('message', handler)
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
}

/** Collect all subscription notifications for subId until done/error. */
function collectStream(
  ws: WebSocket,
  subId: number,
): Promise<{ items: unknown[]; error?: string }> {
  return new Promise((resolve) => {
    const items: unknown[] = []
    const handler = (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string)
      if (msg.method !== 'subscription') return
      const { subscription, result } = msg.params as { subscription: number; result: { type: string; content?: unknown; message?: string } }
      if (subscription !== subId) return
      if (result.type === 'data') {
        items.push(result.content)
      } else if (result.type === 'done') {
        ws.removeEventListener('message', handler)
        resolve({ items })
      } else if (result.type === 'error') {
        ws.removeEventListener('message', handler)
        resolve({ items, error: result.message })
      }
    }
    ws.addEventListener('message', handler)
  })
}

/** Call an inner method via echo.call. Returns { subId, stream }. */
async function call(
  ws: WebSocket,
  rpcId: number,
  innerMethod: string,
  innerParams: unknown,
) {
  const streamPromise = new Promise<{ items: unknown[]; error?: string }>((outerResolve) => {
    // We need the subId from the ACK before we can subscribe — set up a one-time subId listener
    let subId: number | null = null
    const items: unknown[] = []
    let resolved = false

    const handler = (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string)

      // ACK
      if (msg.id === rpcId && msg.result !== undefined) {
        subId = msg.result as number
        return
      }

      // Subscription notifications
      if (msg.method === 'subscription' && subId !== null && msg.params.subscription === subId) {
        const result = msg.params.result as { type: string; content?: unknown; message?: string }
        if (result.type === 'data') {
          items.push(result.content)
        } else if (result.type === 'done' && !resolved) {
          resolved = true
          ws.removeEventListener('message', handler)
          outerResolve({ items })
        } else if (result.type === 'error' && !resolved) {
          resolved = true
          ws.removeEventListener('message', handler)
          outerResolve({ items, error: result.message })
        }
      }
    }
    ws.addEventListener('message', handler)
  })

  ws.send(JSON.stringify({
    jsonrpc: '2.0', id: rpcId,
    method: 'echo.call',
    params: { method: innerMethod, params: innerParams },
  }))

  return streamPromise
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('server', () => {
  test('_info via echo.call returns backend name', async () => {
    const ws = await connect()
    const { items } = await call(ws, 1, '_info', {})
    expect(items.length).toBe(1)
    expect((items[0] as { backend: string }).backend).toBe('echo')
    ws.close()
  })

  test('_info direct (Haskell protocol) uses subscription and returns backend name', async () => {
    const ws = await connect()
    // Haskell client sends { method: '_info' } directly, expects subscription ACK + stream items
    const { items } = await new Promise<{ items: unknown[] }>((resolve) => {
      let subId: number | null = null
      const items: unknown[] = []
      const handler = (e: MessageEvent) => {
        const msg = JSON.parse(e.data as string)
        if (msg.id === 99 && msg.result !== undefined && typeof msg.result === 'number') {
          subId = msg.result as number
          return
        }
        if (msg.method === 'subscription' && subId !== null && msg.params.subscription === subId) {
          const result = msg.params.result as { type: string; content?: unknown }
          if (result.type === 'data') items.push(result.content)
          if (result.type === 'done') { ws.removeEventListener('message', handler); resolve({ items }) }
        }
      }
      ws.addEventListener('message', handler)
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 99, method: '_info', params: null }))
    })
    expect(items.length).toBe(1)
    expect((items[0] as { backend: string }).backend).toBe('echo')
    ws.close()
  })

  test('schema introspection', async () => {
    const ws = await connect()
    const { items } = await call(ws, 1, 'echo.schema', {})
    expect(items.length).toBe(1)
    expect((items[0] as { namespace: string }).namespace).toBe('echo')
    ws.close()
  })

  test('hash introspection', async () => {
    const ws = await connect()
    const { items } = await call(ws, 1, 'echo.hash', {})
    expect(items.length).toBe(1)
    expect((items[0] as { event: string; value: string }).event).toBe('hash')
    expect((items[0] as { value: string }).value).toMatch(/^[0-9a-f]{16}$/)
    ws.close()
  })

  test('unary method — ping', async () => {
    const ws = await connect()
    const { items } = await call(ws, 1, 'echo.ping', {})
    expect(items).toEqual([{ pong: true }])
    ws.close()
  })

  test('unary method with params — echo', async () => {
    const ws = await connect()
    const { items } = await call(ws, 1, 'echo.echo', { message: 'hi', count: 3 })
    expect(items).toEqual([{ message: 'hihihi' }])
    ws.close()
  })

  test('streaming method', async () => {
    const ws = await connect()
    const { items } = await call(ws, 1, 'echo.stream', { count: 3 })
    expect(items).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }])
    ws.close()
  })

  test('wire format — data items use snake_case keys', async () => {
    const ws = await connect()

    // Capture the first raw subscription notification
    const rawResult = await new Promise<Record<string, unknown>>((resolve) => {
      let subId: number | null = null
      const handler = (e: MessageEvent) => {
        const msg = JSON.parse(e.data as string)
        if (msg.id === 1 && msg.result !== undefined) {
          subId = msg.result as number
          return
        }
        if (msg.method === 'subscription' && subId !== null && msg.params.subscription === subId) {
          const result = msg.params.result as Record<string, unknown>
          if (result['type'] === 'data') {
            ws.removeEventListener('message', handler)
            resolve(result)
          }
        }
      }
      ws.addEventListener('message', handler)
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'echo.call', params: { method: 'echo.ping', params: {} } }))
    })

    expect(typeof rawResult['content_type']).toBe('string')
    expect((rawResult['content_type'] as string).length).toBeGreaterThan(0)
    expect(rawResult['contentType']).toBeUndefined()

    const meta = rawResult['metadata'] as Record<string, unknown>
    expect(typeof meta['plexus_hash']).toBe('string')
    expect((meta['plexus_hash'] as string).length).toBeGreaterThan(0)
    expect(meta['plexusHash']).toBeUndefined()

    ws.close()
  })

  test('param validation — missing required param', async () => {
    const ws = await connect()
    const { error } = await call(ws, 1, 'echo.echo', {})
    expect(error).toBeTruthy()
    ws.close()
  })

  test('unknown method returns error stream', async () => {
    const ws = await connect()
    const { error } = await call(ws, 1, 'echo.doesNotExist', {})
    expect(error).toContain('not found')
    ws.close()
  })

  test('method that throws returns error stream', async () => {
    const ws = await connect()
    const { error } = await call(ws, 1, 'echo.boom', {})
    expect(error).toContain('intentional error')
    ws.close()
  })

  test('concurrent calls complete independently', async () => {
    const ws = await connect()

    // Fire 3 calls without awaiting
    const p1 = call(ws, 1, 'echo.stream', { count: 3 })
    const p2 = call(ws, 2, 'echo.ping', {})
    const p3 = call(ws, 3, 'echo.echo', { message: 'x', count: 2 })

    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    expect(r1.items).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }])
    expect(r2.items).toEqual([{ pong: true }])
    expect(r3.items).toEqual([{ message: 'xx' }])
    ws.close()
  })
})
