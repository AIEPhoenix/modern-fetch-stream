/**
 * Integration tests for modern-fetch-sse against a real Hono SSE server.
 *
 * Usage:
 *   1. cd test-server && npm install
 *   2. npm start          (starts server on :3939)
 *   3. npm test           (runs this file in another terminal)
 */

import { fetchEventSource, EventStreamContentType } from '../src/index'

const BASE = process.env.BASE_URL || 'http://localhost:3939'
let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err: any) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${err.message}`)
    failed++
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// ─────────────────────────────────────────────────────────────────────────

console.log('\nmodern-fetch-sse integration tests\n')

// ── 1. Basic messages ────────────────────────────────────────────────────

await test('receives basic messages', async () => {
  const messages: string[] = []
  await fetchEventSource(`${BASE}/basic`, {
    onmessage(ev) { messages.push(ev.data) },
  })
  assert(messages.length === 5, `expected 5 messages, got ${messages.length}`)
  assert(messages[0] === 'message 0', `first message was "${messages[0]}"`)
  assert(messages[4] === 'message 4', `last message was "${messages[4]}"`)
})

// ── 2. Typed events ─────────────────────────────────────────────────────

await test('receives typed events', async () => {
  const events: { type?: string; data: string }[] = []
  await fetchEventSource(`${BASE}/typed-events`, {
    onmessage(ev) { events.push({ type: ev.event, data: ev.data }) },
  })
  assert(events.length === 5, `expected 5 events, got ${events.length}`)
  assert(events[0].type === 'start', `first event type was "${events[0].type}"`)
  assert(events[1].type === 'delta', `second event type was "${events[1].type}"`)
  assert(events[4].type === 'done', `last event type was "${events[4].type}"`)
})

// ── 3. Messages with id ─────────────────────────────────────────────────

await test('receives messages with id', async () => {
  const ids: string[] = []
  await fetchEventSource(`${BASE}/with-id`, {
    onmessage(ev) {
      if (ev.id) ids.push(ev.id)
    },
  })
  assert(ids.length === 5, `expected 5 ids, got ${ids.length}`)
})

// ── 4. Multi-line data ──────────────────────────────────────────────────

await test('handles multi-line data', async () => {
  const messages: string[] = []
  await fetchEventSource(`${BASE}/multiline`, {
    onmessage(ev) { messages.push(ev.data) },
  })
  assert(messages.length === 2, `expected 2 messages, got ${messages.length}`)
  assert(messages[0].includes('\n'), `first message should contain newlines`)
  const parsed = JSON.parse(messages[1])
  assert(parsed.key === 'value', `JSON parse failed`)
})

// ── 5. Large payload ────────────────────────────────────────────────────

await test('handles 100 messages', async () => {
  const messages: string[] = []
  await fetchEventSource(`${BASE}/large`, {
    onmessage(ev) { messages.push(ev.data) },
  })
  assert(messages.length === 100, `expected 100 messages, got ${messages.length}`)
})

// ── 6. Abort via signal ─────────────────────────────────────────────────

await test('aborts cleanly via AbortController', async () => {
  const ctrl = new AbortController()
  const messages: string[] = []

  setTimeout(() => ctrl.abort(), 300)

  await fetchEventSource(`${BASE}/slow`, {
    signal: ctrl.signal,
    onmessage(ev) { messages.push(ev.data) },
  })

  // Should have received at most a few messages before abort.
  assert(messages.length < 5, `expected fewer than 5, got ${messages.length}`)
})

// ── 7. Error: wrong content-type ────────────────────────────────────────

await test('rejects wrong content-type', async () => {
  let errorCaught = false
  try {
    await fetchEventSource(`${BASE}/wrong-content-type`, {
      onerror() { throw new Error('wrong content-type') },
    })
  } catch {
    errorCaught = true
  }
  assert(errorCaught, 'should have thrown on wrong content-type')
})

// ── 8. Error: 401 ───────────────────────────────────────────────────────

await test('handles 401 via onerror throw', async () => {
  let errorCaught = false
  try {
    await fetchEventSource(`${BASE}/error-401`, {
      onerror() { throw new Error('unauthorized') },
    })
  } catch {
    errorCaught = true
  }
  assert(errorCaught, 'should have thrown on 401')
})

// ── 9. Custom onopen validation ─────────────────────────────────────────

await test('supports custom onopen validation', async () => {
  let openCalled = false
  const messages: string[] = []

  await fetchEventSource(`${BASE}/basic`, {
    onopen(response) {
      openCalled = true
      if (!response.ok) throw new Error('not ok')
    },
    onmessage(ev) { messages.push(ev.data) },
  })

  assert(openCalled, 'onopen was not called')
  assert(messages.length === 5, `expected 5 messages, got ${messages.length}`)
})

// ── 10. onclose is called ───────────────────────────────────────────────

await test('calls onclose when stream ends', async () => {
  let closeCalled = false
  await fetchEventSource(`${BASE}/basic`, {
    onclose() { closeCalled = true },
  })
  assert(closeCalled, 'onclose was not called')
})

// ── 11. POST with body ──────────────────────────────────────────────────

await test('sends POST with JSON body', async () => {
  const messages: string[] = []
  await fetchEventSource(`${BASE}/echo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hello: 'world' }),
    onmessage(ev) { messages.push(ev.data) },
  })
  assert(messages.length === 1, `expected 1 message, got ${messages.length}`)
  const parsed = JSON.parse(messages[0])
  assert(parsed.hello === 'world', `body echo mismatch`)
})

// ── 12. Retry on stream break ───────────────────────────────────────────

await test('retries and resumes after stream break', async () => {
  const messages: string[] = []
  let attempts = 0

  await fetchEventSource(`${BASE}/break-after-3`, {
    onopen() { attempts++ },
    onmessage(ev) { messages.push(ev.data) },
    onerror() {
      if (attempts >= 2) throw new Error('stop after 2 attempts')
      return 100
    },
  })
})

// ── Summary ──────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)
