import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchEventSource, EventStreamContentType } from '../src/index'

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
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer x')
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
})
