# modern-fetch-stream

[![npm version](https://img.shields.io/npm/v/modern-fetch-stream)](https://www.npmjs.com/package/modern-fetch-stream)
[![npm downloads](https://img.shields.io/npm/dm/modern-fetch-stream)](https://www.npmjs.com/package/modern-fetch-stream)
[![bundle size](https://img.shields.io/bundlephobia/minzip/modern-fetch-stream)](https://bundlephobia.com/package/modern-fetch-stream)
[![license](https://img.shields.io/npm/l/modern-fetch-stream)](https://github.com/AIEPhoenix/modern-fetch-stream/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-ready-blue)](https://www.typescriptlang.org/)

A lightweight Server-Sent Events client built on the Fetch API with automatic reconnection, `last-event-id` tracking, and explicit response / error classification.

SSE parsing is delegated to the spec-compliant [`eventsource-parser`](https://github.com/rexxars/eventsource-parser).

## Why

The native [`EventSource`](https://developer.mozilla.org/en-US/docs/Web/API/EventSource) API is limited: GET only, no custom headers, no request body, and very little control over retry strategy.

`modern-fetch-stream` keeps the good parts of fetch-based SSE clients while making retry semantics explicit:

- **Use `fetch` directly** for POST requests, custom headers, and request bodies.
- **Classify responses separately from runtime errors** with `classifyResponse` and `classifyError`.
- **Throw `FatalError` / `RetriableError`** when you want the library to handle retry semantics for you.
- **Run anywhere `fetch` exists**: browsers, Node.js 18+, Bun, and Deno.

## Install

```bash
npm install modern-fetch-stream
```

## Quick start

```ts
import {
  FatalError,
  FetchEventSourceDecision,
  RetriableError,
  fetchEventSource,
} from 'modern-fetch-stream'

await fetchEventSource('/api/chat', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: 'Bearer sk-...',
  },
  body: JSON.stringify({ prompt: 'Hello' }),

  classifyResponse(response) {
    if (response.ok) return FetchEventSourceDecision.Accept

    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      return FetchEventSourceDecision.Fatal
    }

    return FetchEventSourceDecision.Retry
  },

  onOpen(response) {
    console.log('stream opened', response.status)
  },

  onMessage(event) {
    console.log(event.data)
  },

  onClose() {
    console.log('stream ended')
  },

  classifyError(error) {
    if (error instanceof FatalError) return FetchEventSourceDecision.Fatal
    if (error instanceof RetriableError) return { retryAfter: error.retryAfter ?? 1000 }
    return FetchEventSourceDecision.Retry
  },
})
```

## API

### `fetchEventSource(input, init): Promise<void>`

| Parameter | Type | Description |
|-----------|------|-------------|
| `input` | `RequestInfo \| URL` | The resource to fetch. |
| `init` | `FetchEventSourceInit` | Fetch options extended with SSE callbacks and classifiers. |

### `FetchEventSourceInit`

Extends the standard [`RequestInit`](https://developer.mozilla.org/en-US/docs/Web/API/RequestInit) with the following:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `headers` | `Record<string, string>` | `{}` | Request headers. `accept: text/event-stream` is added automatically. |
| `fetch` | `typeof fetch` | `globalThis.fetch` | Custom fetch implementation. |
| `openWhenHidden` | `boolean` | `false` | Keep the connection alive when the page is hidden. |
| `classifyResponse` | `(response) => ResponseDecision` | Accept only `2xx` `text/event-stream` responses | Decides whether a newly received response should be accepted, retried, or treated as fatal. |
| `onOpen` | `(response) => void \| Promise<void>` | — | Called after `classifyResponse` accepts the response and before the body is consumed. |
| `onMessage` | `(event) => void \| Promise<void>` | — | Called for every SSE message, including custom event types. Async handlers are awaited serially. |
| `onClose` | `(receiveState) => void \| Promise<void>` | — | Called when the stream closes gracefully. Throw to route the close through `classifyError`. |
| `classifyError` | `(error, receiveState) => ErrorDecision` | Retry generic errors; fatal for `ResponseError` / `FatalError`; retry for `RetriableError` | Decides whether an error should be retried or treated as fatal. |

### Error classes

The library exports four error classes:

```ts
import {
  FetchEventSourceError,
  ResponseError,
  FatalError,
  RetriableError,
} from 'modern-fetch-stream'
```

- `FetchEventSourceError`: base class for library-defined errors.
- `ResponseError`: wraps a rejected HTTP response and exposes `response`.
- `FatalError`: default fatal classification.
- `RetriableError`: default retriable classification and optional `retryAfter`.

### Decision constants

```ts
import { FetchEventSourceDecision } from 'modern-fetch-stream'

FetchEventSourceDecision.Accept // "accept"
FetchEventSourceDecision.Retry  // "retry"
FetchEventSourceDecision.Fatal  // "fatal"
```

```ts
type ErrorDecision =
  | typeof FetchEventSourceDecision.Retry
  | typeof FetchEventSourceDecision.Fatal
  | { retryAfter: number }

type ResponseDecision =
  | typeof FetchEventSourceDecision.Accept
  | ErrorDecision
```

## Response classification

Use `classifyResponse` when retry policy depends on the HTTP response itself:

```ts
await fetchEventSource('/api/stream', {
  classifyResponse(response) {
    if (response.ok) return FetchEventSourceDecision.Accept

    if (response.status === 429) {
      return { retryAfter: 5000 }
    }

    if (response.status >= 400 && response.status < 500) {
      return FetchEventSourceDecision.Fatal
    }

    return FetchEventSourceDecision.Retry
  },
})
```

When a response is rejected, the promise rejects or retries with a `ResponseError`.

## Error classification

Use `classifyError` when retry policy depends on runtime failures or exceptions thrown or rejected inside callbacks:

```ts
await fetchEventSource('/api/stream', {
  onClose() {
    throw new RetriableError('server closed early', 250)
  },

  classifyError(error, receiveState) {
    if (receiveState === 'IDLE') {
      return { retryAfter: 2000 }
    }

    if (error instanceof FatalError) {
      return FetchEventSourceDecision.Fatal
    }

    return FetchEventSourceDecision.Retry
  },
})
```

If you omit `classifyError`, the defaults are:

- `ResponseError` -> fatal
- `FatalError` -> fatal
- `RetriableError` -> retry, using `retryAfter` when provided
- every other error -> retry

## Reconnection

On each retry the library automatically sends the `last-event-id` header with the id of the most recently received message, allowing the server to resume from where it left off.

The server can also control the retry interval by including a `retry` field in the event stream:

```text
retry: 3000
data: hello
```

If your own `classifyError` or `RetriableError` does not specify `retryAfter`, the latest server-provided retry interval is used.

## Page visibility

In browsers, the connection is closed when the page becomes hidden and re-established when it becomes visible again. Set `openWhenHidden: true` to disable this behavior.

This feature is skipped automatically in non-browser environments.

## License

MIT
