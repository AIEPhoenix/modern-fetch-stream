import type { EventSourceMessage } from "eventsource-parser";

export type { EventSourceMessage };

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
  IDLE = "IDLE",
  RECEIVED = "RECEIVED",
  RECEIVED_NO_ID = "RECEIVED_NO_ID",
}

export const FetchEventSourceDecision = {
  Accept: "accept",
  Retry: "retry",
  Fatal: "fatal",
} as const;

export const FetchEventSourceCloseReason = {
  Eof: "eof",
  Aborted: "aborted",
} as const;

export type FetchEventSourceDecisionValue =
  (typeof FetchEventSourceDecision)[keyof typeof FetchEventSourceDecision];

export type FetchEventSourceCloseReasonValue =
  (typeof FetchEventSourceCloseReason)[keyof typeof FetchEventSourceCloseReason];

export interface FetchEventSourceClose {
  reason: FetchEventSourceCloseReasonValue;
  receiveState: ReceiveState;
}

export type ErrorDecision =
  | Exclude<
      FetchEventSourceDecisionValue,
      typeof FetchEventSourceDecision.Accept
    >
  | { retryAfter: number };

export type ResponseDecision =
  | FetchEventSourceDecisionValue
  | { retryAfter: number };

/**
 * Options for {@link fetchEventSource}. Extends the standard `RequestInit`
 * with SSE-specific lifecycle callbacks and retry control.
 *
 * Headers are narrowed to `Record<string, string>` so the library can
 * transparently append the `last-event-id` header on reconnection.
 */
export interface FetchEventSourceInit extends Omit<RequestInit, "headers"> {
  /**
   * Request headers. Only the `Record<string, string>` form is accepted
   * because the library may append `last-event-id` for automatic resumption.
   */
  headers?: Record<string, string>;

  /**
   * A custom `fetch` implementation. Defaults to `globalThis.fetch`.
   * Useful for injecting polyfills or test doubles.
   */
  fetch?: typeof globalThis.fetch;

  /**
   * By default the connection is closed when the page becomes hidden
   * and re-established when it becomes visible again (browser only).
   * Set this to `true` to keep the connection alive regardless of
   * visibility state. Has no effect in non-browser environments.
   */
  openWhenHidden?: boolean;

  /**
   * Decide whether a freshly received response should be accepted,
   * retried, or treated as fatal before the body is consumed.
   *
   * If omitted, the library accepts only `2xx` `text/event-stream`
   * responses and rejects every other response as fatal.
   */
  classifyResponse?: (
    response: Response,
  ) => ResponseDecision | Promise<ResponseDecision>;

  /**
   * Called after `classifyResponse` accepts the response, right before
   * the response body starts streaming.
   */
  onOpen?: (response: Response) => void | Promise<void>;

  /**
   * Called for every SSE message, regardless of its `event` type.
   * This differs from the native `EventSource.onmessage`, which only
   * fires for events without a custom type.
   *
   * Async handlers are awaited serially, so message processing preserves
   * stream order and rejected promises are routed through `classifyError`.
   */
  onMessage?: (ev: EventSourceMessage) => void | Promise<void>;

  /**
   * Called when the SSE request closes.
   *
   * For `reason: "eof"`, thrown or rejected values are routed through
   * `classifyError`. For `reason: "aborted"`, thrown or rejected values
   * reject the returned promise directly.
   *
   * The callback receives the close reason and the final
   * {@link ReceiveState} at the time of close.
   */
  onClose?: (close: FetchEventSourceClose) => void | Promise<void>;

  /**
   * Decide whether an error should be retried or treated as fatal.
   *
   * If omitted, the library retries ordinary errors, treats
   * `RetriableError` as retriable, and treats `FatalError` /
   * `ResponseError` as fatal.
   */
  classifyError?: (
    err: unknown,
    receiveState: ReceiveState,
  ) => ErrorDecision | Promise<ErrorDecision>;
}
