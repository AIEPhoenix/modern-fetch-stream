/**
 * End-to-end tests for modern-fetch-stream against a real Hono SSE server.
 *
 * Usage:
 *   1. npm --prefix test-server test
 *   2. Optional: BASE_URL=http://localhost:3939 npm --prefix test-server test
 */

import { randomUUID } from 'node:crypto'
import { fetchEventSource, EventStreamContentType, ReceiveState } from '../src/index'
import { resetTestState, startTestServer, stopTestServer } from './server'

const externalBase = process.env.BASE_URL
let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void>) {
  resetTestState()

  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log(`  ✗ ${name}`)
    console.log(`    ${message}`)
    failed++
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`)
  }
}

async function readJsonEvent<T>(
  input: RequestInfo | URL,
  init?: Parameters<typeof fetchEventSource>[1],
) {
  let payload: T | undefined

  await fetchEventSource(input, {
    ...init,
    onmessage(event) {
      payload = JSON.parse(event.data) as T
      init?.onmessage?.(event)
    },
  })

  assert(payload !== undefined, 'expected at least one SSE message')
  return payload
}

async function main() {
  const startedServer = externalBase ? undefined : await startTestServer()
  const baseUrl = externalBase ?? startedServer?.baseUrl
  assert(baseUrl, 'missing base url for e2e tests')

  try {
    console.log('\nmodern-fetch-stream e2e tests\n')

    await test('receives basic messages', async () => {
      const messages: string[] = []
      await fetchEventSource(`${baseUrl}/basic`, {
        onmessage(event) {
          messages.push(event.data)
        },
      })

      assert(messages.length === 5, `expected 5 messages, got ${messages.length}`)
      assert(messages[0] === 'message 0', `first message was "${messages[0]}"`)
      assert(messages[4] === 'message 4', `last message was "${messages[4]}"`)
    })

    await test('receives typed events', async () => {
      const events: Array<{ type?: string; data: string }> = []

      await fetchEventSource(`${baseUrl}/typed-events`, {
        onmessage(event) {
          events.push({ type: event.event, data: event.data })
        },
      })

      assert(events.length === 5, `expected 5 events, got ${events.length}`)
      assert(events[0].type === 'start', `first event type was "${events[0].type}"`)
      assert(events[1].type === 'delta', `second event type was "${events[1].type}"`)
      assert(events[4].type === 'done', `last event type was "${events[4].type}"`)
    })

    await test('receives ids from a real SSE stream', async () => {
      const ids: string[] = []

      await fetchEventSource(`${baseUrl}/with-id?start=10&count=4`, {
        onmessage(event) {
          if (event.id) ids.push(event.id)
        },
      })

      assert(ids.join(',') === '10,11,12,13', `unexpected ids: ${ids.join(',')}`)
    })

    await test('handles multi-line data', async () => {
      const messages: string[] = []

      await fetchEventSource(`${baseUrl}/multiline`, {
        onmessage(event) {
          messages.push(event.data)
        },
      })

      assert(messages.length === 2, `expected 2 messages, got ${messages.length}`)
      assert(messages[0] === 'line one\nline two\nline three', 'multiline payload mismatch')
      const parsed = JSON.parse(messages[1]) as { key: string; nested: { a: number } }
      assert(parsed.key === 'value', 'json payload mismatch')
      assert(parsed.nested.a === 1, 'nested json payload mismatch')
    })

    await test('handles a large stream', async () => {
      const messages: string[] = []

      await fetchEventSource(`${baseUrl}/large`, {
        onmessage(event) {
          messages.push(event.data)
        },
      })

      assert(messages.length === 100, `expected 100 messages, got ${messages.length}`)
      assert(messages[0] === 'item 0', 'first large payload item mismatch')
      assert(messages[99] === 'item 99', 'last large payload item mismatch')
    })

    await test('aborts cleanly via AbortController', async () => {
      const controller = new AbortController()
      const messages: string[] = []

      setTimeout(() => controller.abort(), 280)

      await fetchEventSource(`${baseUrl}/slow`, {
        signal: controller.signal,
        onmessage(event) {
          messages.push(event.data)
        },
      })

      assert(messages.length > 0, 'expected to receive some messages before abort')
      assert(messages.length < 5, `expected fewer than 5 messages, got ${messages.length}`)
    })

    await test('preserves Request headers on a real HTTP request', async () => {
      const request = new Request(`${baseUrl}/inspect-request`, {
        headers: { Authorization: 'Bearer real-request-token' },
      })

      const payload = await readJsonEvent<{
        authorization: string | null
        accept: string | null
      }>(request)

      assert(payload.authorization === 'Bearer real-request-token', 'authorization header was lost')
      assert(payload.accept?.startsWith(EventStreamContentType), 'accept header mismatch')
    })

    await test('sends POST JSON bodies to the server', async () => {
      const messages: string[] = []

      await fetchEventSource(`${baseUrl}/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
        onmessage(event) {
          messages.push(event.data)
        },
      })

      assert(messages.length === 1, `expected 1 message, got ${messages.length}`)
      const parsed = JSON.parse(messages[0]) as { hello: string }
      assert(parsed.hello === 'world', 'body echo mismatch')
    })

    await test('supports custom onopen validation', async () => {
      let openCalled = false

      await fetchEventSource(`${baseUrl}/basic`, {
        onopen(response) {
          openCalled = true
          if (!response.ok) throw new Error('unexpected response')
        },
      })

      assert(openCalled, 'onopen was not called')
    })

    await test('rejects wrong content-type', async () => {
      let thrown = false

      try {
        await fetchEventSource(`${baseUrl}/wrong-content-type`, {
          onerror() {
            throw new Error('wrong content-type')
          },
        })
      } catch (error) {
        thrown = true
        assert(error instanceof Error && error.message === 'wrong content-type', 'unexpected error')
      }

      assert(thrown, 'expected wrong content-type to throw')
    })

    await test('rejects 401 when onerror marks it fatal', async () => {
      let thrown = false

      try {
        await fetchEventSource(`${baseUrl}/error-401`, {
          onopen(response) {
            if (!response.ok) {
              throw new Error(`http ${response.status}`)
            }
          },
          onerror() {
            throw new Error('unauthorized')
          },
        })
      } catch (error) {
        thrown = true
        assert(error instanceof Error && error.message === 'unauthorized', 'unexpected 401 error')
      }

      assert(thrown, 'expected 401 path to throw')
    })

    await test('calls onclose with ReceiveState on normal end', async () => {
      let finalState: ReceiveState | undefined

      await fetchEventSource(`${baseUrl}/with-id`, {
        onclose(state) {
          finalState = state
        },
      })

      assert(finalState === ReceiveState.RECEIVED, `unexpected receive state: ${finalState}`)
    })

    await test('retries and resumes after a broken stream using last-event-id', async () => {
      const session = randomUUID()
      const messages: string[] = []
      let attempts = 0

      await fetchEventSource(`${baseUrl}/break-after-3?session=${session}&total=5`, {
        onopen() {
          attempts++
        },
        onmessage(event) {
          messages.push(event.data)
        },
        onclose(state) {
          if (attempts < 2) {
            assert(state === ReceiveState.RECEIVED, `unexpected receive state during reconnect: ${state}`)
            throw new Error('retry to resume stream')
          }
        },
        onerror(error, state) {
          assert(state === ReceiveState.RECEIVED, `unexpected receive state during retry: ${state}`)
          if (error instanceof Error && error.message === 'retry to resume stream') {
            return 50
          }
          throw error
        },
      })

      assert(attempts === 2, `expected 2 attempts, got ${attempts}`)
      assert(messages.join(',') === 'item 0,item 1,item 2,item 3,item 4', 'resume sequence mismatch')
    })

    await test('respects server-sent retry hints across reconnects', async () => {
      const session = randomUUID()
      const openTimes: number[] = []
      const messages: string[] = []

      await fetchEventSource(`${baseUrl}/retry-then-break?session=${session}&retry=250&total=3`, {
        onopen() {
          openTimes.push(Date.now())
        },
        onmessage(event) {
          messages.push(event.data)
        },
        onclose(state) {
          if (openTimes.length < 2) {
            assert(state === ReceiveState.RECEIVED, `unexpected receive state during hinted reconnect: ${state}`)
            throw new Error('retry using server hint')
          }
        },
        onerror(error, state) {
          assert(state === ReceiveState.RECEIVED, `unexpected receive state during hinted retry: ${state}`)
          if (error instanceof Error && error.message === 'retry using server hint') {
            return
          }
          throw error
        },
      })

      assert(openTimes.length === 2, `expected 2 opens, got ${openTimes.length}`)
      assert(openTimes[1] - openTimes[0] >= 200, `retry hint was not respected: ${openTimes[1] - openTimes[0]}ms`)
      assert(messages.join(',') === 'before retry hint break,after retry 1,after retry 2', 'retry sequence mismatch')
    })
  } finally {
    if (startedServer) {
      await stopTestServer(startedServer.server)
    }
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`)
  process.exit(failed > 0 ? 1 : 0)
}

await main()
