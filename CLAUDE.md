# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`modern-fetch-stream` is a lightweight SSE (Server-Sent Events) client built on the Fetch API. It delegates SSE parsing to the spec-compliant `eventsource-parser` library. Runs anywhere `fetch` is available (browsers, Node.js 18+, Bun, Deno).

## Commands

- **Build:** `npm run build` (tsup → ESM + CJS + .d.ts in `dist/`)
- **Type check:** `npm run check` (tsc --noEmit)
- **Unit tests:** `npm run test` (vitest run)
- **Single test:** `npx vitest run __tests__/client.spec.ts`
- **Watch tests:** `npm run test:watch`
- **E2E tests:** `npm run test:e2e` (starts a Hono server in `test-server/`, runs integration tests)
- **All tests:** `npm run test:all` (unit + e2e)

## Architecture

Five source files, single entry point (`src/index.ts` barrel export):

- **`src/client.ts`** — Core `fetchEventSource()` function. A closure-based state machine inside `new Promise()` that implements the fetch → classify → stream → retry loop. Key internal state flags: `isCreating` (fetch in-flight), `pendingCreate` (retry queued), `finished` (terminal), `closeCalled` (onClose guard). Pipes `Response.body` through `TextDecoderStream` → `EventSourceParserStream`. Tracks `last-event-id` for automatic reconnection.
- **`src/types.ts`** — `FetchEventSourceInit` interface (extends `RequestInit` with SSE callbacks and classifiers), `ReceiveState` enum, `FetchEventSourceDecision` / `FetchEventSourceCloseReason` constant objects, and decision types (`ResponseDecision`, `ErrorDecision`). Re-exports `EventSourceMessage` from `eventsource-parser`.
- **`src/errors.ts`** — `EventStreamContentType` constant, abstract `FetchEventSourceError` base class (uses `new.target.name` for correct subclass naming), and three concrete errors: `ResponseError` (wraps HTTP response), `FatalError`, `RetriableError` (with optional `retryAfter`).
- **`src/visibility.ts`** — Browser page visibility handling via `visibilitychange` listener. Returns a no-op disposer in non-browser environments (`typeof document` check).
- **`src/index.ts`** — Public barrel export.

### Core flow (v1.0 API)

```
fetch → classifyResponse → onOpen → [onMessage...] → onClose({ reason, receiveState })
```

- **`classifyResponse`** decides Accept / Retry / Fatal / `{ retryAfter }` for the HTTP response.
- **`classifyError`** decides Retry / Fatal / `{ retryAfter }` for runtime failures.
- **`onClose`** receives `reason` (`"eof"` or `"aborted"`) and `ReceiveState`.
- EOF close errors route through `classifyError` (retriable); abort close errors reject directly.
- External abort via `AbortSignal` resolves the promise (does not reject).

## Key Design Decisions

- Headers are typed as `Record<string, string>` (not `HeadersInit`) so the library can mutate them to append `last-event-id` on reconnection.
- Retry/fatal decisions are split into two classifiers: `classifyResponse` (HTTP-level) and `classifyError` (runtime-level). The old `onerror` callback was removed in 1.0.
- `onMessage` can be async and is awaited serially (provides backpressure to the stream).
- External abort resolves the promise (after calling `onClose({ reason: "aborted" })`), it does not reject. But if `onClose` throws on abort, the promise rejects directly (bypasses `classifyError`).
- `NormalizedRetryDecision` / `NormalizedResponseDecision` internal types convert user-facing unions into tagged discriminants for cleaner control flow.

## Testing

- **Unit tests** (`__tests__/client.spec.ts`, 36 tests): Mock fetch returning `ReadableStream<Uint8Array>` bodies. `mockSSEResponse()` and `sseChunk()` helpers simulate SSE streams. Retry tests use `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()`. Visibility tests mock `document` with `installMockDocument()`.
- **E2E tests** (`test-server/`): A Hono server (`server.ts`) with ~11 endpoints simulating various SSE scenarios. Tests run via `tsx test-server/test.ts` using a custom harness (not vitest).

## Only Dependency

`eventsource-parser` — SSE parsing. Everything else is devDependencies (TypeScript, vitest, tsup).
