import type { MethodDef } from './method'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface PluginDef {
  readonly _type: 'plugin'
  readonly name: string        // single dot-segment, e.g. 'echo', 'solar'
  readonly version: string
  readonly description: string
  readonly long_description?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly methods: Record<string, MethodDef<any, any>>
  readonly children: PluginDef[]
}

export function plugin(
  name: string,
  def: {
    version: string
    description: string
    long_description?: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    methods?: Record<string, MethodDef<any, any>>
    children?: PluginDef[]
  },
): PluginDef {
  return {
    _type: 'plugin',
    name,
    version: def.version,
    description: def.description,
    long_description: def.long_description,
    methods: def.methods ?? {},
    children: def.children ?? [],
  }
}
