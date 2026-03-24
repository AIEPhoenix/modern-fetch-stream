# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`modern-fetch-stream` is a lightweight SSE (Server-Sent Events) client built on the Fetch API. It is API-compatible with `@microsoft/fetch-event-source` but delegates SSE parsing to the spec-compliant `eventsource-parser` library. Runs anywhere `fetch` is available (browsers, Node.js 18+, Bun, Deno).

## Commands

- **Build:** `npm run build` (uses tsup, outputs ESM + CJS + .d.ts to `dist/`)
- **Type check:** `npm run check` (tsc --noEmit)
- **Run all tests:** `npm run test` (vitest run)
- **Run a single test:** `npx vitest run __tests__/client.spec.ts`
- **Watch tests:** `npm run test:watch`

## Architecture

The codebase is small (~5 source files) with a single entry point:

- **`src/client.ts`** — Core `fetchEventSource()` function. Implements the fetch → parse → retry loop. Uses `EventSourceParserStream` from `eventsource-parser/stream` to pipe raw bytes through `TextDecoderStream` → SSE parser. Handles automatic reconnection with `last-event-id` tracking and configurable retry intervals.
- **`src/types.ts`** — `FetchEventSourceInit` interface (extends `RequestInit` with SSE callbacks: `onopen`, `onmessage`, `onclose`, `onerror`) and `ReceiveState` enum. Re-exports `EventSourceMessage` from `eventsource-parser`.
- **`src/errors.ts`** — Exports the `EventStreamContentType` constant (`'text/event-stream'`).
- **`src/visibility.ts`** — Browser page visibility handling. No-ops in non-browser environments via `typeof document` check.
- **`src/index.ts`** — Public barrel export.

## Key Design Decisions

- Headers are typed as `Record<string, string>` (not `HeadersInit`) so the library can mutate them to append `last-event-id` on reconnection.
- `onerror` controls retry: return a number for custom interval, return nothing for default (1s), throw to abort permanently.
- `onclose` receives a `ReceiveState` parameter indicating whether any messages (with or without IDs) were received before the stream closed.
- Tests use a mock fetch that returns `ReadableStream<Uint8Array>` bodies to simulate SSE streams. Retry tests use `vi.useFakeTimers()`.

## Only Dependency

`eventsource-parser` — SSE parsing. Everything else is devDependencies (TypeScript, vitest, tsup).
