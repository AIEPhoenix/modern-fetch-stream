import { EventSourceParserStream } from "eventsource-parser/stream";
import {
  EventStreamContentType,
  FatalError,
  ResponseError,
  RetriableError,
} from "./errors";
import type {
  ErrorDecision,
  FetchEventSourceClose,
  FetchEventSourceInit,
  ResponseDecision,
} from "./types";
import {
  FetchEventSourceCloseReason,
  FetchEventSourceDecision,
  ReceiveState,
} from "./types";
import { setupVisibility } from "./visibility";

/** Default reconnection delay (ms) when no server-sent `retry:` is present. */
const DefaultRetryInterval = 1000;

/** Header name used for SSE stream resumption across reconnections. */
const LastEventId = "last-event-id";

// ---------------------------------------------------------------------------
// Internal decision types — normalize the user-facing union into a tagged
// discriminant so the rest of the code can use simple `.type` checks.
// ---------------------------------------------------------------------------

type NormalizedRetryDecision =
  | { type: "fatal" }
  | { type: "retry"; retryAfter?: number };

type NormalizedResponseDecision =
  | { type: "accept" }
  | NormalizedRetryDecision;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch-based SSE client with automatic reconnection, `last-event-id`
 * tracking, and pluggable response / error classification.
 *
 * SSE parsing is delegated to
 * [`eventsource-parser`](https://github.com/rexxars/eventsource-parser),
 * a spec-compliant, streaming SSE parser.
 *
 * @param input - The resource to fetch (URL string, `Request`, or `URL`).
 * @param init  - Fetch options extended with SSE lifecycle callbacks.
 * @returns A promise that resolves when the stream closes cleanly, or
 *          rejects when an unrecoverable error occurs.
 */
export function fetchEventSource(
  input: RequestInfo | URL,
  {
    signal: inputSignal,
    headers: inputHeaders,
    fetch: inputFetch,
    openWhenHidden,
    classifyResponse: inputClassifyResponse,
    onOpen,
    onMessage,
    onClose,
    classifyError: inputClassifyError,
    ...rest
  }: FetchEventSourceInit = {},
) {
  return new Promise<void>((resolve, reject) => {
    // -----------------------------------------------------------------------
    // Header normalization
    // -----------------------------------------------------------------------
    // Merge headers from a `Request` object (if any) and explicit `headers`
    // into a mutable record so we can append `last-event-id` on reconnect.
    const headers: Record<string, string> = {};
    copyHeaders(headers, input instanceof Request ? input.headers : undefined);
    copyHeaders(headers, inputHeaders);
    if (!headers.accept) {
      headers.accept = EventStreamContentType;
    }

    // -----------------------------------------------------------------------
    // Mutable state — lives inside the promise closure.
    //
    // These flags form a lightweight state machine that guards against race
    // conditions between concurrent abort signals, visibility changes,
    // retry timers, and the streaming read loop.
    // -----------------------------------------------------------------------

    /** AbortController for the *current* in-flight fetch request. */
    let curRequestController: AbortController | undefined;
    /** Active retry interval (ms). Updated by server-sent `retry:` fields. */
    let retryInterval = DefaultRetryInterval;
    /** Handle for a pending `setTimeout`-based retry. */
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    /** Tracks what kind of messages the stream has delivered so far. */
    let receiveState: ReceiveState = ReceiveState.IDLE;
    /** True while `create()` is executing (prevents re-entrant calls). */
    let isCreating = false;
    /** True when a new `create()` call has been requested but not yet started. */
    let pendingCreate = false;
    /** Terminal flag — once true, no further side-effects are allowed. */
    let finished = false;
    /** Guards `onClose` so it fires at most once per connection attempt. */
    let closeCalled = false;

    // -----------------------------------------------------------------------
    // External abort signal handling
    // -----------------------------------------------------------------------
    // Collect signals from both a `Request` input and explicit `signal` option.
    const externalSignals = [
      input instanceof Request ? input.signal : undefined,
      inputSignal,
    ].filter((signal): signal is AbortSignal => signal !== undefined);

    // -----------------------------------------------------------------------
    // Cleanup helpers
    // -----------------------------------------------------------------------

    function clearRetryTimer() {
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
    }

    function abortCurrentRequest() {
      curRequestController?.abort();
      curRequestController = undefined;
    }

    /** Returns `true` when the page is hidden and we should defer connecting. */
    function shouldWaitForVisibility() {
      return (
        !openWhenHidden && typeof document !== "undefined" && document.hidden
      );
    }

    /**
     * Transition to the terminal state. Tears down every side-effect:
     * timers, visibility listeners, abort listeners, and the active request.
     */
    function stop() {
      if (finished) return;

      finished = true;
      pendingCreate = false;
      clearRetryTimer();
      disposeVisibility();
      for (const removeListener of removeAbortListeners) {
        removeListener();
      }
      abortCurrentRequest();
    }

    // -----------------------------------------------------------------------
    // Promise settlement — each path calls `stop()` first, ensuring
    // exactly-once resolution/rejection.
    // -----------------------------------------------------------------------

    /** Resolve the outer promise (used for silent EOF after `onClose`). */
    function resolveOnce() {
      stop();
      resolve();
    }

    /**
     * Resolve via the `onClose` callback (used for external abort).
     *
     * If `onClose` itself throws, the promise rejects with that error —
     * abort-path errors bypass `classifyError` intentionally.
     */
    async function resolveClosed(close: FetchEventSourceClose) {
      if (finished || closeCalled) return;
      closeCalled = true;
      stop();

      try {
        await onClose?.(close);
        resolve();
      } catch (error) {
        reject(error);
      }
    }

    /** Reject the outer promise with a fatal error. */
    function rejectOnce(error: unknown) {
      stop();
      reject(error);
    }

    // -----------------------------------------------------------------------
    // Retry scheduling
    // -----------------------------------------------------------------------

    /** Schedule a reconnection attempt after `interval` ms. */
    function scheduleRetry(interval = retryInterval) {
      clearRetryTimer();
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        requestCreate();
      }, interval);
    }

    /**
     * Request a new connection. The actual `create()` call is deferred to
     * `maybeCreate()` so visibility and re-entrancy guards are respected.
     */
    function requestCreate() {
      if (finished) return;

      pendingCreate = true;
      maybeCreate();
    }

    /**
     * Start a connection if all preconditions are met:
     * 1. Not already terminated (`finished`).
     * 2. No in-flight `create()` call (`isCreating`).
     * 3. A connection was actually requested (`pendingCreate`).
     * 4. The page is visible (or `openWhenHidden` is set).
     */
    function maybeCreate() {
      if (
        finished ||
        isCreating ||
        !pendingCreate ||
        shouldWaitForVisibility()
      ) {
        return;
      }

      pendingCreate = false;
      void create();
    }

    // -----------------------------------------------------------------------
    // Visibility handling — pause when hidden, resume when visible.
    // -----------------------------------------------------------------------

    const disposeVisibility = openWhenHidden
      ? () => {}
      : setupVisibility(
          () => {
            // Page hidden: cancel in-flight request and pending retry.
            clearRetryTimer();
            abortCurrentRequest();
          },
          () => {
            // Page visible: re-establish the connection.
            clearRetryTimer();
            requestCreate();
          },
        );

    // -----------------------------------------------------------------------
    // External abort signal wiring
    // -----------------------------------------------------------------------

    const removeAbortListeners = externalSignals.map((signal) => {
      const abort = () => {
        void resolveClosed({
          reason: FetchEventSourceCloseReason.Aborted,
          receiveState,
        });
      };
      signal.addEventListener("abort", abort, { once: true });
      return () => signal.removeEventListener("abort", abort);
    });

    // If the signal is already aborted at call time, close immediately.
    if (externalSignals.some((signal) => signal.aborted)) {
      void resolveClosed({
        reason: FetchEventSourceCloseReason.Aborted,
        receiveState,
      });
      return;
    }

    // -----------------------------------------------------------------------
    // Resolve defaults
    // -----------------------------------------------------------------------

    const fetch = inputFetch ?? globalThis.fetch;
    const classifyResponse = inputClassifyResponse ?? defaultClassifyResponse;
    const classifyError = inputClassifyError ?? defaultClassifyError;

    // -----------------------------------------------------------------------
    // Response / error handling
    // -----------------------------------------------------------------------

    /** Safely discard a response body, ignoring cancellation errors. */
    async function disposeResponse(response: Response) {
      try {
        await response.body?.cancel();
      } catch {
        // Ignore body cancellation failures. The caller's retry/fatal
        // decision should still be honored.
      }
    }

    /**
     * Act on a response classification:
     * - `accept`: return `true` to continue into the read loop.
     * - `fatal`: reject the promise with a `ResponseError`.
     * - `retry`: schedule a reconnection attempt.
     */
    async function applyResponseDecision(
      response: Response,
      decision: NormalizedResponseDecision,
    ) {
      if (decision.type === "accept") return true;

      const error = new ResponseError(response);
      await disposeResponse(response);

      if (decision.type === "fatal") {
        rejectOnce(error);
        return false;
      }

      scheduleRetry(decision.retryAfter);
      return false;
    }

    /**
     * Route a runtime error through `classifyError` and either schedule
     * a retry or reject the promise.
     */
    async function handleError(error: unknown) {
      const decision = normalizeRetryDecision(
        await classifyError(error, receiveState),
      );

      if (decision.type === "fatal") {
        rejectOnce(error);
        return;
      }

      scheduleRetry(decision.retryAfter);
    }

    // -----------------------------------------------------------------------
    // Core connection lifecycle
    // -----------------------------------------------------------------------

    /**
     * Perform a single fetch → classify → stream → close cycle.
     *
     * On a successful stream, the flow is:
     *   fetch → classifyResponse → onOpen → [onMessage...] → onClose(eof)
     *
     * Errors at any stage are caught and routed through `classifyError`,
     * which decides whether to retry or reject.
     *
     * The `finally` block clears the `isCreating` flag and calls
     * `maybeCreate()` to flush any pending reconnection request (e.g.
     * one queued by a visibility change during the read loop).
     */
    async function create() {
      if (finished) return;

      const controller = new AbortController();
      isCreating = true;
      curRequestController = controller;
      receiveState = ReceiveState.IDLE;
      closeCalled = false;

      try {
        const response = await fetch(input, {
          ...rest,
          headers,
          signal: controller.signal,
        });

        // --- Phase 1: classify the HTTP response ---
        const responseDecision = normalizeResponseDecision(
          await classifyResponse(response),
        );

        if (!(await applyResponseDecision(response, responseDecision))) {
          return;
        }

        // --- Phase 2: notify the caller and begin streaming ---
        await onOpen?.(response);

        if (!response.body) {
          throw new FatalError("Response body is null");
        }

        // Pipe raw bytes through TextDecoder → SSE parser.
        // The parser emits `EventSourceMessage` objects and extracts
        // the server-sent `retry:` interval via the onRetry callback.
        const eventStream = response.body
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(
            new EventSourceParserStream({
              onRetry(ms) {
                retryInterval = ms;
              },
            }),
          );

        // --- Phase 3: consume SSE messages ---
        const reader = eventStream.getReader();
        try {
          for (;;) {
            const { done, value: event } = await reader.read();
            if (done) break;

            // Track `last-event-id` for automatic resumption:
            //  - Non-empty id  → store it (RECEIVED).
            //  - Empty id      → clear it (RECEIVED_NO_ID), per SSE spec.
            //  - No id field   → leave existing id, but mark RECEIVED_NO_ID
            //                    if this is the first message.
            if (event.id !== undefined) {
              if (event.id) {
                headers[LastEventId] = event.id;
                receiveState = ReceiveState.RECEIVED;
              } else {
                delete headers[LastEventId];
                receiveState = ReceiveState.RECEIVED_NO_ID;
              }
            } else if (receiveState === ReceiveState.IDLE) {
              receiveState = ReceiveState.RECEIVED_NO_ID;
            }

            await onMessage?.(event);
          }
        } finally {
          reader.releaseLock();
        }

        // --- Phase 4: stream ended (EOF) ---
        // Guard against duplicate close if abort raced with EOF.
        if (finished || controller.signal.aborted || closeCalled) {
          return;
        }
        closeCalled = true;

        // Not using `resolveClosed` here: thrown/rejected values from an
        // EOF close must route through `classifyError` (retriable), whereas
        // `resolveClosed` rejects the promise directly (abort semantics).
        await onClose?.({
          reason: FetchEventSourceCloseReason.Eof,
          receiveState,
        });
        resolveOnce();
      } catch (error) {
        if (!finished && !controller.signal.aborted) {
          try {
            await handleError(error);
          } catch (innerError) {
            rejectOnce(innerError);
          }
        }
      } finally {
        // Clear the controller reference if it still points to this attempt.
        if (curRequestController === controller) {
          curRequestController = undefined;
        }
        // Release the re-entrancy guard and flush any pending reconnection.
        isCreating = false;
        maybeCreate();
      }
    }

    // Kick off the first connection attempt.
    requestCreate();
  });
}

// ---------------------------------------------------------------------------
// Default classifiers
// ---------------------------------------------------------------------------

/**
 * Default response policy: accept only `2xx` responses whose `Content-Type`
 * starts with `text/event-stream`. Everything else is treated as fatal.
 */
function defaultClassifyResponse(response: Response): ResponseDecision {
  const contentType = response.headers.get("content-type");
  return response.ok && contentType?.startsWith(EventStreamContentType)
    ? FetchEventSourceDecision.Accept
    : FetchEventSourceDecision.Fatal;
}

/**
 * Default error policy:
 * - `RetriableError`: retry, honouring its `retryAfter` if set.
 * - `FatalError` / `ResponseError`: fatal (stop retrying).
 * - Everything else: retry with the current interval.
 */
function defaultClassifyError(error: unknown): ErrorDecision {
  if (error instanceof RetriableError) {
    return error.retryAfter === undefined
      ? FetchEventSourceDecision.Retry
      : { retryAfter: error.retryAfter };
  }

  if (error instanceof FatalError || error instanceof ResponseError) {
    return FetchEventSourceDecision.Fatal;
  }

  return FetchEventSourceDecision.Retry;
}

// ---------------------------------------------------------------------------
// Decision normalizers — convert the user-facing union types into tagged
// discriminants so core logic can use simple `.type` checks.
// ---------------------------------------------------------------------------

function normalizeResponseDecision(
  decision: ResponseDecision,
): NormalizedResponseDecision {
  if (decision === FetchEventSourceDecision.Accept) {
    return { type: "accept" };
  }

  return normalizeRetryDecision(decision);
}

function normalizeRetryDecision(
  decision: ErrorDecision,
): NormalizedRetryDecision {
  if (decision === FetchEventSourceDecision.Fatal) {
    return { type: "fatal" };
  }

  if (decision === FetchEventSourceDecision.Retry) {
    return { type: "retry" };
  }

  const retryAfter = decision.retryAfter;
  if (!Number.isFinite(retryAfter) || retryAfter < 0) {
    throw new TypeError(
      `retryAfter must be a finite non-negative number, received: ${retryAfter}`,
    );
  }

  return { type: "retry", retryAfter };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Copy headers from a `HeadersInit` source into a mutable
 * `Record<string, string>`, normalizing keys to lowercase.
 */
function copyHeaders(
  target: Record<string, string>,
  source?: HeadersInit,
) {
  if (!source) return;

  new Headers(source).forEach((value, key) => {
    target[key.toLowerCase()] = value;
  });
}
