import { createHash } from 'crypto'
import type { PluginDef } from './plugin'
import type { PluginSchema, MethodSchema, ChildSummary } from './types'

// ── Stable JSON serialization (keys sorted at every level) ───────────────────

function stableStringify(val: unknown): string {
  if (val === null || typeof val !== 'object') return JSON.stringify(val)
  if (Array.isArray(val)) return '[' + val.map(stableStringify).join(',') + ']'
  const keys = Object.keys(val as object).sort()
  const pairs = keys.map(k => JSON.stringify(k) + ':' + stableStringify((val as Record<string, unknown>)[k]))
  return '{' + pairs.join(',') + '}'
}

// ── Hash (SHA-256 of stable JSON, first 16 hex chars) ────────────────────────

export function hashOf(obj: unknown): string {
  return createHash('sha256').update(stableStringify(obj), 'utf8').digest('hex').slice(0, 16)
}

// ── Schema generation ─────────────────────────────────────────────────────────

export function schemaFor(pluginDef: PluginDef, parentPath: string[] = []): PluginSchema {
  const namespaceParts = [...parentPath, pluginDef.name]
  const namespace = namespaceParts.join('.')

  const methods: MethodSchema[] = Object.entries(pluginDef.methods).map(([name, m]) => {
    const core = {
      name,
      description: m.description,
      streaming: m.streaming,
      bidirectional: false,
      params: m.params,
    }
    return { ...core, hash: hashOf(core) }
  })

  const isHub = pluginDef.children.length > 0

  const children: ChildSummary[] | undefined = isHub
    ? pluginDef.children.map(child => ({
        namespace: child.name,
        description: child.description,
        hash: schemaFor(child, namespaceParts).hash,
      }))
    : undefined

  const hashInput = {
    namespace,
    version: pluginDef.version,
    methods: [...methods].sort((a, b) => a.name.localeCompare(b.name)).map(m => ({
      name: m.name, description: m.description, streaming: m.streaming, bidirectional: m.bidirectional,
    })),
    children: children
      ? [...children].sort((a, b) => a.namespace.localeCompare(b.namespace)).map(c => ({ namespace: c.namespace, hash: c.hash }))
      : null,
  }

  return {
    namespace,
    version: pluginDef.version,
    description: pluginDef.description,
    ...(pluginDef.long_description ? { long_description: pluginDef.long_description } : {}),
    hash: hashOf(hashInput),
    methods,
    ...(children !== undefined ? { children } : {}),
  }
}

// ── Flat map of full namespace → PluginSchema ────────────────────────────────

export function schemaMap(
  pluginDef: PluginDef,
  parentPath: string[] = [],
  out: Map<string, PluginSchema> = new Map(),
): Map<string, PluginSchema> {
  const schema = schemaFor(pluginDef, parentPath)
  out.set(schema.namespace, schema)
  const namespaceParts = [...parentPath, pluginDef.name]
  for (const child of pluginDef.children) {
    schemaMap(child, namespaceParts, out)
  }
  return out
}
