# modern-fetch-stream

A lightweight Server-Sent Events client built on the Fetch API. API-compatible with [`@microsoft/fetch-event-source`](https://github.com/Azure/fetch-event-source), with SSE parsing delegated to the spec-compliant [`eventsource-parser`](https://github.com/rexxars/eventsource-parser).

## Why

The native [`EventSource`](https://developer.mozilla.org/en-US/docs/Web/API/EventSource) API is limited — GET only, no custom headers, no request body. `@microsoft/fetch-event-source` solves this by wrapping `fetch`, but it ships its own SSE parser and relies on browser globals (`document`, `window`), making it unsuitable for Node.js without polyfills.

This library keeps the same ergonomic API while:

- **Replacing the hand-rolled parser** with `eventsource-parser`, a well-tested, community-maintained SSE parser.
- **Running anywhere `fetch` is available** — browsers, Node.js 18+, Bun, Deno — by guarding browser-specific APIs behind runtime checks.

## Install

```bash
npm install modern-fetch-stream
```

## Quick start

```ts
import { fetchEventSource } from 'modern-fetch-stream'

const ctrl = new AbortController()

await fetchEventSource('/api/chat', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer sk-...',
  },
  body: JSON.stringify({ prompt: 'Hello' }),
  signal: ctrl.signal,

  onopen(response) {
    // Validate the response before consuming the body.
    // Throw here to trigger onerror and retry.
  },

  onmessage(event) {
    console.log(event.data)
  },

  onclose() {
    console.log('Stream ended')
  },

  onerror(err) {
    // Return a number to override the retry interval (ms).
    // Return nothing to use the default interval (1 s).
    // Throw to stop retrying entirely.
  },
})
```

## API

### `fetchEventSource(input, init): Promise<void>`

| Parameter | Type | Description |
|-----------|------|-------------|
| `input` | `RequestInfo \| URL` | The resource to fetch. |
| `init` | `FetchEventSourceInit` | Fetch options extended with SSE callbacks. |

### `FetchEventSourceInit`

Extends the standard [`RequestInit`](https://developer.mozilla.org/en-US/docs/Web/API/RequestInit) with the following:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `headers` | `Record<string, string>` | `{}` | Request headers. `accept: text/event-stream` is added automatically. |
| `fetch` | `typeof fetch` | `globalThis.fetch` | Custom fetch implementation. |
| `onopen` | `(res: Response) => void \| Promise<void>` | Validates content-type | Called once the response is received, before the body is consumed. |
| `onmessage` | `(ev: EventSourceMessage) => void` | — | Called for every SSE message, including custom event types. |
| `onclose` | `() => void` | — | Called when the stream closes gracefully. |
| `onerror` | `(err: any) => number \| void` | Retry with default interval | Controls retry behavior. See [Error handling](#error-handling). |
| `openWhenHidden` | `boolean` | `false` | Keep the connection alive when the page is hidden. |

### `EventStreamContentType`

The string constant `'text/event-stream'`, re-exported for convenience.

### `EventSourceMessage`

Re-exported from `eventsource-parser`:

```ts
interface EventSourceMessage {
  event?: string
  data: string
  id?: string
}
```

## Error handling

The `onerror` callback determines what happens when something goes wrong — network failures, unexpected status codes, stream interruptions, or exceptions thrown in other callbacks.

```ts
onerror(err) {
  if (err instanceof Response && err.status === 401) {
    throw err // Fatal — stop retrying.
  }
  return 5000 // Retry after 5 seconds.
}
```

| Return value | Behavior |
|-------------|----------|
| A number | Retry after that many milliseconds. |
| `undefined` / `void` | Retry after the current interval (default 1 s, overridable by the server's `retry` field). |
| *(throw)* | Abort permanently. The returned promise rejects with the thrown value. |

When `onerror` is not provided, **every error is retried** with the default interval.

## Reconnection

On each retry the library automatically sends the `last-event-id` header with the id of the most recently received message, allowing the server to resume from where it left off — exactly as specified by the [SSE standard](https://html.spec.whatwg.org/multipage/server-sent-events.html#the-last-event-id-header).

The server can also control the retry interval by including a `retry` field in the event stream:

```
retry: 3000
data: hello
```

## Page visibility

In browsers, the connection is closed when the page becomes hidden and re-established when it becomes visible — conserving server resources for inactive tabs. Set `openWhenHidden: true` to disable this behavior.

This feature is automatically skipped in non-browser environments.

## License

MIT
