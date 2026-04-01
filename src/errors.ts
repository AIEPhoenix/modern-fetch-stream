/**
 * The standard MIME type for Server-Sent Events streams,
 * used both as the default `Accept` header and for response validation.
 */
export const EventStreamContentType = "text/event-stream";

export abstract class FetchEventSourceError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

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

export class FatalError extends FetchEventSourceError {
  readonly code = "FATAL_ERROR";

  constructor(message = "Fatal fetchEventSource error", options?: ErrorOptions) {
    super(message, options);
  }
}

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
