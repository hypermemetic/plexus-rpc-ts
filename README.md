# plexus-rpc-ts

**Version**: 0.1.0
**TypeScript/Bun implementation of the Plexus RPC protocol**

A schema-driven RPC framework for TypeScript/Bun with streaming responses, automatic schema validation, and zero-config debug endpoints.

```typescript
import { serve, plugin, method } from '@plexus/rpc'
import { Type } from '@sinclair/typebox'

const echoPlugin = plugin('echo', {
  version: '1.0.0',
  description: 'Echo service',
  methods: {
    once: method({
      description: 'Echo a message once',
      params: Type.Object({
        message: Type.String()
      }),
      run: ({ message }) => ({
        message,
        count: 1
      })
    })
  }
})

serve('substrate', { port: 4444 }, echoPlugin)
```

## Features

- **Schema-driven**: Uses TypeBox for runtime type validation
- **Streaming**: Built-in support for async generators and streams
- **Auto-discovery**: Plugins automatically expose their schema via `_info`
- **Debug mode**: Built-in protocol validation endpoints (see below)
- **WebSocket transport**: JSON-RPC 2.0 over WebSocket
- **Zero config**: Sensible defaults, minimal boilerplate

## Installation

```bash
# Using npm
npm install @plexus/rpc

# Using bun
bun add @plexus/rpc
```

## Quick Start

### 1. Define a Plugin

```typescript
import { plugin, method } from '@plexus/rpc'
import { Type } from '@sinclair/typebox'

const calculatorPlugin = plugin('calculator', {
  version: '1.0.0',
  description: 'Basic calculator',
  methods: {
    add: method({
      description: 'Add two numbers',
      params: Type.Object({
        a: Type.Number(),
        b: Type.Number()
      }),
      run: ({ a, b }) => ({ result: a + b })
    })
  }
})
```

### 2. Serve the Plugin

```typescript
import { serve } from '@plexus/rpc'

const server = serve('calculator', { port: 4445 }, calculatorPlugin)
```

### 3. Connect with a Client

```bash
# Using synapse CLI
synapse -P 4445 calculator add --a 5 --b 3
# => result: 8
```

## Advanced Features

### Streaming Methods

Return async generators for streaming responses:

```typescript
const streamPlugin = plugin('stream', {
  version: '1.0.0',
  description: 'Streaming example',
  methods: {
    countdown: method({
      description: 'Count down from N',
      params: Type.Object({
        from: Type.Number()
      }),
      run: async function* ({ from }) {
        for (let i = from; i >= 0; i--) {
          yield { count: i }
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      }
    })
  }
})
```

### Multiple Plugins

Compose multiple plugins into one server:

```typescript
serve('backend', { port: 4444 },
  echoPlugin,
  calculatorPlugin,
  streamPlugin
)
```

### Nested Namespaces

Create hierarchical plugin structures:

```typescript
const parentPlugin = plugin('parent', {
  version: '1.0.0',
  description: 'Parent namespace',
  children: {
    child: childPlugin  // Creates parent.child.method
  },
  methods: { /* parent methods */ }
})
```

## Debug Mode

plexus-rpc-ts includes built-in debug endpoints for protocol validation and testing.

### Enabling Debug Mode

Set the `PLEXUS_DEBUG` environment variable to `true` or `1`:

```bash
PLEXUS_DEBUG=1 bun run server.ts
```

When enabled, you'll see:
```
[plexus-rpc] PLEXUS_DEBUG enabled - debug endpoints available at _debug.*
```

Debug endpoints are **automatically injected** into any server using `serve()` — no code changes required.

### Available Debug Endpoints

#### `_debug.protocol_test`
Tests all Plexus message types (StreamData, StreamProgress, StreamDone).

```bash
synapse -P 4444 backend _debug.protocol_test
```

**Returns**:
- Data message with test payload
- Progress update (50%)
- Completion (StreamDone)

**Use case**: Verify client protocol implementation

#### `_debug.stream_test`
Tests different streaming patterns.

**Scenarios**:
- `slow` - 5 items with increasing delays (100-200ms)
- `large` - 3 items with 10KB payloads each
- `many` - 100 items with minimal delay
- `progress` - Progress updates at 0%, 25%, 50%, 75%, 100%

```bash
# Test slow streaming
synapse -P 4444 backend _debug.stream_test --scenario slow

# Test large payloads
synapse -P 4444 backend _debug.stream_test --scenario large

# Test high-volume streaming
synapse -P 4444 backend _debug.stream_test --scenario many

# Test progress reporting
synapse -P 4444 backend _debug.stream_test --scenario progress
```

**Use case**: Validate stream handling under different load patterns

#### `_debug.error_test`
Generates controlled error scenarios.

**Error types**:
- `immediate` - Error before any data
- `after_data` - Error after sending 3 data items
- `recoverable` - Recoverable error with stream continuation

```bash
# Test immediate error handling
synapse -P 4444 backend _debug.error_test --error_type immediate

# Test error after data
synapse -P 4444 backend _debug.error_test --error_type after_data

# Test recoverable errors
synapse -P 4444 backend _debug.error_test --error_type recoverable
```

**Use case**: Test client error handling

#### `_debug.metadata_test`
Tests metadata edge cases with various provenance chains.

```bash
synapse -P 4444 backend _debug.metadata_test
```

**Returns**:
- Single provenance item
- Nested provenance chains (3 levels)
- Long provenance chains (6 items)
- Different plexus_hash values
- Various timestamps

**Use case**: Validate metadata parsing and provenance handling

### Programmatic Check

Check if debug mode is enabled:

```typescript
import { isDebugEnabled } from '@plexus/rpc'

if (isDebugEnabled()) {
  console.log('Debug mode active!')
}
```

### Security Warning

Debug endpoints expose internal system behavior and should **NEVER** be enabled in production.

- Debug endpoints are NOT authenticated
- They may expose implementation details
- They can generate high load (e.g., `stream_test` with "many" scenario)
- They bypass normal authorization checks

**Production checklist**:
- [ ] `PLEXUS_DEBUG` is NOT set in production environment
- [ ] Production configs don't enable debug mode
- [ ] CI/CD pipelines don't enable debug in production stages

## API Reference

### `plugin(name, config)`

Create a plugin with methods.

**Parameters**:
- `name` - Plugin namespace (e.g., `'calculator'`)
- `config` - Plugin configuration:
  - `version` - Semantic version string
  - `description` - Human-readable description
  - `methods` - Object mapping method names to method definitions
  - `children` (optional) - Object mapping child namespace names to child plugins

**Returns**: Plugin object

### `method(config)`

Define a method within a plugin.

**Parameters**:
- `config` - Method configuration:
  - `description` - Method description
  - `params` - TypeBox schema for parameters
  - `run` - Function implementing the method
    - Receives validated params object
    - Can return: value, Promise, or AsyncGenerator (for streaming)

**Returns**: Method definition

### `serve(name, options, ...plugins)`

Create and start a Plexus RPC server.

**Parameters**:
- `name` - Server name (root namespace)
- `options` - Server options:
  - `port` - Port to listen on
  - `host` (optional) - Host to bind to (default: `'0.0.0.0'`)
- `...plugins` - One or more plugins to serve

**Returns**: Server instance

### `isDebugEnabled()`

Check if debug mode is enabled.

**Returns**: `boolean` - `true` if `PLEXUS_DEBUG` is set to truthy value

## Architecture

plexus-rpc-ts uses:
- **TypeBox** - Runtime type validation with JSON Schema
- **WebSocket** - Bidirectional communication
- **JSON-RPC 2.0** - Protocol structure with Plexus extensions
- **Async generators** - Native streaming support

Each method can:
- Return a value (single response)
- Return a Promise (async single response)
- Return an AsyncGenerator (streaming responses)

All responses are wrapped in Plexus stream items (StreamData, StreamProgress, StreamDone).

## Examples

See the `examples/` directory for complete examples:
- `examples/echo/` - Basic echo server
- More examples coming soon

## Related Tools

- **synapse** - Haskell CLI client for Plexus RPC
- **plexus-core** - Rust implementation of Plexus RPC
- **synapse-cc** - Code generator for TypeScript/Python clients
- **axon** - Validation framework for Plexus stack

## Development

```bash
# Install dependencies
bun install

# Run tests
bun test

# Build
bun run build
```

## Known Issues

### Float Timestamp Bug

**Status**: Unfixed
**Location**: `src/server.ts:68`
**Issue**: `Date.now() / 1000` produces a float, but synapse expects an integer timestamp.
**Impact**: Silent parse failure causing infinite hang when synapse connects.
**Fix**: Change to `Math.floor(Date.now() / 1000)`

This bug is tracked and documented in:
- `integration-tests/compliance/SUMMARY.md`
- `synapse/docs/architecture/1773984890644708352-STATE-OF.md:159`

A test exists in `integration-tests/tests/test_6_plexus_rpc_ts.py` (marked with `@pytest.mark.xfail`).

## License

MIT
