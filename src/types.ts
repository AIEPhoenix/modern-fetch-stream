import type { EventSourceMessage } from "eventsource-parser";

export type { EventSourceMessage };

// ---------------------------------------------------------------------------
// Enums and constants
// ---------------------------------------------------------------------------

/**
 * Describes messages delivered during the current connection attempt.
 * Updated before onMessage runs; does not acknowledge application processing.
 *
 * - `IDLE`            — no messages delivered in this attempt yet.
 * - `RECEIVED`        — a message supplied a non-empty id that has not since
 *                        been cleared by an empty id.
 * - `RECEIVED_NO_ID`  — messages arrived without establishing a non-empty id,
 *                        or a later message cleared that id.
 *
 * State resets on each attempt. A resume header from the caller or an earlier
 * attempt can still exist while state is IDLE or RECEIVED_NO_ID.
 */
export enum ReceiveState {
  IDLE = "IDLE",
  RECEIVED = "RECEIVED",
  RECEIVED_NO_ID = "RECEIVED_NO_ID",
}

/**
 * Constants returned from `classifyResponse` and `classifyError` to tell
 * the library how to proceed.
 *
 * - `Accept` — (response only) consume the response body as an SSE stream.
 * - `Retry`  — discard and reconnect using the current retry interval.
 * - `Fatal`  — stop retrying and reject the returned promise.
 */
export const FetchEventSourceDecision = {
  Accept: "accept",
  Retry: "retry",
  Fatal: "fatal",
} as const;

/**
 * Reason constants passed to `onClose`.
 *
 * - `Eof`     — the server closed the response body normally.
 * - `Aborted` — the caller cancelled via `AbortSignal`.
 */
export const FetchEventSourceCloseReason = {
  Eof: "eof",
  Aborted: "aborted",
} as const;

// ---------------------------------------------------------------------------
// Derived literal types
// ---------------------------------------------------------------------------

/** Union of all decision string values (`"accept" | "retry" | "fatal"`). */
export type FetchEventSourceDecisionValue =
  (typeof FetchEventSourceDecision)[keyof typeof FetchEventSourceDecision];

/** Union of all close reason string values (`"eof" | "aborted"`). */
export type FetchEventSourceCloseReasonValue =
  (typeof FetchEventSourceCloseReason)[keyof typeof FetchEventSourceCloseReason];

// ---------------------------------------------------------------------------
// Callback payload and decision types
// ---------------------------------------------------------------------------

/** Payload delivered to the `onClose` callback. */
export interface FetchEventSourceClose {
  /** Why the stream closed — server EOF or caller abort. */
  reason: FetchEventSourceCloseReasonValue;
  /** What the stream had delivered before it closed. */
  receiveState: ReceiveState;
}

/**
 * What `classifyError` may return.
 *
 * - `"retry"` — reconnect using the current interval.
 * - `"fatal"` — give up.
 * - `{ retryAfter: number }` — override the next delay in milliseconds;
 *   must be finite and non-negative. Does not change the server interval.
 */
export type ErrorDecision =
  | Exclude<
      FetchEventSourceDecisionValue,
      typeof FetchEventSourceDecision.Accept
    >
  | { retryAfter: number };

/**
 * What `classifyResponse` may return.
 *
 * Includes every `ErrorDecision` variant plus `"accept"`.
 */
export type ResponseDecision =
  | FetchEventSourceDecisionValue
  | { retryAfter: number };

// ---------------------------------------------------------------------------
// Init options
// ---------------------------------------------------------------------------

/**
 * Options for {@link fetchEventSource}. Extends the standard `RequestInit`
 * with SSE-specific lifecycle callbacks and retry control.
 *
 * Headers are copied before adding the `last-event-id` header on reconnection.
 */
export interface FetchEventSourceInit extends RequestInit {
  /**
   * Reusable bodies (strings, blobs, FormData, etc.) can be retried.
   * A ReadableStream, including an inherited Request body, can only be sent
   * once; a subsequent attempt rejects with FatalError without classifying it.
   */
  body?: BodyInit | null;

  /**
   * Request headers. Copied and normalized without mutating the input.
   */
  headers?: HeadersInit;

  /**
   * A custom `fetch` implementation. Defaults to `globalThis.fetch`.
   * Useful for injecting polyfills or test doubles.
   */
  fetch?: typeof globalThis.fetch;

  /**
   * By default requests wait while the page is hidden. Hiding cancels the
   * current request and retry timer; becoming visible requests a new attempt.
   * Visibility pauses do not call onClose or settle the operation.
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
   * Called after `classifyResponse` accepts the response, before the library
   * reads it. Leave its body unread and unlocked for the SSE reader.
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
   * Called on normal EOF or caller cancellation, at most once per attempt.
   * Fatal responses, runtime failures, and visibility pauses do not call it.
   *
   * For `reason: "eof"`, thrown or rejected values are routed through
   * `classifyError`. For `reason: "aborted"`, thrown or rejected values
   * reject the returned promise directly.
   * Normal EOF resolves unless this callback throws or rejects.
   * If EOF already started this callback, a later caller abort resolves
   * without invoking it again or waiting for the existing callback.
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
