import type { TObject, Static } from '@sinclair/typebox'

export type MethodRun<P extends TObject, R> =
  | ((params: Static<P>) => R)
  | ((params: Static<P>) => Promise<R>)
  | ((params: Static<P>) => AsyncGenerator<R, void, unknown>)

export interface MethodDef<P extends TObject = TObject, R = unknown> {
  readonly _type: 'method'
  readonly description: string
  readonly long_description?: string
  readonly params: P
  readonly run: MethodRun<P, R>
  readonly streaming: boolean
}

export function method<P extends TObject, R>(def: {
  description: string
  long_description?: string
  params: P
  streaming?: boolean
  run: ((params: Static<P>) => R) | ((params: Static<P>) => AsyncGenerator<R, void, unknown>)
}): MethodDef<P, Awaited<R>> {
  return {
    _type: 'method',
    description: def.description,
    long_description: def.long_description,
    params: def.params,
    run: def.run as MethodRun<P, Awaited<R>>,
    streaming: def.streaming ?? false,
  }
}
