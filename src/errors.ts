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
 * Wraps the original `Response` object so callers can inspect status,
 * headers, or body after the fact. Treated as fatal by the default
 * `classifyError` implementation.
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
 * Signals that the error is unrecoverable and the library should stop
 * retrying immediately. Throw this inside callbacks (e.g. `onMessage`)
 * to abort the stream.
 */
export class FatalError extends FetchEventSourceError {
  readonly code = "FATAL_ERROR";

  constructor(message = "Fatal fetchEventSource error", options?: ErrorOptions) {
    super(message, options);
  }
}

/**
 * Signals that the error is transient and the library should reconnect.
 *
 * An optional `retryAfter` (ms) overrides the current retry interval for
 * the next reconnection attempt only. When omitted, the library falls back
 * to the server-sent `retry:` interval or the 1 000 ms default.
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
