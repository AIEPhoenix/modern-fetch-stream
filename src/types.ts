import type { EventSourceMessage } from 'eventsource-parser'

export type { EventSourceMessage }

/**
 * Describes the data receive state of the SSE stream at close time.
 *
 * - `IDLE`            — connection opened but no messages received yet.
 * - `RECEIVED`        — at least one message carried an `id`; `last-event-id` is set.
 * - `RECEIVED_NO_ID`  — messages were received but `last-event-id` is unset
 *                        (either no message had an `id`, or it was explicitly cleared
 *                        by the server sending an empty `id:` field).
 */
export enum ReceiveState {
  IDLE = 'IDLE',
  RECEIVED = 'RECEIVED',
  RECEIVED_NO_ID = 'RECEIVED_NO_ID',
}

/**
 * Options for {@link fetchEventSource}. Extends the standard `RequestInit`
 * with SSE-specific lifecycle callbacks and retry control.
 *
 * Headers are narrowed to `Record<string, string>` so the library can
 * transparently append the `last-event-id` header on reconnection.
 */
export interface FetchEventSourceInit extends Omit<RequestInit, 'headers'> {
  /**
   * Request headers. Only the `Record<string, string>` form is accepted
   * because the library may append `last-event-id` for automatic resumption.
   */
  headers?: Record<string, string>

  /**
   * A custom `fetch` implementation. Defaults to `globalThis.fetch`.
   * Useful for injecting polyfills or test doubles.
   */
  fetch?: typeof globalThis.fetch

  /**
   * Called once the response is received, before the body is consumed.
   * Use this to validate the response (status code, headers, etc.) and
   * throw if it does not match expectations. If omitted, a default
   * validator asserts that the content-type is `text/event-stream`.
   */
  onopen?: (response: Response) => void | Promise<void>

  /**
   * Called for every SSE message, regardless of its `event` type.
   * This differs from the native `EventSource.onmessage`, which only
   * fires for events without a custom type.
   */
  onmessage?: (ev: EventSourceMessage) => void

  /**
   * Called when the response stream closes gracefully. If you do not
   * expect the server to end the connection, throw inside this callback
   * to trigger a retry via `onerror`.
   *
   * The parameter is the final {@link StreamStatus} at the time of close.
   */
  onclose?: (receiveState: ReceiveState) => void

  /**
   * Called on any error — network failures, non-2xx responses, stream
   * interruptions, or exceptions thrown by other callbacks. Controls
   * the retry strategy:
   *
   * - **Return a number** — retry after that many milliseconds.
   * - **Return nothing** — retry after the current `retryInterval` (1 s by default,
   *   overridable by the server via the SSE `retry` field).
   * - **Rethrow / throw** — abort permanently; the returned promise rejects.
   *
   * When this callback is omitted, every error is treated as retriable.
   *
   * The second parameter is the current {@link ReceiveState}.
   */
  onerror?: (err: any, receiveState: ReceiveState) => number | undefined | void

  /**
   * By default the connection is closed when the page becomes hidden
   * and re-established when it becomes visible again (browser only).
   * Set this to `true` to keep the connection alive regardless of
   * visibility state. Has no effect in non-browser environments.
   */
  openWhenHidden?: boolean
}
