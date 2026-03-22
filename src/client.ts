import { EventSourceParserStream } from 'eventsource-parser/stream'
import { EventStreamContentType } from './errors'
import { setupVisibility } from './visibility'
import type { FetchEventSourceInit } from './types'

const DefaultRetryInterval = 1000
const LastEventId = 'last-event-id'

/**
 * A drop-in replacement for the browser `EventSource` API that uses the
 * Fetch API under the hood, giving you full control over the request
 * (method, headers, body) while retaining automatic reconnection and
 * `last-event-id` tracking.
 *
 * SSE parsing is delegated to
 * [`eventsource-parser`](https://github.com/rexxars/eventsource-parser),
 * a spec-compliant, streaming SSE parser.
 *
 * The API surface is intentionally identical to
 * [`@microsoft/fetch-event-source`](https://github.com/Azure/fetch-event-source)
 * so that migration requires no code changes beyond swapping the import.
 *
 * @param input - The resource to fetch (URL string, `Request`, or `URL`).
 * @param init  - Fetch options extended with SSE lifecycle callbacks.
 * @returns A promise that resolves when the stream closes cleanly, or
 *          rejects when an unrecoverable error occurs.
 */
export function fetchEventSource(
  input: RequestInfo | URL,
  {
    signal: inputSignal,
    headers: inputHeaders,
    onopen: inputOnOpen,
    onmessage,
    onclose,
    onerror,
    openWhenHidden,
    fetch: inputFetch,
    ...rest
  }: FetchEventSourceInit,
) {
  return new Promise<void>((resolve, reject) => {
    // Copy headers so we can safely mutate (e.g. appending last-event-id).
    const headers = { ...inputHeaders }
    if (!headers.accept) {
      headers.accept = EventStreamContentType
    }

    let curRequestController: AbortController
    let retryInterval = DefaultRetryInterval
    let retryTimer = 0

    // In browser environments, close the connection when the page is hidden
    // and reopen it when the page becomes visible again — unless the caller
    // explicitly opts out via `openWhenHidden`.
    const disposeVisibility = openWhenHidden
      ? () => {}
      : setupVisibility(
          () => curRequestController.abort(),
          () => create(),
        )

    /** Release all held resources: visibility listener, retry timer, request. */
    function dispose() {
      disposeVisibility()
      clearTimeout(retryTimer)
      curRequestController.abort()
    }

    // If the caller-provided signal fires, tear everything down silently.
    inputSignal?.addEventListener('abort', () => {
      dispose()
      resolve()
    })

    const fetch = inputFetch ?? globalThis.fetch
    const onopen = inputOnOpen ?? defaultOnOpen

    /**
     * Core connection loop. Each invocation represents a single
     * fetch → consume → close cycle. On retriable errors the function
     * schedules itself to run again after `retryInterval` ms.
     */
    async function create() {
      curRequestController = new AbortController()
      try {
        const response = await fetch(input, {
          ...rest,
          headers,
          signal: curRequestController.signal,
        })

        await onopen(response)

        // Build the streaming pipeline:
        //   raw bytes → text chunks → parsed SSE messages
        const eventStream = response.body!
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(
            new EventSourceParserStream({
              onRetry(ms) {
                retryInterval = ms
              },
            }),
          )

        // Consume messages one by one.
        const reader = eventStream.getReader()
        try {
          for (;;) {
            const { done, value: event } = await reader.read()
            if (done) break

            // Track the last event id so it can be sent back on reconnection,
            // allowing the server to resume from where it left off.
            if (event.id !== undefined) {
              if (event.id) {
                headers[LastEventId] = event.id
              } else {
                delete headers[LastEventId]
              }
            }

            onmessage?.(event)
          }
        } finally {
          reader.releaseLock()
        }

        // Stream ended cleanly — notify the caller and resolve.
        onclose?.()
        dispose()
        resolve()
      } catch (err) {
        // If we aborted the request ourselves (visibility change, caller
        // signal, etc.) there is nothing to retry — just bail out.
        if (!curRequestController.signal.aborted) {
          try {
            // Let the caller decide the retry interval. Returning a number
            // overrides the default; returning nothing keeps it; throwing
            // aborts the whole operation.
            const interval: any = onerror?.(err) ?? retryInterval
            clearTimeout(retryTimer)
            retryTimer = setTimeout(create, interval) as any
          } catch (innerErr) {
            dispose()
            reject(innerErr)
          }
        }
      }
    }

    create()
  })
}

/**
 * Default response validator — ensures the server actually sent an
 * event stream rather than, say, an HTML error page.
 */
function defaultOnOpen(response: Response) {
  const contentType = response.headers.get('content-type')
  if (!contentType?.startsWith(EventStreamContentType)) {
    throw new Error(
      `Expected content-type to be ${EventStreamContentType}, Actual: ${contentType}`,
    )
  }
}
