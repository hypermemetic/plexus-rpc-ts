import { randomUUID } from 'crypto'
import { Value } from '@sinclair/typebox/value'
import type { PluginDef } from './plugin'
import type { MethodDef } from './method'
import { schemaFor, schemaMap, hashOf } from './schema'
import type { PlexusStreamItem, StreamMetadata, PluginSchema } from './types'

// ── Public API types ──────────────────────────────────────────────────────────

export interface ServeOptions {
  port?: number
  hostname?: string
  /** Called for every incoming HTTP upgrade before plexus-rpc handles it.
   *  Call upgrade(tag) to accept; return true if handled, false to let the server handle it. */
  onUpgrade?: (req: Request, upgrade: (tag: unknown) => boolean) => boolean
  /** Called when a custom-upgraded WebSocket opens. tag is whatever was passed to upgrade(). */
  onCustomOpen?: (ws: import('bun').ServerWebSocket<unknown>, tag: unknown) => void
  /** Called when a custom WebSocket receives a message. */
  onCustomMessage?: (ws: import('bun').ServerWebSocket<unknown>, raw: string | Buffer, tag: unknown) => void
  /** Called when a custom WebSocket closes. */
  onCustomClose?: (ws: import('bun').ServerWebSocket<unknown>, tag: unknown) => void
}

export interface PlexusServer {
  readonly port: number
  readonly hostname: string
  stop(): void
}

// ── Internal types ────────────────────────────────────────────────────────────

type WsData = { role: 'client'; id: string } | { role: 'custom'; tag: unknown }

// ── serve() ───────────────────────────────────────────────────────────────────

export function serve(
  name: string,
  options: ServeOptions,
  ...plugins: PluginDef[]
): PlexusServer {
  const port     = options.port     ?? 4444
  const hostname = options.hostname ?? '0.0.0.0'

  // Build root plugin: if one plugin passed with matching name, use it directly;
  // otherwise create a synthetic root with all plugins as children.
  let rootPlugin: PluginDef
  if (plugins.length === 1 && plugins[0]!.name === name) {
    rootPlugin = plugins[0]!
  } else {
    rootPlugin = {
      _type: 'plugin',
      name,
      version: '0.1.0',
      description: `${name} plexus-rpc server`,
      methods: {},
      children: plugins,
    }
  }

  // Pre-build flat maps
  const schemas  = schemaMap(rootPlugin)
  const methods  = buildMethodMap(rootPlugin, [])
  const rootHash = schemas.get(name)!.hash

  // ── Helpers ────────────────────────────────────────────────────────────────

  function meta(): StreamMetadata {
    return { provenance: [name], plexusHash: rootHash, timestamp: Date.now() / 1000 }
  }

  function sendNotif(ws: import('bun').ServerWebSocket<WsData>, subId: number, item: PlexusStreamItem) {
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      method: 'subscription',
      params: { subscription: subId, result: item },
    }))
  }

  function sendData(ws: import('bun').ServerWebSocket<WsData>, subId: number, content: unknown, contentType = `${name}.result`) {
    sendNotif(ws, subId, { type: 'data', metadata: meta(), contentType, content })
  }

  function sendDone(ws: import('bun').ServerWebSocket<WsData>, subId: number) {
    sendNotif(ws, subId, { type: 'done', metadata: meta() })
  }

  function sendError(ws: import('bun').ServerWebSocket<WsData>, subId: number, message: string) {
    sendNotif(ws, subId, { type: 'error', metadata: meta(), message, recoverable: false })
    sendDone(ws, subId)
  }

  // ── Inner method dispatch ──────────────────────────────────────────────────

  async function handleInner(
    ws: import('bun').ServerWebSocket<WsData>,
    subId: number,
    innerMethod: string,
    innerParams: unknown,
  ) {
    // Schema introspection: {ns}.schema
    if (innerMethod.endsWith('.schema')) {
      const ns = innerMethod.slice(0, -7)
      const schema = schemas.get(ns)
      if (schema) { sendData(ws, subId, schema, `${name}.schema`); sendDone(ws, subId); return }
      sendError(ws, subId, `Unknown namespace: ${ns}`); return
    }

    // Hash introspection: {ns}.hash
    if (innerMethod.endsWith('.hash')) {
      const ns = innerMethod.slice(0, -5)
      const schema = schemas.get(ns)
      if (schema) { sendData(ws, subId, { event: 'hash', value: schema.hash }, `${name}.hash`); sendDone(ws, subId); return }
      sendError(ws, subId, `Unknown namespace: ${ns}`); return
    }

    // _info
    if (innerMethod === '_info') {
      const rootSchema = schemas.get(name)
      sendData(ws, subId, { backend: name, version: rootSchema?.version ?? '0.1.0' })
      sendDone(ws, subId)
      return
    }

    // Method call
    const methodDef = methods.get(innerMethod)
    if (!methodDef) { sendError(ws, subId, `Method not found: ${innerMethod}`); return }

    // Apply TypeBox defaults then validate
    const params = Value.Default(methodDef.params, typeof innerParams === 'object' && innerParams !== null ? { ...innerParams as object } : {})
    if (!Value.Check(methodDef.params, params)) {
      const errors = [...Value.Errors(methodDef.params, params)]
      sendError(ws, subId, `Invalid params: ${errors.map(e => `${e.path}: ${e.message}`).join('; ')}`)
      return
    }

    try {
      const result = (methodDef.run as (p: unknown) => unknown)(params)

      // Async generator (streaming)
      if (result !== null && typeof result === 'object' && Symbol.asyncIterator in (result as object)) {
        for await (const item of result as AsyncIterable<unknown>) {
          sendData(ws, subId, item)
        }
        sendDone(ws, subId)
        return
      }

      // Promise
      if (result !== null && typeof result === 'object' && 'then' in (result as object)) {
        const resolved = await (result as Promise<unknown>)
        sendData(ws, subId, resolved)
        sendDone(ws, subId)
        return
      }

      // Plain value
      sendData(ws, subId, result)
      sendDone(ws, subId)
    } catch (err) {
      sendError(ws, subId, err instanceof Error ? err.message : String(err))
    }
  }

  // ── Bun server ─────────────────────────────────────────────────────────────

  let nextSubId = 1
  const clientSockets = new Map<string, import('bun').ServerWebSocket<WsData>>()

  const bunServer = Bun.serve<WsData>({
    port,
    hostname,

    fetch(req, srv) {
      // Custom upgrade hook (e.g. for bridge connections)
      if (options.onUpgrade) {
        const handled = options.onUpgrade(req, (data) => srv.upgrade(req, { data: { role: 'custom', tag: data } }))
        if (handled) return undefined
      }
      // Default: upgrade every WebSocket connection as a client
      const id = randomUUID()
      const ok = srv.upgrade(req, { data: { role: 'client', id } as WsData })
      if (ok) return undefined
      return new Response(`${name} plexus-rpc server`, { status: 200 })
    },

    websocket: {
      open(ws) {
        const d = ws.data
        if (d.role === 'custom') {
          options.onCustomOpen?.(ws as import('bun').ServerWebSocket<unknown>, d.tag)
          return
        }
        if (d.role === 'client') {
          clientSockets.set(d.id, ws)
          console.log(`[plexus-rpc] ${name}: client connected`)
        }
      },

      message(ws, raw) {
        const d = ws.data
        if (d.role === 'custom') {
          options.onCustomMessage?.(ws as import('bun').ServerWebSocket<unknown>, raw, d.tag)
          return
        }

        const text = typeof raw === 'string' ? raw : raw.toString()
        let msg: { jsonrpc: string; id: number; method: string; params?: unknown }
        try { msg = JSON.parse(text) } catch { return }

        if (d.role !== 'client') return

        // Direct _info (no subscription)
        if (msg.method === '_info') {
          const rootSchema = schemas.get(name)
          ws.send(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: { backend: name, version: rootSchema?.version ?? '0.1.0' },
          }))
          return
        }

        // {name}.call — subscription pattern
        if (msg.method === `${name}.call`) {
          const p = msg.params as { method: string; params?: unknown }
          const subId = nextSubId++
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: subId }))
          void handleInner(ws, subId, p.method, p.params ?? {})
          return
        }

        // Unknown
        ws.send(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          error: { code: -32601, message: 'Method not found' },
        }))
      },

      close(ws) {
        const d = ws.data
        if (d.role === 'custom') {
          options.onCustomClose?.(ws as import('bun').ServerWebSocket<unknown>, d.tag)
          return
        }
        if (d.role === 'client') {
          clientSockets.delete(d.id)
          console.log(`[plexus-rpc] ${name}: client disconnected`)
        }
      },
    },
  })

  console.log(`[plexus-rpc] ${name} listening on :${bunServer.port}`)

  return {
    port: bunServer.port as number,
    hostname,
    stop() { bunServer.stop() },
  }
}

// ── Build flat method map: 'ns.method' → MethodDef ───────────────────────────

function buildMethodMap(
  pluginDef: PluginDef,
  parentPath: string[],
  out: Map<string, MethodDef> = new Map(),
): Map<string, MethodDef> {
  const prefix = [...parentPath, pluginDef.name].join('.')
  for (const [methodName, methodDef] of Object.entries(pluginDef.methods)) {
    out.set(`${prefix}.${methodName}`, methodDef)
  }
  const childPath = [...parentPath, pluginDef.name]
  for (const child of pluginDef.children) {
    buildMethodMap(child, childPath, out)
  }
  return out
}
