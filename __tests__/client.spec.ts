import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchEventSource, EventStreamContentType, ReceiveState } from '../src/index'

// ── helpers ──────────────────────────────────────

function sseChunk(...lines: string[]): string {
  return lines.join('\n') + '\n\n'
}

function mockSSEResponse(
  chunks: string[],
  options: { status?: number; contentType?: string; delay?: number } = {},
): Response {
  const { status = 200, contentType = EventStreamContentType, delay = 0 } = options
  const encoder = new TextEncoder()
  let index = 0
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay))
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index++]))
      } else {
        controller.close()
      }
    },
  })
  return new Response(body, { status, headers: { 'content-type': contentType } })
}

describe('fetchEventSource', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('should receive messages', async () => {
    const messages: string[] = []
    const mockFetch = vi.fn().mockResolvedValue(
      mockSSEResponse([sseChunk('data: hello'), sseChunk('data: world')]),
    )

    await fetchEventSource('http://test/sse', {
      fetch: mockFetch,
      onmessage(ev) { messages.push(ev.data) },
    })

    expect(messages).toEqual(['hello', 'world'])
  })

  it('should handle multi-line data', async () => {
    const messages: string[] = []
    const mockFetch = vi.fn().mockResolvedValue(
      mockSSEResponse([sseChunk('data: a', 'data: b', 'data: c')]),
    )

    await fetchEventSource('http://test/sse', {
      fetch: mockFetch,
      onmessage(ev) { messages.push(ev.data) },
    })

    expect(messages).toEqual(['a\nb\nc'])
  })

  it('should pass headers and method', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockSSEResponse([sseChunk('data: ok')]),
    )

    await fetchEventSource('http://test/sse', {
      fetch: mockFetch,
      method: 'POST',
      headers: { Authorization: 'Bearer x' },
    })

    expect(mockFetch.mock.calls[0][1].method).toBe('POST')
    expect(mockFetch.mock.calls[0][1].headers.authorization).toBe('Bearer x')
    expect(mockFetch.mock.calls[0][1].headers.accept).toBe(EventStreamContentType)
  })

  it('should call onclose on normal end', async () => {
    const onclose = vi.fn()
    const mockFetch = vi.fn().mockResolvedValue(
      mockSSEResponse([sseChunk('data: done')]),
    )

    await fetchEventSource('http://test/sse', { fetch: mockFetch, onclose })
    expect(onclose).toHaveBeenCalledOnce()
  })

  it('should resolve on abort', async () => {
    const ctrl = new AbortController()
    const mockFetch = vi.fn().mockResolvedValue(
      mockSSEResponse([sseChunk('data: 1')], { delay: 50 }),
    )

    setTimeout(() => ctrl.abort(), 10)

    await fetchEventSource('http://test/sse', {
      fetch: mockFetch,
      signal: ctrl.signal,
    })
  })

  // ── retry ──────────────────────────────────────

  it('should retry on error with default interval', async () => {
    vi.useFakeTimers()
    let callCount = 0
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) return Promise.reject(new Error('fail'))
      return Promise.resolve(mockSSEResponse([sseChunk('data: ok')]))
    })

    const promise = fetchEventSource('http://test/sse', {
      fetch: mockFetch,
      onmessage() {},
    })

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)
    await promise

    expect(callCount).toBe(2)
    vi.useRealTimers()
  })

  it('should use custom interval from onerror', async () => {
    vi.useFakeTimers()
    let callCount = 0
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) return Promise.reject(new Error('fail'))
      return Promise.resolve(mockSSEResponse([sseChunk('data: ok')]))
    })

    const promise = fetchEventSource('http://test/sse', {
      fetch: mockFetch,
      onerror() { return 5000 },
      onmessage() {},
    })

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(3000)
    expect(callCount).toBe(1)
    await vi.advanceTimersByTimeAsync(2000)
    await promise

    expect(callCount).toBe(2)
    vi.useRealTimers()
  })

  it('should stop when onerror throws', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('fail'))

    await expect(
      fetchEventSource('http://test/sse', {
        fetch: mockFetch,
        onerror() { throw new Error('fatal') },
      }),
    ).rejects.toThrow('fatal')

    expect(mockFetch).toHaveBeenCalledOnce()
  })

  it('should reject wrong content-type', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockSSEResponse([], { contentType: 'text/html' }),
    )

    await expect(
      fetchEventSource('http://test/sse', {
        fetch: mockFetch,
        onerror() { throw new Error('bad ct') },
      }),
    ).rejects.toThrow('bad ct')
  })

  // ── last-event-id ──────────────────────────────

  it('should send last-event-id on reconnect', async () => {
    vi.useFakeTimers()
    let callCount = 0

    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        const encoder = new TextEncoder()
        let sent = false
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!sent) {
              controller.enqueue(encoder.encode(sseChunk('id: 42', 'data: first')))
              sent = true
            } else {
              controller.error(new Error('lost'))
            }
          },
        })
        return Promise.resolve(
          new Response(body, { status: 200, headers: { 'content-type': EventStreamContentType } }),
        )
      }
      return Promise.resolve(mockSSEResponse([sseChunk('data: second')]))
    })

    const promise = fetchEventSource('http://test/sse', {
      fetch: mockFetch,
      onmessage() {},
    })

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)
    await promise

    expect(mockFetch.mock.calls[1][1].headers['last-event-id']).toBe('42')
    vi.useRealTimers()
  })

  it('should clear last-event-id when server sends empty id', async () => {
    vi.useFakeTimers()
    let callCount = 0

    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        const encoder = new TextEncoder()
        let phase = 0
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (phase === 0) {
              controller.enqueue(encoder.encode(sseChunk('id: 42', 'data: first')))
              phase++
            } else if (phase === 1) {
              // Empty id clears last-event-id per SSE spec
              controller.enqueue(encoder.encode(sseChunk('id: ', 'data: second')))
              phase++
            } else {
              controller.error(new Error('lost'))
            }
          },
        })
        return Promise.resolve(
          new Response(body, { status: 200, headers: { 'content-type': EventStreamContentType } }),
        )
      }
      return Promise.resolve(mockSSEResponse([sseChunk('data: third')]))
    })

    const promise = fetchEventSource('http://test/sse', {
      fetch: mockFetch,
      onmessage() {},
    })

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)
    await promise

    expect(mockFetch.mock.calls[1][1].headers['last-event-id']).toBeUndefined()
    vi.useRealTimers()
  })

  // ── receiveState ────────────────────────────────

  it('should pass RECEIVED to onclose when messages have id', async () => {
    const onclose = vi.fn()
    const mockFetch = vi.fn().mockResolvedValue(
      mockSSEResponse([sseChunk('id: 1', 'data: hello')]),
    )

    await fetchEventSource('http://test/sse', { fetch: mockFetch, onclose })
    expect(onclose).toHaveBeenCalledWith(ReceiveState.RECEIVED)
  })

  it('should pass RECEIVED_NO_ID to onclose when messages have no id', async () => {
    const onclose = vi.fn()
    const mockFetch = vi.fn().mockResolvedValue(
      mockSSEResponse([sseChunk('data: hello')]),
    )

    await fetchEventSource('http://test/sse', { fetch: mockFetch, onclose })
    expect(onclose).toHaveBeenCalledWith(ReceiveState.RECEIVED_NO_ID)
  })

  it('should pass IDLE to onclose when no messages received', async () => {
    const onclose = vi.fn()
    const mockFetch = vi.fn().mockResolvedValue(
      mockSSEResponse([]),
    )

    await fetchEventSource('http://test/sse', { fetch: mockFetch, onclose })
    expect(onclose).toHaveBeenCalledWith(ReceiveState.IDLE)
  })

  // ── onerror returning 0 ─────────────────────────

  it('should retry immediately when onerror returns 0', async () => {
    vi.useFakeTimers()
    let callCount = 0
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) return Promise.reject(new Error('fail'))
      return Promise.resolve(mockSSEResponse([sseChunk('data: ok')]))
    })

    const promise = fetchEventSource('http://test/sse', {
      fetch: mockFetch,
      onerror() { return 0 },
      onmessage() {},
    })

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    await promise

    expect(callCount).toBe(2)
    vi.useRealTimers()
  })

  // ── SSE retry field ─────────────────────────────

  it('should respect server retry field for reconnection interval', async () => {
    vi.useFakeTimers()
    let callCount = 0
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        const encoder = new TextEncoder()
        let phase = 0
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (phase === 0) {
              // Server sets retry to 3000ms
              controller.enqueue(encoder.encode('retry: 3000\n\n'))
              phase++
            } else if (phase === 1) {
              controller.enqueue(encoder.encode(sseChunk('data: hello')))
              phase++
            } else {
              controller.error(new Error('lost'))
            }
          },
        })
        return Promise.resolve(
          new Response(body, { status: 200, headers: { 'content-type': EventStreamContentType } }),
        )
      }
      return Promise.resolve(mockSSEResponse([sseChunk('data: ok')]))
    })

    const promise = fetchEventSource('http://test/sse', {
      fetch: mockFetch,
      onmessage() {},
    })

    await vi.advanceTimersByTimeAsync(0)
    // Default 1000ms should not be enough
    await vi.advanceTimersByTimeAsync(1000)
    expect(callCount).toBe(1)
    // Server-specified 3000ms should trigger retry
    await vi.advanceTimersByTimeAsync(2000)
    await promise

    expect(callCount).toBe(2)
    vi.useRealTimers()
  })

  // ── null response body ──────────────────────────

  it('should throw when response body is null', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(null, { status: 200, headers: { 'content-type': EventStreamContentType } }),
    )

    await expect(
      fetchEventSource('http://test/sse', {
        fetch: mockFetch,
        onerror() { throw new Error('null body') },
      }),
    ).rejects.toThrow('null body')
  })

  // ── pre-aborted signal ──────────────────────────

  it('should resolve immediately with pre-aborted signal', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    // Mock fetch that respects abort signal
    const mockFetch = vi.fn().mockImplementation((_input: string, init: RequestInit) => {
      if (init.signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'))
      return Promise.resolve(mockSSEResponse([sseChunk('data: ok')]))
    })

    await fetchEventSource('http://test/sse', {
      fetch: mockFetch,
      signal: ctrl.signal,
    })

    expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(1)
  })

  // ── onclose throw triggers retry ────────────────

  it('should retry when onclose throws', async () => {
    vi.useFakeTimers()
    let callCount = 0
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve(mockSSEResponse([sseChunk('data: first')]))
      }
      return Promise.resolve(mockSSEResponse([sseChunk('data: second')]))
    })

    const messages: string[] = []
    const promise = fetchEventSource('http://test/sse', {
      fetch: mockFetch,
      onmessage(ev) { messages.push(ev.data) },
      onclose() {
        if (callCount === 1) throw new Error('unexpected close')
      },
    })

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)
    await promise

    expect(callCount).toBe(2)
    expect(messages).toEqual(['first', 'second'])
    vi.useRealTimers()
  })

  // ── header normalization ────────────────────────

  it('should normalize header keys to lowercase', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockSSEResponse([sseChunk('data: ok')]),
    )

    await fetchEventSource('http://test/sse', {
      fetch: mockFetch,
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    })

    const sentHeaders = mockFetch.mock.calls[0][1].headers
    expect(sentHeaders['content-type']).toBe('application/json')
    expect(sentHeaders.accept).toBe('text/event-stream')
    // No duplicate uppercase keys
    expect(sentHeaders['Content-Type']).toBeUndefined()
    expect(sentHeaders['Accept']).toBeUndefined()
  })

  it('should not add duplicate accept when user provides Accept header', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockSSEResponse([sseChunk('data: ok')]),
    )

    await fetchEventSource('http://test/sse', {
      fetch: mockFetch,
      headers: { Accept: EventStreamContentType },
    })

    const sentHeaders = mockFetch.mock.calls[0][1].headers
    const acceptKeys = Object.keys(sentHeaders).filter((k) => k.toLowerCase() === 'accept')
    expect(acceptKeys).toEqual(['accept'])
  })
})
