# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Stop delivering buffered messages after cancellation and release the stream pipeline.
- Ignore stale error-classifier results when a visibility pause cancels their connection.
- Release response bodies when response classification throws before a retry.
- Accept `signal: null` consistently with `RequestInit`.
- Reject retries of one-shot request bodies with `FatalError` instead of repeatedly sending an unusable body.
- Resolve CommonJS TypeScript consumers to the generated `.d.cts` entry.

### Added

- Support `Headers` and tuple arrays in `init.headers`.
- Build before packing and verify packed ESM/CJS runtime and type entry points.
- Run validation in CI on Node.js 18, 20, 22, and 24.

## [1.0.1] - 2026-06-02

A bug-fix release addressing cancellation races and response-body cleanup,
without changing the public API.

### Fixed

- **Response cleanup after callback failures.** Cancel the response body when
  `onOpen` throws, and cancel the reader when a read or `onMessage` fails,
  before routing the error through `classifyError`. Cleanup for exceptions in
  `classifyResponse` is listed separately under Unreleased.
- **`onClose` on EOF could deadlock the promise.** If a user-supplied
  `onClose` threw on an EOF close and a retry was queued, a subsequent
  external abort was silently swallowed by an internal `closeCalled` guard:
  the retry timer kept firing, `onClose` never re-ran, and the returned
  promise hung forever. The abort path now always tears down cleanly,
  invoking `onClose` at most once per connection attempt.
- **`onOpen` could fire on a stream the caller had already cancelled.** When
  an external abort or page-visibility pause landed during an async
  `classifyResponse` that returned `accept`, the read loop would still
  proceed into `onOpen`. Re-check the abort state after `classifyResponse`
  and `onOpen` before starting the next phase. Suppressing buffered messages
  after cancellation during `onMessage` is listed under Unreleased.
- **`ResponseError.response.body` is now actually readable.** The fatal-
  response path used to abort the fetch controller before rejecting, which
  errors the body under native `fetch` semantics and made
  `await error.response.text()` throw. The library now hands the response off
  to the caller intact; ownership of the body transfers with the error.
- **Stale errors could race past an in-flight abort.** When an external abort
  landed while an async `classifyError` was still resolving, the late fatal
  verdict could reject the promise while the abort path was awaiting
  `onClose`. The fatal rejection helpers now check the terminal flag so that
  stale errors do not override caller cancellation.
- **Default `Content-Type` check no longer over-matches.** The previous
  `startsWith("text/event-stream")` check would accept look-alike media
  types such as `text/event-streamevil`. The check now parses the media
  type boundary (case-insensitive, parameters stripped) and compares
  exactly.

### Added

- **`engines.node >= 18`** in `package.json` to declare the minimum Node.js
  version. The client uses the runtime's Fetch and Web Streams APIs.
- **`src/` is now published in the tarball** so the shipped source maps
  resolve to real files.
- **Documented `Request`-input reconnection caveat.** A `Request` with a
  body cannot be replayed across reconnection attempts under native
  `fetch`. The README now recommends passing a URL plus `body` instead for
  POST/PUT streams that should auto-reconnect.

### Notes

- `retryInterval` deliberately persists across reconnections once a server
  sends a `retry:` field, matching the `EventSource` specification. This is
  now called out in the source.
- No public API changes. Internal helpers (`rejectKeepingResponse`, extra
  abort re-checks) are not exported.
