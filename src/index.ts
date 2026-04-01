/**
 * Public API surface of `modern-fetch-stream`.
 *
 * Re-exports the core function, error classes, constant objects, and all
 * relevant TypeScript types from the internal modules.
 *
 * @packageDocumentation
 */

export { fetchEventSource } from "./client";
export {
  EventStreamContentType,
  FatalError,
  FetchEventSourceError,
  ResponseError,
  RetriableError,
} from "./errors";
export {
  FetchEventSourceCloseReason,
  FetchEventSourceDecision,
  ReceiveState,
} from "./types";
export type {
  ErrorDecision,
  EventSourceMessage,
  FetchEventSourceClose,
  FetchEventSourceCloseReasonValue,
  FetchEventSourceInit,
  FetchEventSourceDecisionValue,
  ResponseDecision,
} from "./types";
