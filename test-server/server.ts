import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'

const app = new Hono()
const breakSessions = new Set<string>()
const retryHintSessions = new Set<string>()

export function resetTestState() {
  breakSessions.clear()
  retryHintSessions.clear()
}

// ─── 1. Basic: a handful of messages then close ────────────────────────

app.get('/basic', (c) =>
  streamSSE(c, async (stream) => {
    for (let i = 0; i < 5; i++) {
      await stream.writeSSE({ data: `message ${i}` })
      await stream.sleep(25)
    }
  }),
)

// ─── 2. Events with custom type ────────────────────────────────────────

app.get('/typed-events', (c) =>
  streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: 'start', data: 'stream started' })
    for (let i = 0; i < 3; i++) {
      await stream.writeSSE({ event: 'delta', data: `chunk ${i}` })
      await stream.sleep(25)
    }
    await stream.writeSSE({ event: 'done', data: 'stream finished' })
  }),
)

// ─── 3. Messages with id (enables last-event-id resumption) ────────────

app.get('/with-id', (c) => {
  const initialStart = parseInteger(c.req.query('start')) ?? 0
  const count = parseInteger(c.req.query('count')) ?? 5
  const lastId = parseInteger(c.req.header('last-event-id'))
  const start = lastId !== undefined ? lastId + 1 : initialStart

  return streamSSE(c, async (stream) => {
    for (let i = start; i < initialStart + count; i++) {
      await stream.writeSSE({ id: String(i), data: `item ${i}` })
      await stream.sleep(20)
    }
  })
})

// ─── 4. Server-sent retry interval ─────────────────────────────────────

app.get('/retry-then-break', (c) => {
  const session = c.req.query('session') ?? 'default'
  const retry = parseInteger(c.req.query('retry')) ?? 250
  const total = parseInteger(c.req.query('total')) ?? 3
  const lastId = parseInteger(c.req.header('last-event-id'))
  const start = lastId !== undefined ? lastId + 1 : 0

  return streamSSE(c, async (stream) => {
    if (!retryHintSessions.has(session)) {
      retryHintSessions.add(session)
      await stream.write(`retry: ${retry}\n\n`)
      await stream.writeSSE({ id: '0', data: 'before retry hint break' })
      await stream.sleep(20)
      stream.abort()
      return
    }

    for (let i = start; i < total; i++) {
      await stream.writeSSE({ id: String(i), data: `after retry ${i}` })
      await stream.sleep(20)
    }
  })
})

// ─── 5. Multi-line data ────────────────────────────────────────────────

app.get('/multiline', (c) =>
  streamSSE(c, async (stream) => {
    await stream.writeSSE({ data: 'line one\nline two\nline three' })
    await stream.writeSSE({ data: JSON.stringify({ key: 'value', nested: { a: 1 } }) })
  }),
)

// ─── 6. Large payload (many messages) ──────────────────────────────────

app.get('/large', (c) =>
  streamSSE(c, async (stream) => {
    for (let i = 0; i < 100; i++) {
      await stream.writeSSE({ data: `item ${i}` })
    }
  }),
)

// ─── 7. Slow stream (for abort testing) ────────────────────────────────

app.get('/slow', (c) =>
  streamSSE(c, async (stream) => {
    for (let i = 0; ; i++) {
      await stream.writeSSE({ data: `slow ${i}` })
      await stream.sleep(120)
    }
  }),
)

// ─── 8. Error responses ────────────────────────────────────────────────

app.get('/error-401', (c) => c.text('Unauthorized', 401))
app.get('/error-500', (c) => c.text('Internal Server Error', 500))

app.get('/wrong-content-type', (c) => c.json({ error: 'not an event stream' }))

// ─── 9. Stream that breaks once and resumes via last-event-id ──────────

app.get('/break-after-3', (c) => {
  const session = c.req.query('session') ?? 'default'
  const total = parseInteger(c.req.query('total')) ?? 5
  const lastId = parseInteger(c.req.header('last-event-id'))
  const start = lastId !== undefined ? lastId + 1 : 0

  return streamSSE(c, async (stream) => {
    const shouldBreak = !breakSessions.has(session)
    const end = shouldBreak ? Math.min(start + 3, total) : total

    for (let i = start; i < end; i++) {
      await stream.writeSSE({ id: String(i), data: `item ${i}` })
      await stream.sleep(20)
    }

    if (shouldBreak) {
      breakSessions.add(session)
      stream.abort()
    }
  })
})

// ─── 10. POST with body echo ───────────────────────────────────────────

app.post('/echo', async (c) => {
  const body = await c.req.json()
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: 'echo', data: JSON.stringify(body) })
  })
})

// ─── 11. Inspect request metadata ──────────────────────────────────────

app.all('/inspect-request', async (c) => {
  const contentType = c.req.header('content-type') ?? ''
  let body: unknown = null

  if (contentType.includes('application/json')) {
    body = await c.req.json().catch(() => null)
  }

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: 'inspect',
      data: JSON.stringify({
        method: c.req.method,
        authorization: c.req.header('authorization') ?? null,
        accept: c.req.header('accept') ?? null,
        lastEventId: c.req.header('last-event-id') ?? null,
        body,
      }),
    })
  })
})

export function startTestServer(
  port = parseInteger(process.env.PORT) ?? 0,
  hostname = process.env.HOST || '127.0.0.1',
) {
  resetTestState()

  return new Promise<{ server: ServerType; baseUrl: string }>((resolve, reject) => {
    const server = serve(
      { fetch: app.fetch, port, hostname },
      (info: AddressInfo) => {
        server.off('error', reject)
        resolve({
          server,
          baseUrl: `http://${hostname}:${info.port}`,
        })
      },
    )

    server.once('error', reject)
  })
}

export function stopTestServer(server: ServerType) {
  return new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { baseUrl } = await startTestServer()
  console.log(`SSE test server running on ${baseUrl}`)
}

function parseInteger(value: string | undefined) {
  if (value === undefined) return undefined

  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? undefined : parsed
}

export { app }
