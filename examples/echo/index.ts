import { serve, plugin, method } from '@plexus/rpc'
import { Type } from '@sinclair/typebox'

const echoPlugin = plugin('echo', {
  version: '1.0.0',
  description: 'Echo server — demonstration of @plexus/rpc',
  long_description: 'A minimal plexus-rpc server that echoes messages back. Connect with plexus-gamma to explore its schema live.',
  methods: {
    ping: method({
      description: 'Returns { pong: true }',
      params: Type.Object({}),
      run: () => ({ pong: true }),
    }),

    echo: method({
      description: 'Echo a message back, optionally repeated N times',
      params: Type.Object({
        message: Type.String({ description: 'The message to echo' }),
        count:   Type.Integer({ default: 1, minimum: 1, maximum: 100, description: 'Number of repetitions' }),
      }),
      run: ({ message, count }) => ({ message: message.repeat(count) }),
    }),

    stream: method({
      description: 'Stream a message count times, with optional delay between items',
      streaming: true,
      params: Type.Object({
        message: Type.String({ description: 'The message to stream' }),
        count:   Type.Integer({ minimum: 1, maximum: 100, description: 'Number of items' }),
        delayMs: Type.Integer({ default: 0, minimum: 0, maximum: 5000, description: 'Milliseconds between items' }),
      }),
      async *run({ message, count, delayMs }) {
        for (let i = 0; i < count; i++) {
          yield { line: message, index: i }
          if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs))
        }
      },
    }),
  },
})

const server = await serve('echo', { port: 4445 }, echoPlugin)
console.log(`echo server ready — connect plexus-gamma to ws://127.0.0.1:${server.port}`)
