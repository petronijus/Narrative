import Fastify from 'fastify'

const PORT = Number(process.env['PORT'] ?? 3001)
const HOST = process.env['HOST'] ?? '0.0.0.0'

const isDev = process.env['NODE_ENV'] !== 'production'

const app = Fastify({
  logger: isDev
    ? {
        level: process.env['LOG_LEVEL'] ?? 'info',
        transport: { target: 'pino-pretty', options: { colorize: true } },
      }
    : {
        level: process.env['LOG_LEVEL'] ?? 'info',
      },
})

// Health endpoint
app.get('/health', async (_request, _reply) => {
  return { status: 'ok' }
})

// Start server
const start = async () => {
  try {
    await app.listen({ port: PORT, host: HOST })
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

await start()
