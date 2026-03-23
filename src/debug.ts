/**
 * Debug endpoints for Plexus RPC protocol validation
 *
 * Enabled by setting PLEXUS_DEBUG=true environment variable
 *
 * Endpoints:
 * - _debug.protocol_test - Tests all message types (data, progress, done)
 * - _debug.stream_test - Controlled streaming scenarios
 * - _debug.error_test - Intentional error scenarios
 * - _debug.metadata_test - Metadata edge cases
 */

import { Type } from '@sinclair/typebox'
import { plugin } from './plugin'
import { method } from './method'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Protocol test endpoint - sends all message types correctly
 */
const protocolTest = method({
  name: 'protocol_test',
  description: 'Tests basic protocol compliance - sends data, progress, and StreamDone',
  params: Type.Object({}),
  returns: Type.Object({}),
  run: async function* () {
    // Send data
    yield { message: 'First data item' }

    // Send progress (note: progress is sent via special type - for now just send data)
    // TODO: plexus-rpc-ts needs to support explicit progress items

    // Send more data
    yield { message: 'Second data item' }

    // StreamDone will be sent automatically when generator completes
    return { status: 'complete' }
  }
})

/**
 * Stream test endpoint - controlled scenarios
 */
const streamTest = method({
  name: 'stream_test',
  description: 'Tests streaming scenarios: slow, large, many',
  params: Type.Object({
    scenario: Type.Optional(Type.Union([
      Type.Literal('slow'),
      Type.Literal('large'),
      Type.Literal('many'),
      Type.Literal('progress')
    ]))
  }),
  returns: Type.Any(),
  run: async function* (params: { scenario?: 'slow' | 'large' | 'many' | 'progress' }) {
    const scenario = params.scenario ?? 'slow'

    switch (scenario) {
      case 'slow':
        // Send items with delay
        for (let i = 0; i < 5; i++) {
          await sleep(100)
          yield { item: i, delay: '100ms' }
        }
        break

      case 'large':
        // Send large payload
        yield { data: 'x'.repeat(10000), size: 10000 }
        break

      case 'many':
        // Send many items quickly
        for (let i = 0; i < 100; i++) {
          yield { item: i }
        }
        break

      case 'progress':
        // Send items with progress indication
        const total = 10
        for (let i = 0; i < total; i++) {
          await sleep(50)
          yield {
            item: i,
            progress: Math.floor((i / total) * 100),
            message: `Processing ${i}/${total}`
          }
        }
        break
    }
  }
})

/**
 * Error test endpoint - intentional error scenarios
 */
const errorTest = method({
  name: 'error_test',
  description: 'Tests error handling scenarios',
  params: Type.Object({
    error_type: Type.Optional(Type.Union([
      Type.Literal('immediate'),
      Type.Literal('after_data'),
      Type.Literal('recoverable')
    ]))
  }),
  returns: Type.Any(),
  run: async function* (params: { error_type?: 'immediate' | 'after_data' | 'recoverable' }) {
    const errorType = params.error_type ?? 'immediate'

    switch (errorType) {
      case 'immediate':
        throw new Error('Immediate error as requested')

      case 'after_data':
        yield { message: 'Some data before error' }
        yield { message: 'More data' }
        throw new Error('Error after sending data')

      case 'recoverable':
        // Send error indication but continue (not a real error)
        yield { status: 'warning', message: 'Recoverable issue occurred' }
        yield { status: 'recovered', message: 'Successfully recovered' }
        break
    }
  }
})

/**
 * Metadata test endpoint - edge cases
 */
const metadataTest = method({
  name: 'metadata_test',
  description: 'Tests metadata structure with edge cases',
  params: Type.Object({}),
  returns: Type.Object({}),
  run: async function* () {
    // The metadata (provenance, plexus_hash, timestamp) is added automatically
    // by the server. This test just sends data to trigger metadata generation.

    yield { test: 'nested_provenance', data: { nested: true } }
    yield { test: 'hash_validation', note: 'Check plexus_hash is 64-char hex' }
    yield { test: 'timestamp_format', note: 'Check timestamp is integer milliseconds' }

    return { tests_complete: 3 }
  }
})

/**
 * Debug plugin - only export if PLEXUS_DEBUG is enabled
 */
export const debugPlugin = plugin('_debug', {
  version: '0.1.0',
  description: 'Debug endpoints for protocol validation (PLEXUS_DEBUG=true)',
  methods: {
    protocol_test: protocolTest,
    stream_test: streamTest,
    error_test: errorTest,
    metadata_test: metadataTest,
  },
})

/**
 * Check if debug mode is enabled
 */
export function isDebugEnabled(): boolean {
  return process.env.PLEXUS_DEBUG === 'true' || process.env.PLEXUS_DEBUG === '1'
}
