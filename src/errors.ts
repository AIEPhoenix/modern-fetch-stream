/**
 * The standard MIME type for Server-Sent Events streams,
 * used both as the default `Accept` header and for response validation.
 */
export const EventStreamContentType = "text/event-stream";

/**
 * Abstract base class for all library-defined errors.
 *
 * Every subclass carries a unique string `code` for programmatic matching.
 * `new.target.name` ensures that `error.name` always reflects the concrete
 * subclass (e.g. `"ResponseError"`) without each subclass setting it manually.
 */
export abstract class FetchEventSourceError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * An HTTP response that was not accepted by `classifyResponse`.
 *
 * The library rejects directly with this error on a fatal response decision,
 * bypassing classifyError. The caller owns the response body and should read
 * or cancel it. If thrown by a callback, it is fatal under the default error
 * policy.
 */
export class ResponseError extends FetchEventSourceError {
  readonly code = "RESPONSE_ERROR";

  constructor(
    readonly response: Response,
    message = `Unexpected response while establishing event stream: ${response.status} ${response.statusText}`.trim(),
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * Stops retrying under the default error policy when thrown by a callback.
 * A custom classifyError may choose a different policy. The library also
 * rejects directly with this error when a one-shot body cannot be replayed.
 */
export class FatalError extends FetchEventSourceError {
  readonly code = "FATAL_ERROR";

  constructor(message = "Fatal fetchEventSource error", options?: ErrorOptions) {
    super(message, options);
  }
}

/**
 * Requests reconnection under the default error policy.
 *
 * An optional `retryAfter` (ms) overrides the current retry interval for
 * the next reconnection attempt only. When omitted, the library falls back
 * to the server-sent `retry:` interval or the 1 000 ms default. A custom
 * classifyError decides whether to honor this delay. Throwing on caller
 * cancellation rejects directly rather than reconnecting.
 */
export class RetriableError extends FetchEventSourceError {
  readonly code = "RETRIABLE_ERROR";

  constructor(
    message = "Retriable fetchEventSource error",
    readonly retryAfter?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
