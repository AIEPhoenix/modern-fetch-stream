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

const DefaultRetryInterval = 1000;
const LastEventId = "last-event-id";

type NormalizedRetryDecision =
  | { type: "fatal" }
  | { type: "retry"; retryAfter?: number };

type NormalizedResponseDecision =
  | { type: "accept" }
  | NormalizedRetryDecision;

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
    const headers: Record<string, string> = {};
    copyHeaders(headers, input instanceof Request ? input.headers : undefined);
    copyHeaders(headers, inputHeaders);
    if (!headers.accept) {
      headers.accept = EventStreamContentType;
    }

    let curRequestController: AbortController | undefined;
    let retryInterval = DefaultRetryInterval;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let receiveState: ReceiveState = ReceiveState.IDLE;
    let isCreating = false;
    let pendingCreate = false;
    let finished = false;
    let closeCalled = false;

    const externalSignals = [
      input instanceof Request ? input.signal : undefined,
      inputSignal,
    ].filter((signal): signal is AbortSignal => signal !== undefined);

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

    function shouldWaitForVisibility() {
      return (
        !openWhenHidden && typeof document !== "undefined" && document.hidden
      );
    }

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

    function resolveOnce() {
      stop();
      resolve();
    }

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

    function rejectOnce(error: unknown) {
      stop();
      reject(error);
    }

    function scheduleRetry(interval = retryInterval) {
      clearRetryTimer();
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        requestCreate();
      }, interval);
    }

    function requestCreate() {
      if (finished) return;

      pendingCreate = true;
      maybeCreate();
    }

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

    const disposeVisibility = openWhenHidden
      ? () => {}
      : setupVisibility(
          () => {
            clearRetryTimer();
            abortCurrentRequest();
          },
          () => {
            clearRetryTimer();
            requestCreate();
          },
        );

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

    if (externalSignals.some((signal) => signal.aborted)) {
      void resolveClosed({
        reason: FetchEventSourceCloseReason.Aborted,
        receiveState,
      });
      return;
    }

    const fetch = inputFetch ?? globalThis.fetch;
    const classifyResponse = inputClassifyResponse ?? defaultClassifyResponse;
    const classifyError = inputClassifyError ?? defaultClassifyError;

    async function disposeResponse(response: Response) {
      try {
        await response.body?.cancel();
      } catch {
        // Ignore body cancellation failures. The caller's retry/fatal
        // decision should still be honored.
      }
    }

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

        const responseDecision = normalizeResponseDecision(
          await classifyResponse(response),
        );

        if (!(await applyResponseDecision(response, responseDecision))) {
          return;
        }

        await onOpen?.(response);

        if (!response.body) {
          throw new FatalError("Response body is null");
        }

        const eventStream = response.body
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(
            new EventSourceParserStream({
              onRetry(ms) {
                retryInterval = ms;
              },
            }),
          );

        const reader = eventStream.getReader();
        try {
          for (;;) {
            const { done, value: event } = await reader.read();
            if (done) break;

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

        if (finished || controller.signal.aborted || closeCalled) {
          return;
        }
        closeCalled = true;

        // Not using resolveClosed here: thrown/rejected values from an
        // eof close must route through classifyError (retriable), whereas
        // resolveClosed rejects the promise directly (abort semantics).
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
        if (curRequestController === controller) {
          curRequestController = undefined;
        }
        isCreating = false;
        maybeCreate();
      }
    }

    requestCreate();
  });
}

function defaultClassifyResponse(response: Response): ResponseDecision {
  const contentType = response.headers.get("content-type");
  return response.ok && contentType?.startsWith(EventStreamContentType)
    ? FetchEventSourceDecision.Accept
    : FetchEventSourceDecision.Fatal;
}

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

function copyHeaders(
  target: Record<string, string>,
  source?: HeadersInit,
) {
  if (!source) return;

  new Headers(source).forEach((value, key) => {
    target[key.toLowerCase()] = value;
  });
}
