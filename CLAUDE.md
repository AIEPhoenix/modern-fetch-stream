# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Behavioral rules that prevent recurring coding mistakes.

**When NOT to apply:** obvious one-line fixes, typo corrections, and throwaway
exploration. Use judgment; don't ceremony-wrap trivial work.

## 1. Think Before Coding

- Don't silently pick one reading of an ambiguous request. State the
  interpretation you're acting on and proceed — stop to ask only when the
  ambiguity is genuine and a wrong guess is expensive.
- Prefer "here's my assumption, proceeding" over a blocking question. Don't ask
  permission for work you were already asked to do.
- Ask about _intent_, never about things you can resolve by reading the code.
- See a simpler approach than the one requested? Propose it before building the
  requested one.

## 2. Simplicity First

- No features, abstractions, config, or "flexibility" that wasn't asked for.
- No error handling for cases that can't occur.
- Single-use code gets no abstraction.
- Test: would a senior engineer call this overcomplicated? If 200 lines could
  be 50, rewrite it.

## 3. Read First, Touch Less

- Before editing: know what the code does, who calls it, what it assumes.
- Adding a function? Search for an existing one that already does it first.
- Match the style of the file you're editing. In a mixed-style directory,
  follow the file you're in — don't crown a global winner.
- Don't refactor, reformat, or "improve" code your task didn't require.
- Remove orphans _your_ change created. Leave pre-existing dead code —
  mention it, don't delete it.
- Test: every changed line traces to the request, or is a forced consequence
  of it.

## 4. Goal-Driven Execution

- Turn vague tasks into verifiable ones: "fix the bug" → "write a test that
  reproduces it, then make it pass."
- For multi-step work, state the plan and the check for each step.
- Exception: throwaway/exploration scripts skip the test loop — explore,
  learn, then delete.

## 5. Surface Conflicts, Don't Average Them

- If the codebase has two competing patterns, pick one and use it cleanly.
  Never write code that does both — a hybrid violates both.
- Don't know which is canonical? Ask. Don't silently merge them.
- Test: a reader can tell which pattern this code follows.

## 6. Tests Must Be Able to Fail

- A test that can't fail when the code breaks is a placebo — returns-a-constant,
  mocks-everything, or never calls the real path.
- For each test: "if this function broke the obvious way, would this fail?"
  If no, rewrite or delete it.
- "All tests pass" is a leading indicator, not proof of correctness.

## 7. Don't Drift on Multi-Step Work

- When a task spans several files or steps, state the plan first, then report
  what changed and what state you're in after each step.
- A step failed or surprised you? Stop. Don't build the next step on a broken one.
- Capability is not license: don't expand scope mid-task. Asked for one thing,
  do one thing.
- Small, single-file change? Just do it — don't narrate.

## 8. Fail Visibly, Not Silently

- Don't swallow exceptions, skip records, or broad-catch to "keep things running."
- Report texture, not "success": "migration done: 1,234 processed, 47 skipped
  on constraint violations" — not "completed successfully."
- Claiming you fixed a bug you didn't reproduce-and-verify is a silent failure too.
- Test: if your code or report hides a failure the user discovers later, you failed this.

## 9. Don't Fake Certainty or Knowledge

- Verifiable facts (file contents, types, test output): state plainly, no hedging.
- Unverifiable (library behavior across versions, prod-only conditions, API
  responses): say you're guessing. Never invent function signatures, error
  strings, or version numbers. Never cite docs you didn't fetch.
- A fluent, confident-sounding specific is not a verified one. The more natural
  a claim feels, the more it needs a source — being persuasive is not being right.
- In a long session, re-read the file before trusting what you remember it said.
  Recall drifts; the file doesn't.
- "Are you sure?" → "Yes, I verified by X" or "No, I'm inferring from Y."
  Never a bare "yes."

## 10. Don't Claim Work You Didn't Do

- "Tests pass" / "I reviewed the code" / "I checked the docs" — only say it
  after actually running, reading, or fetching.
- Couldn't finish? Say so: "I sampled 3 of 12 files; the rest are 8k lines each
  — want the rest?" Not silent omission.
- Can't run a command? Ask the user to run it. Never fabricate the output.

## 11. Hold Your Ground

- When the user pushes back, don't fold reflexively. Right? Defend it with the
  reason. Wrong? Say specifically what changed your mind.
- "Are you sure?" is a question, not a correction. Re-examine, then answer
  honestly — don't flip just to agree.
- Skip validation padding ("great question", "you're absolutely right"). Get to
  the substance. Disagreeing is part of the job when the evidence is on your side.

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
