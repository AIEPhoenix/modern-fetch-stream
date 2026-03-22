import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { serve } from '@hono/node-server'

const app = new Hono()

// ─── 1. Basic: a handful of messages then close ────────────────────────

app.get('/basic', (c) =>
  streamSSE(c, async (stream) => {
    for (let i = 0; i < 5; i++) {
      await stream.writeSSE({ data: `message ${i}` })
      await stream.sleep(100)
    }
  }),
)

// ─── 2. Events with custom type ────────────────────────────────────────

app.get('/typed-events', (c) =>
  streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: 'start', data: 'stream started' })
    for (let i = 0; i < 3; i++) {
      await stream.writeSSE({ event: 'delta', data: `chunk ${i}` })
      await stream.sleep(100)
    }
    await stream.writeSSE({ event: 'done', data: 'stream finished' })
  }),
)

// ─── 3. Messages with id (enables last-event-id resumption) ────────────

let resumeCounter = 0

app.get('/with-id', (c) => {
  const lastId = c.req.header('last-event-id')
  const start = lastId ? parseInt(lastId, 10) + 1 : resumeCounter

  return streamSSE(c, async (stream) => {
    for (let i = start; i < start + 5; i++) {
      resumeCounter = i
      await stream.writeSSE({ id: String(i), data: `item ${i}` })
      await stream.sleep(100)
    }
  })
})

// ─── 4. Server-sent retry interval ─────────────────────────────────────

app.get('/with-retry', (c) =>
  streamSSE(c, async (stream) => {
    await stream.writeSSE({ data: 'retry: 3000\n\ndata: hello after retry hint' })
    // Manually write retry field since writeSSE may not support it directly
    await stream.write(`retry: 3000\n\n`)
    await stream.writeSSE({ data: 'hello after retry hint' })
  }),
)

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
      await stream.sleep(1000)
    }
  }),
)

// ─── 8. Error responses ────────────────────────────────────────────────

app.get('/error-401', (c) => c.text('Unauthorized', 401))
app.get('/error-500', (c) => c.text('Internal Server Error', 500))

app.get('/wrong-content-type', (c) => {
  return c.json({ error: 'not an event stream' })
})

// ─── 9. Stream that breaks mid-way ─────────────────────────────────────

app.get('/break-after-3', (c) =>
  streamSSE(c, async (stream) => {
    for (let i = 0; i < 3; i++) {
      await stream.writeSSE({ id: String(i), data: `before break ${i}` })
      await stream.sleep(100)
    }
    stream.abort()
  }),
)

// ─── 10. POST with body echo ───────────────────────────────────────────

app.post('/echo', async (c) => {
  const body = await c.req.json()
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: 'echo', data: JSON.stringify(body) })
  })
})

// ─── Start ─────────────────────────────────────────────────────────────

const port = parseInt(process.env.PORT || '3939', 10)

serve({ fetch: app.fetch, port }, () => {
  console.log(`SSE test server running on http://localhost:${port}`)
})

export { app }
