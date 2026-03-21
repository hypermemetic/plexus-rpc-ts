import { randomUUID } from 'crypto'
import { createServer } from 'http'
import type { IncomingMessage } from 'http'
import { WebSocketServer } from 'ws'
import type { WebSocket, RawData } from 'ws'
import { Value } from '@sinclair/typebox/value'
import type { PluginDef } from './plugin'
import type { MethodDef } from './method'
import { schemaFor, schemaMap, hashOf } from './schema'
import type { PlexusStreamItem, StreamMetadata, PluginSchema } from './types'

export type { WebSocket } from 'ws'

// ── Public API types ──────────────────────────────────────────────────────────

export interface ServeOptions {
  port?: number
  hostname?: string
  /** Called for every incoming HTTP upgrade before plexus-rpc handles it.
   *  Receives the request pathname (e.g. '/bridge'). Call upgrade(tag) to accept;
   *  return true if handled, false to let the server handle it as a plexus-rpc client. */
  onUpgrade?: (pathname: string, upgrade: (tag: unknown) => boolean) => boolean
  /** Called when a custom-upgraded WebSocket opens. tag is whatever was passed to upgrade(). */
  onCustomOpen?: (ws: WebSocket, tag: unknown) => void
  /** Called when a custom WebSocket receives a message. */
  onCustomMessage?: (ws: WebSocket, raw: string | Buffer, tag: unknown) => void
  /** Called when a custom WebSocket closes. */
  onCustomClose?: (ws: WebSocket, tag: unknown) => void
}

export interface PlexusServer {
  readonly port: number
  readonly hostname: string
  stop(): void
}

// ── Wire serialization ────────────────────────────────────────────────────────
// TypeScript interfaces use camelCase internally; the wire format uses snake_case
// to match the Haskell/Rust deserialization. Only 'data' and 'error' items carry
// fields that differ (content_type, plexus_hash); others pass through as-is.

function toWireItem(item: PlexusStreamItem): unknown {
  if (item.type === 'request') return item  // no metadata field
  const meta = {
    provenance: item.metadata.provenance,
    plexus_hash: item.metadata.plexusHash,
    timestamp: item.metadata.timestamp,
  }
  if (item.type === 'data')
    return { type: 'data', metadata: meta, content_type: item.contentType, content: item.content }
  if (item.type === 'error')
    return { type: 'error', metadata: meta, message: item.message, recoverable: item.recoverable }
  if (item.type === 'progress')
    return { type: 'progress', metadata: meta, message: item.message, percentage: item.percentage }
  // done
  return { type: 'done', metadata: meta }
}

// ── serve() ───────────────────────────────────────────────────────────────────

export async function serve(
  name: string,
  options: ServeOptions,
  ...plugins: PluginDef[]
): Promise<PlexusServer> {
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
    return { provenance: [name], plexusHash: rootHash, timestamp: Math.floor(Date.now() / 1000) }
  }

  function sendNotif(ws: WebSocket, subId: number, item: PlexusStreamItem) {
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      method: 'subscription',
      params: { subscription: subId, result: toWireItem(item) },
    }))
  }

  function sendData(ws: WebSocket, subId: number, content: unknown, contentType = `${name}.result`) {
    sendNotif(ws, subId, { type: 'data', metadata: meta(), contentType, content })
  }

  function sendDone(ws: WebSocket, subId: number) {
    sendNotif(ws, subId, { type: 'done', metadata: meta() })
  }

  function sendError(ws: WebSocket, subId: number, message: string) {
    sendNotif(ws, subId, { type: 'error', metadata: meta(), message, recoverable: false })
    sendDone(ws, subId)
  }

  // ── Inner method dispatch ──────────────────────────────────────────────────

  async function handleInner(
    ws: WebSocket,
    subId: number,
    innerMethod: string,
    innerParams: unknown,
  ) {
    // Schema introspection: {ns}.schema
    // Synapse sends relative paths (e.g. "ui.schema"), schemas map uses full paths ("plexus-gamma.ui")
    if (innerMethod.endsWith('.schema')) {
      const ns = innerMethod.slice(0, -7)
      const schema = schemas.get(ns) ?? schemas.get(`${name}.${ns}`)
      if (schema) { sendData(ws, subId, schema, `${name}.schema`); sendDone(ws, subId); return }
      sendError(ws, subId, `Unknown namespace: ${ns}`); return
    }

    // Hash introspection: {ns}.hash
    if (innerMethod.endsWith('.hash')) {
      const ns = innerMethod.slice(0, -5)
      const schema = schemas.get(ns) ?? schemas.get(`${name}.${ns}`)
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
    // Synapse sends relative paths (e.g. "ui.navigate"), method map uses full paths ("plexus-gamma.ui.navigate")
    const methodDef = methods.get(innerMethod) ?? methods.get(`${name}.${innerMethod}`)
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

  // ── HTTP + WebSocket servers ────────────────────────────────────────────────

  let nextSubId = 1
  const clientSockets = new Map<string, WebSocket>()

  const httpServer = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(`${name} plexus-rpc server`)
  })

  const wss       = new WebSocketServer({ noServer: true })
  const customWss = new WebSocketServer({ noServer: true })

  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    const pathname = (req.url ?? '/').split('?')[0]!

    if (options.onUpgrade) {
      const handled = options.onUpgrade(pathname, (tag: unknown) => {
        customWss.handleUpgrade(req, socket as import('net').Socket, head, (ws) => {
          customWss.emit('connection', ws, req, tag)
        })
        return true
      })
      if (handled) return
    }

    wss.handleUpgrade(req, socket as import('net').Socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })

  wss.on('connection', (ws: WebSocket) => {
    const id = randomUUID()
    clientSockets.set(id, ws)
    console.log(`[plexus-rpc] ${name}: client connected`)

    ws.on('message', (raw: RawData) => {
      const text = typeof raw === 'string' ? raw : raw.toString()
      let msg: { jsonrpc: string; id: number; method: string; params?: unknown }
      try { msg = JSON.parse(text) } catch { return }

      // _info — subscription protocol (Haskell client uses substrateRpc for all calls)
      if (msg.method === '_info') {
        const subId = nextSubId++
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: subId }))
        void handleInner(ws, subId, '_info', {})
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
    })

    ws.on('close', () => {
      clientSockets.delete(id)
      console.log(`[plexus-rpc] ${name}: client disconnected`)
    })
  })

  customWss.on('connection', (ws: WebSocket, _req: IncomingMessage, tag: unknown) => {
    options.onCustomOpen?.(ws, tag)
    ws.on('message', (raw: RawData) => {
      options.onCustomMessage?.(ws, raw as string | Buffer, tag)
    })
    ws.on('close', () => {
      options.onCustomClose?.(ws, tag)
    })
  })

  // Wait for the server to start listening before returning
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(port, hostname, resolve)
  })

  const boundPort = (httpServer.address() as import('net').AddressInfo).port
  console.log(`[plexus-rpc] ${name} listening on :${boundPort}`)

  return {
    port: boundPort,
    hostname,
    stop() {
      wss.close()
      customWss.close()
      httpServer.close()
    },
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
