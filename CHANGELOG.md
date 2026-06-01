# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-06-02

A bug-fix release focused on the connection state machine: every settle path,
abort race, and resource handle was audited and tightened. No public API
changes; existing code keeps working.

### Fixed

- **Connection leak on errors during a live stream.** When `onMessage`,
  `onOpen`, or `classifyResponse` threw after the response had been accepted,
  the underlying HTTP stream was dropped without being cancelled and stayed
  open until garbage collection. The read loop now cancels the reader (which
  propagates upstream to the response body) before letting the error route
  through `classifyError`.
- **`onClose` on EOF could deadlock the promise.** If a user-supplied
  `onClose` threw on an EOF close and a retry was queued, a subsequent
  external abort was silently swallowed by an internal `closeCalled` guard:
  the retry timer kept firing, `onClose` never re-ran, and the returned
  promise hung forever. The abort path now always tears down cleanly,
  invoking `onClose` at most once per connection attempt.
- **`onOpen` could fire on a stream the caller had already cancelled.** When
  an external abort or page-visibility pause landed during an async
  `classifyResponse` that returned `accept`, the read loop would still
  proceed into `onOpen` (and could ghost-fire `onMessage` after the returned
  promise had resolved). The library now re-checks the abort/finished state
  after every awaited user hook before continuing.
- **`ResponseError.response.body` is now actually readable.** The fatal-
  response path used to abort the fetch controller before rejecting, which
  errors the body under native `fetch` semantics and made
  `await error.response.text()` throw. The library now hands the response off
  to the caller intact; ownership of the body transfers with the error.
- **Stale errors could race past an in-flight abort.** When an external abort
  landed while an async `classifyError` was still resolving, the late fatal
  verdict could reject the promise after the abort had already resolved it.
  Every settle entry point now checks the terminal flag before committing.
- **Default `Content-Type` check no longer over-matches.** The previous
  `startsWith("text/event-stream")` check would accept look-alike media
  types such as `text/event-streamevil`. The check now parses the media
  type boundary (case-insensitive, parameters stripped) and compares
  exactly.

### Added

- **`engines.node >= 18`** in `package.json` so npm warns users on
  unsupported Node versions; the library depends on `fetch`,
  `ReadableStream`, and `TextDecoderStream`, all of which stabilized in
  Node 18.
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
</content>
</invoke>