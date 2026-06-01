import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EventStreamContentType,
  FetchEventSourceCloseReason,
  FatalError,
  FetchEventSourceDecision,
  ResponseError,
  RetriableError,
  fetchEventSource,
  ReceiveState,
} from "../src/index";

function sseChunk(...lines: string[]): string {
  return lines.join("\n") + "\n\n";
}

function mockSSEResponse(
  chunks: string[],
  options: { status?: number; contentType?: string; delay?: number } = {},
): Response {
  const {
    status = 200,
    contentType = EventStreamContentType,
    delay = 0,
  } = options;
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index++]));
      } else {
        controller.close();
      }
    },
  });

  return new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
}

function installMockDocument(initialHidden = false) {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  const listeners = new Set<() => void>();
  const mockDocument = {
    hidden: initialHidden,
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type !== "visibilitychange") return;
      listeners.add(toListener(listener));
    },
    removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
    ) {
      if (type !== "visibilitychange") return;
      listeners.delete(toListener(listener));
    },
  } as Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: mockDocument,
  });

  return {
    setHidden(hidden: boolean) {
      mockDocument.hidden = hidden;
    },
    dispatchVisibilityChange() {
      for (const listener of [...listeners]) {
        listener();
      }
    },
    restore() {
      if (originalDescriptor) {
        Object.defineProperty(globalThis, "document", originalDescriptor);
      } else {
        delete (globalThis as { document?: Document }).document;
      }
    },
  };
}

function toListener(listener: EventListenerOrEventListenerObject) {
  if (typeof listener === "function") {
    return listener as () => void;
  }

  return () => listener.handleEvent(new Event("visibilitychange"));
}

describe("fetchEventSource", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("receives messages", async () => {
    const messages: string[] = [];
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        mockSSEResponse([sseChunk("data: hello"), sseChunk("data: world")]),
      );

    await fetchEventSource("http://test/sse", {
      fetch: mockFetch,
      onMessage(event) {
        messages.push(event.data);
      },
    });

    expect(messages).toEqual(["hello", "world"]);
  });

  it("handles multi-line data", async () => {
    const messages: string[] = [];
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        mockSSEResponse([sseChunk("data: a", "data: b", "data: c")]),
      );

    await fetchEventSource("http://test/sse", {
      fetch: mockFetch,
      onMessage(event) {
        messages.push(event.data);
      },
    });

    expect(messages).toEqual(["a\nb\nc"]);
  });

  it("passes headers and method", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(mockSSEResponse([sseChunk("data: ok")]));

    await fetchEventSource("http://test/sse", {
      fetch: mockFetch,
      method: "POST",
      headers: { Authorization: "Bearer x" },
    });

    expect(mockFetch.mock.calls[0][1].method).toBe("POST");
    expect(mockFetch.mock.calls[0][1].headers.authorization).toBe("Bearer x");
    expect(mockFetch.mock.calls[0][1].headers.accept).toBe(
      EventStreamContentType,
    );
  });

  it("preserves headers from Request input", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(mockSSEResponse([sseChunk("data: ok")]));
    const request = new Request("http://test/sse", {
      headers: { Authorization: "Bearer x" },
    });

    await fetchEventSource(request, { fetch: mockFetch });

    expect(mockFetch.mock.calls[0][1].headers.authorization).toBe("Bearer x");
    expect(mockFetch.mock.calls[0][1].headers.accept).toBe(
      EventStreamContentType,
    );
  });

  it("calls onOpen after classifyResponse accepts", async () => {
    const onOpen = vi.fn();
    const mockFetch = vi
      .fn()
      .mockResolvedValue(mockSSEResponse([sseChunk("data: ok")]));

    await fetchEventSource("http://test/sse", {
      fetch: mockFetch,
      onOpen,
    });

    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("calls onClose on normal end", async () => {
    const onClose = vi.fn();
    const mockFetch = vi
      .fn()
      .mockResolvedValue(mockSSEResponse([sseChunk("data: done")]));

    await fetchEventSource("http://test/sse", { fetch: mockFetch, onClose });

    expect(onClose).toHaveBeenCalledWith({
      reason: FetchEventSourceCloseReason.Eof,
      receiveState: ReceiveState.RECEIVED_NO_ID,
    });
  });

  it("resolves on abort", async () => {
    const controller = new AbortController();
    const onClose = vi.fn();
    const mockFetch = vi
      .fn()
      .mockResolvedValue(mockSSEResponse([sseChunk("data: 1")], { delay: 50 }));

    setTimeout(() => controller.abort(), 10);

    await fetchEventSource("http://test/sse", {
      fetch: mockFetch,
      signal: controller.signal,
      onClose,
    });

    expect(onClose).toHaveBeenCalledWith({
      reason: FetchEventSourceCloseReason.Aborted,
      receiveState: ReceiveState.IDLE,
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not emit eof after an aborted close", async () => {
    const controller = new AbortController();
    const onClose = vi.fn();
    const mockFetch = vi.fn().mockImplementation(
      (_input: string, init?: RequestInit) => {
        let streamController:
          | ReadableStreamDefaultController<Uint8Array>
          | undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(new TextEncoder().encode(sseChunk("data: 1")));
            init?.signal?.addEventListener(
              "abort",
              () => {
                streamController?.close();
              },
              { once: true },
            );
          },
        });

        return Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { "content-type": EventStreamContentType },
          }),
        );
      },
    );

    const promise = fetchEventSource("http://test/sse", {
      fetch: mockFetch,
      signal: controller.signal,
      onClose,
      async onMessage() {
        controller.abort();
      },
    });

    await promise;

    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith({
      reason: FetchEventSourceCloseReason.Aborted,
      receiveState: ReceiveState.RECEIVED_NO_ID,
    });
  });

  it("rejects when onClose throws on abort", async () => {
    const controller = new AbortController();
    const mockFetch = vi
      .fn()
      .mockResolvedValue(mockSSEResponse([sseChunk("data: 1")], { delay: 50 }));

    setTimeout(() => controller.abort(), 10);

    await expect(
      fetchEventSource("http://test/sse", {
        fetch: mockFetch,
        signal: controller.signal,
        onClose() {
          throw new Error("abort handler error");
        },
      }),
    ).rejects.toThrow("abort handler error");
  });

  it("retries on generic errors with the default interval", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error("fail"));
      return Promise.resolve(mockSSEResponse([sseChunk("data: ok")]));
    });

    const promise = fetchEventSource("http://test/sse", {
      fetch: mockFetch,
      onMessage() {},
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(callCount).toBe(2);
    vi.useRealTimers();
  });

  it("routes async onMessage rejections through classifyError", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve(
        mockSSEResponse([sseChunk(`data: attempt-${callCount}`)]),
      );
    });

    const messages: string[] = [];
    const promise = fetchEventSource("http://test/sse", {
      fetch: mockFetch,
      async onMessage(event) {
        messages.push(event.data);
        if (callCount === 1) {
          throw new RetriableError("retry async handler", 25);
        }
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(25);
    await promise;

    expect(callCount).toBe(2);
    expect(messages).toEqual(["attempt-1", "attempt-2"]);
    vi.useRealTimers();
  });

  it("uses classifyError retryAfter when provided", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error("fail"));
      return Promise.resolve(mockSSEResponse([sseChunk("data: ok")]));
    });

    const promise = fetchEventSource("http://test/sse", {
      fetch: mockFetch,
      classifyError() {
        return { retryAfter: 5000 };
      },
      onMessage() {},
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(callCount).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(callCount).toBe(2);
    vi.useRealTimers();
  });

  it("stops when classifyError returns fatal", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("fail"));

    await expect(
      fetchEventSource("http://test/sse", {
        fetch: mockFetch,
        classifyError() {
          return FetchEventSourceDecision.Fatal;
        },
      }),
    ).rejects.toThrow("fail");

    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("rejects wrong content-type by default with ResponseError", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(mockSSEResponse([], { contentType: "text/html" }));

    await expect(
      fetchEventSource("http://test/sse", {
        fetch: mockFetch,
      }),
    ).rejects.toBeInstanceOf(ResponseError);
  });

  it("rejects non-ok event-stream responses by default with ResponseError", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockSSEResponse([], {
        status: 401,
        contentType: EventStreamContentType,
      }),
    );

    await expect(
      fetchEventSource("http://test/sse", {
        fetch: mockFetch,
      }),
    ).rejects.toBeInstanceOf(ResponseError);
  });

  it("lets classifyResponse mark a response as retriable", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          mockSSEResponse([sseChunk("data: no")], { status: 503 }),
        );
      }
      return Promise.resolve(mockSSEResponse([sseChunk("data: ok")]));
    });

    const promise = fetchEventSource("http://test/sse", {
      fetch: mockFetch,
      classifyResponse(response) {
        if (response.status === 503) {
          return { retryAfter: 250 };
        }
        return FetchEventSourceDecision.Accept;
      },
      onMessage() {},
    });

    await vi.advanceTimersByTimeAsync(200);
    expect(callCount).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    await promise;

    expect(callCount).toBe(2);
    vi.useRealTimers();
  });

  it("cancels the response body before retrying a rejected response", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const cancel = vi.fn();

    const retryResponse = new Response(
      new ReadableStream<Uint8Array>({
        cancel,
      }),
      {
        status: 503,
        headers: { "content-type": EventStreamContentType },
      },
    );

    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(retryResponse);
      }

      return Promise.resolve(mockSSEResponse([sseChunk("data: ok")]));
    });

    const promise = fetchEventSource("http://test/sse", {
      fetch: mockFetch,
      classifyResponse(response) {
        return response.status === 503
          ? { retryAfter: 25 }
          : FetchEventSourceDecision.Accept;
      },
      onMessage() {},
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(25);
    await promise;

    expect(callCount).toBe(2);
    vi.useRealTimers();
  });

  it("rejects with ResponseError when classifyResponse returns fatal", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(mockSSEResponse([], { status: 503 }));

    await expect(
      fetchEventSource("http://test/sse", {
        fetch: mockFetch,
        classifyResponse() {
          return FetchEventSourceDecision.Fatal;
        },
      }),
    ).rejects.toBeInstanceOf(ResponseError);
  });

  it("retries RetriableError using its retryAfter", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new RetriableError("retry later", 250));
      }
      return Promise.resolve(mockSSEResponse([sseChunk("data: ok")]));
    });

    const promise = fetchEventSource("http://test/sse", {
      fetch: mockFetch,
      onMessage() {},
    });

    await vi.advanceTimersByTimeAsync(200);
    expect(callCount).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    await promise;

    expect(callCount).toBe(2);
    vi.useRealTimers();
  });

  it("rejects FatalError by default", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new FatalError("fatal"));

    await expect(
      fetchEventSource("http://test/sse", {
        fetch: mockFetch,
      }),
    ).rejects.toThrow("fatal");
  });

  it("sends last-event-id on reconnect", async () => {
    vi.useFakeTimers();
    let callCount = 0;

    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        const encoder = new TextEncoder();
        let sent = false;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!sent) {
              controller.enqueue(
                encoder.encode(sseChunk("id: 42", "data: first")),
              );
              sent = true;
            } else {
              controller.error(new Error("lost"));
            }
          },
        });
        return Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { "content-type": EventStreamContentType },
          }),
        );
      }

      return Promise.resolve(mockSSEResponse([sseChunk("data: second")]));
    });

    const promise = fetchEventSource("http://test/sse", {
      fetch: mockFetch,
      onMessage() {},
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(mockFetch.mock.calls[1][1].headers["last-event-id"]).toBe("42");
    vi.useRealTimers();
  });

  it("clears last-event-id when server sends an empty id", async () => {
    vi.useFakeTimers();
    let callCount = 0;

    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        const encoder = new TextEncoder();
        let phase = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (phase === 0) {
              controller.enqueue(
                encoder.encode(sseChunk("id: 42", "data: first")),
              );
              phase++;
            } else if (phase === 1) {
              controller.enqueue(
                encoder.encode(sseChunk("id: ", "data: second")),
              );
              phase++;
            } else {
              controller.error(new Error("lost"));
            }
          },
        });
        return Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { "content-type": EventStreamContentType },
          }),
        );
      }

      return Promise.resolve(mockSSEResponse([sseChunk("data: third")]));
    });

    const promise = fetchEventSource("http://test/sse", {
      fetch: mockFetch,
      onMessage() {},
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(mockFetch.mock.calls[1][1].headers["last-event-id"]).toBeUndefined();
    vi.useRealTimers();
  });

  it("passes RECEIVED to onClose when messages have id", async () => {
    const onClose = vi.fn();
    const mockFetch = vi
      .fn()
      .mockResolvedValue(mockSSEResponse([sseChunk("id: 1", "data: hello")]));

    await fetchEventSource("http://test/sse", { fetch: mockFetch, onClose });

    expect(onClose).toHaveBeenCalledWith({
      reason: FetchEventSourceCloseReason.Eof,
      receiveState: ReceiveState.RECEIVED,
    });
  });

  it("passes RECEIVED_NO_ID to onClose when messages have no id", async () => {
    const onClose = vi.fn();
    const mockFetch = vi
      .fn()
      .mockResolvedValue(mockSSEResponse([sseChunk("data: hello")]));

    await fetchEventSource("http://test/sse", { fetch: mockFetch, onClose });

    expect(onClose).toHaveBeenCalledWith({
      reason: FetchEventSourceCloseReason.Eof,
      receiveState: ReceiveState.RECEIVED_NO_ID,
    });
  });

  it("passes IDLE to onClose when no messages were received", async () => {
    const onClose = vi.fn();
    const mockFetch = vi.fn().mockResolvedValue(mockSSEResponse([]));

    await fetchEventSource("http://test/sse", { fetch: mockFetch, onClose });

    expect(onClose).toHaveBeenCalledWith({
      reason: FetchEventSourceCloseReason.Eof,
      receiveState: ReceiveState.IDLE,
    });
  });

  it("retries immediately when classifyError returns retryAfter 0", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error("fail"));
      return Promise.resolve(mockSSEResponse([sseChunk("data: ok")]));
    });

    const promise = fetchEventSource("http://test/sse", {
      fetch: mockFetch,
      classifyError() {
        return { retryAfter: 0 };
      },
      onMessage() {},
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(callCount).toBe(2);
    vi.useRealTimers();
  });

  it("respects the server retry field for reconnection interval", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        const encoder = new TextEncoder();
        let phase = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (phase === 0) {
              controller.enqueue(encoder.encode("retry: 3000\n\n"));
              phase++;
            } else if (phase === 1) {
              controller.enqueue(encoder.encode(sseChunk("data: hello")));
              phase++;
            } else {
              controller.error(new Error("lost"));
            }
          },
        });
        return Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { "content-type": EventStreamContentType },
          }),
        );
      }

      return Promise.resolve(mockSSEResponse([sseChunk("data: ok")]));
    });

    const promise = fetchEventSource("http://test/sse", {
      fetch: mockFetch,
      onMessage() {},
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(callCount).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(callCount).toBe(2);
    vi.useRealTimers();
  });

  it("rejects a null response body as fatal", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { "content-type": EventStreamContentType },
      }),
    );

    await expect(
      fetchEventSource("http://test/sse", {
        fetch: mockFetch,
      }),
    ).rejects.toThrow("Response body is null");
  });

  it("resolves immediately with a pre-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const onClose = vi.fn();

    const mockFetch = vi.fn().mockImplementation(
      (_input: string, init: RequestInit) => {
        if (init.signal?.aborted) {
          return Promise.reject(new DOMException("aborted", "AbortError"));
        }

        return Promise.resolve(mockSSEResponse([sseChunk("data: ok")]));
      },
    );

    await fetchEventSource("http://test/sse", {
      fetch: mockFetch,
      signal: controller.signal,
      onClose,
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith({
      reason: FetchEventSourceCloseReason.Aborted,
      receiveState: ReceiveState.IDLE,
    });
  });

  it("does not report visibility-based pause and resume as aborted close", async () => {
    vi.useFakeTimers();
    const mockDocument = installMockDocument();
    const onClose = vi.fn();
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error("fail"));
      }
      return Promise.resolve(mockSSEResponse([sseChunk("data: ok")]));
    });

    try {
      const promise = fetchEventSource("http://test/sse", {
        fetch: mockFetch,
        onClose,
        onMessage() {},
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(callCount).toBe(1);

      mockDocument.setHidden(true);
      mockDocument.dispatchVisibilityChange();
      mockDocument.setHidden(false);
      mockDocument.dispatchVisibilityChange();
      await vi.advanceTimersByTimeAsync(0);
      await promise;

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledWith({
        reason: FetchEventSourceCloseReason.Eof,
        receiveState: ReceiveState.RECEIVED_NO_ID,
      });
    } finally {
      mockDocument.restore();
      vi.useRealTimers();
    }
  });

  it("waits until visible before connecting when the page starts hidden", async () => {
    const mockDocument = installMockDocument(true);
    const mockFetch = vi
      .fn()
      .mockResolvedValue(mockSSEResponse([sseChunk("data: ok")]));

    try {
      const promise = fetchEventSource("http://test/sse", { fetch: mockFetch });

      await Promise.resolve();
      expect(mockFetch).not.toHaveBeenCalled();

      mockDocument.setHidden(false);
      mockDocument.dispatchVisibilityChange();
      await promise;

      expect(mockFetch).toHaveBeenCalledOnce();
    } finally {
      mockDocument.restore();
    }
  });

  it("clears a pending retry before reconnecting on visibility restore", async () => {
    vi.useFakeTimers();
    const mockDocument = installMockDocument();
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error("fail"));
      }
      return Promise.resolve(mockSSEResponse([sseChunk("data: ok")]));
    });

    try {
      const promise = fetchEventSource("http://test/sse", {
        fetch: mockFetch,
        onMessage() {},
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(callCount).toBe(1);

      mockDocument.setHidden(true);
      mockDocument.dispatchVisibilityChange();
      mockDocument.setHidden(false);
      mockDocument.dispatchVisibilityChange();
      await vi.advanceTimersByTimeAsync(0);

      expect(callCount).toBe(2);

      await vi.advanceTimersByTimeAsync(1000);
      expect(callCount).toBe(2);

      await promise;
    } finally {
      mockDocument.restore();
      vi.useRealTimers();
    }
  });

  it("retries when onClose throws a RetriableError", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(mockSSEResponse([sseChunk("data: first")]));
      }
      return Promise.resolve(mockSSEResponse([sseChunk("data: second")]));
    });

    const messages: string[] = [];
    const promise = fetchEventSource("http://test/sse", {
      fetch: mockFetch,
      onMessage(event) {
        messages.push(event.data);
      },
      onClose() {
        if (callCount === 1) {
          throw new RetriableError("unexpected close");
        }
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(callCount).toBe(2);
    expect(messages).toEqual(["first", "second"]);
    vi.useRealTimers();
  });

  it("normalizes header keys to lowercase", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(mockSSEResponse([sseChunk("data: ok")]));

    await fetchEventSource("http://test/sse", {
      fetch: mockFetch,
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
    });

    const sentHeaders = mockFetch.mock.calls[0][1].headers;
    expect(sentHeaders["content-type"]).toBe("application/json");
    expect(sentHeaders.accept).toBe("text/event-stream");
    expect(sentHeaders["Content-Type"]).toBeUndefined();
    expect(sentHeaders["Accept"]).toBeUndefined();
  });

  it("does not add a duplicate accept header when the user provides one", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(mockSSEResponse([sseChunk("data: ok")]));

    await fetchEventSource("http://test/sse", {
      fetch: mockFetch,
      headers: { Accept: EventStreamContentType },
    });

    const sentHeaders = mockFetch.mock.calls[0][1].headers;
    const acceptKeys = Object.keys(sentHeaders).filter(
      (key) => key.toLowerCase() === "accept",
    );
    expect(acceptKeys).toEqual(["accept"]);
  });

  it("exports runtime decision constants", () => {
    expect(FetchEventSourceDecision.Accept).toBe("accept");
    expect(FetchEventSourceDecision.Retry).toBe("retry");
    expect(FetchEventSourceDecision.Fatal).toBe("fatal");
    expect(FetchEventSourceCloseReason.Eof).toBe("eof");
    expect(FetchEventSourceCloseReason.Aborted).toBe("aborted");
  });

  // -----------------------------------------------------------------------
  // Gap coverage: onOpen throwing
  // -----------------------------------------------------------------------

  it("routes onOpen errors through classifyError", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve(mockSSEResponse([sseChunk("data: ok")]));
    });

    const promise = fetchEventSource("http://test/sse", {
      fetch: mockFetch,
      onOpen() {
        if (callCount === 1) throw new Error("onOpen boom");
      },
      onMessage() {},
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(callCount).toBe(2);
    vi.useRealTimers();
  });

  it("rejects when onOpen throws and classifyError returns fatal", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(mockSSEResponse([sseChunk("data: ok")]));

    await expect(
      fetchEventSource("http://test/sse", {
        fetch: mockFetch,
        onOpen() {
          throw new Error("onOpen fatal");
        },
        classifyError() {
          return FetchEventSourceDecision.Fatal;
        },
      }),
    ).rejects.toThrow("onOpen fatal");
  });

  // -----------------------------------------------------------------------
  // Gap coverage: classifyResponse returning plain "retry"
  // -----------------------------------------------------------------------

  it("retries with default interval when classifyResponse returns Retry", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          mockSSEResponse([sseChunk("data: no")], { status: 503 }),
        );
      }
      return Promise.resolve(mockSSEResponse([sseChunk("data: ok")]));
    });

    const promise = fetchEventSource("http://test/sse", {
      fetch: mockFetch,
      classifyResponse(response) {
        return response.ok
          ? FetchEventSourceDecision.Accept
          : FetchEventSourceDecision.Retry;
      },
      onMessage() {},
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(callCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(callCount).toBe(2);
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Gap coverage: async classifyResponse / classifyError
  // -----------------------------------------------------------------------

  it("supports async classifyResponse", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(mockSSEResponse([sseChunk("data: ok")]));
    const messages: string[] = [];

    await fetchEventSource("http://test/sse", {
      fetch: mockFetch,
      async classifyResponse(response) {
        await Promise.resolve();
        return response.ok
          ? FetchEventSourceDecision.Accept
          : FetchEventSourceDecision.Fatal;
      },
      onMessage(event) {
        messages.push(event.data);
      },
    });

    expect(messages).toEqual(["ok"]);
  });

  it("supports async classifyError", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error("fail"));
      return Promise.resolve(mockSSEResponse([sseChunk("data: ok")]));
    });

    const promise = fetchEventSource("http://test/sse", {
      fetch: mockFetch,
      async classifyError() {
        await Promise.resolve();
        return { retryAfter: 100 };
      },
      onMessage() {},
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(callCount).toBe(2);
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Gap coverage: classifyError receives correct receiveState
  // -----------------------------------------------------------------------

  it("passes IDLE receiveState to classifyError when error occurs before any messages", async () => {
    const receivedStates: string[] = [];
    const mockFetch = vi.fn().mockRejectedValue(new Error("fail"));

    await expect(
      fetchEventSource("http://test/sse", {
        fetch: mockFetch,
        classifyError(_error, receiveState) {
          receivedStates.push(receiveState);
          return FetchEventSourceDecision.Fatal;
        },
      }),
    ).rejects.toThrow("fail");

    expect(receivedStates).toEqual([ReceiveState.IDLE]);
  });

  it("passes RECEIVED receiveState to classifyError when messages with id were received", async () => {
    const receivedStates: string[] = [];
    const encoder = new TextEncoder();
    const mockFetch = vi.fn().mockImplementation(() => {
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            controller.enqueue(
              encoder.encode(sseChunk("id: 1", "data: hi")),
            );
            sent = true;
          } else {
            controller.error(new Error("mid-stream fail"));
          }
        },
      });
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { "content-type": EventStreamContentType },
        }),
      );
    });

    await expect(
      fetchEventSource("http://test/sse", {
        fetch: mockFetch,
        onMessage() {},
        classifyError(_error, receiveState) {
          receivedStates.push(receiveState);
          return FetchEventSourceDecision.Fatal;
        },
      }),
    ).rejects.toThrow("mid-stream fail");

    expect(receivedStates).toEqual([ReceiveState.RECEIVED]);
  });

  it("passes RECEIVED_NO_ID receiveState to classifyError when messages without id were received", async () => {
    const receivedStates: string[] = [];
    const encoder = new TextEncoder();
    const mockFetch = vi.fn().mockImplementation(() => {
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            controller.enqueue(encoder.encode(sseChunk("data: hi")));
            sent = true;
          } else {
            controller.error(new Error("mid-stream fail"));
          }
        },
      });
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { "content-type": EventStreamContentType },
        }),
      );
    });

    await expect(
      fetchEventSource("http://test/sse", {
        fetch: mockFetch,
        onMessage() {},
        classifyError(_error, receiveState) {
          receivedStates.push(receiveState);
          return FetchEventSourceDecision.Fatal;
        },
      }),
    ).rejects.toThrow("mid-stream fail");

    expect(receivedStates).toEqual([ReceiveState.RECEIVED_NO_ID]);
  });

  // -----------------------------------------------------------------------
  // Gap coverage: openWhenHidden
  // -----------------------------------------------------------------------

  it("keeps the connection alive when openWhenHidden is true", async () => {
    const mockDocument = installMockDocument();
    const mockFetch = vi.fn().mockImplementation(
      () =>
        new Promise(() => {
          // Never resolves — simulates an open connection
        }),
    );

    try {
      const controller = new AbortController();
      const closePromise = fetchEventSource("http://test/sse", {
        fetch: mockFetch,
        openWhenHidden: true,
        signal: controller.signal,
        onClose() {},
      });

      await Promise.resolve();
      expect(mockFetch).toHaveBeenCalledOnce();

      // Hiding the page should NOT abort the request
      mockDocument.setHidden(true);
      mockDocument.dispatchVisibilityChange();
      await Promise.resolve();

      // fetch is still the same call — no abort, no new fetch
      expect(mockFetch).toHaveBeenCalledOnce();

      controller.abort();
      await closePromise;
    } finally {
      mockDocument.restore();
    }
  });

  // -----------------------------------------------------------------------
  // Gap coverage: invalid retryAfter validation
  // -----------------------------------------------------------------------

  it("rejects with TypeError when classifyError returns negative retryAfter", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("fail"));

    await expect(
      fetchEventSource("http://test/sse", {
        fetch: mockFetch,
        classifyError() {
          return { retryAfter: -1 };
        },
      }),
    ).rejects.toThrow(TypeError);
  });

  it("rejects with TypeError when classifyError returns NaN retryAfter", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("fail"));

    await expect(
      fetchEventSource("http://test/sse", {
        fetch: mockFetch,
        classifyError() {
          return { retryAfter: NaN };
        },
      }),
    ).rejects.toThrow(TypeError);
  });

  it("rejects with TypeError when classifyError returns Infinity retryAfter", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("fail"));

    await expect(
      fetchEventSource("http://test/sse", {
        fetch: mockFetch,
        classifyError() {
          return { retryAfter: Infinity };
        },
      }),
    ).rejects.toThrow(TypeError);
  });

  // -----------------------------------------------------------------------
  // Gap coverage: classifyError itself throwing
  // -----------------------------------------------------------------------

  it("rejects when classifyError itself throws", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("original"));

    await expect(
      fetchEventSource("http://test/sse", {
        fetch: mockFetch,
        classifyError() {
          throw new Error("classifier exploded");
        },
      }),
    ).rejects.toThrow("classifier exploded");
  });

  // -----------------------------------------------------------------------
  // Gap coverage: Request input signal triggers abort
  // -----------------------------------------------------------------------

  it("aborts when Request input signal fires", async () => {
    const controller = new AbortController();
    const onClose = vi.fn();
    const mockFetch = vi
      .fn()
      .mockResolvedValue(mockSSEResponse([sseChunk("data: 1")], { delay: 50 }));

    const request = new Request("http://test/sse", {
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 10);

    await fetchEventSource(request, {
      fetch: mockFetch,
      onClose,
    });

    expect(onClose).toHaveBeenCalledWith({
      reason: FetchEventSourceCloseReason.Aborted,
      receiveState: ReceiveState.IDLE,
    });
  });

  // -----------------------------------------------------------------------
  // Gap coverage: onClose EOF throwing FatalError → classifyError → fatal
  // -----------------------------------------------------------------------

  it("rejects when onClose throws FatalError on EOF", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(mockSSEResponse([sseChunk("data: first")]));

    await expect(
      fetchEventSource("http://test/sse", {
        fetch: mockFetch,
        onMessage() {},
        onClose() {
          throw new FatalError("unwanted close");
        },
      }),
    ).rejects.toThrow("unwanted close");

    expect(mockFetch).toHaveBeenCalledOnce();
  });

  // -----------------------------------------------------------------------
  // Gap coverage: multiple consecutive retries
  // -----------------------------------------------------------------------

  it("retries multiple times before succeeding", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 3) return Promise.reject(new Error(`fail-${callCount}`));
      return Promise.resolve(mockSSEResponse([sseChunk("data: ok")]));
    });

    const promise = fetchEventSource("http://test/sse", {
      fetch: mockFetch,
      onMessage() {},
    });

    // 3 retries at 1s each
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);
    }
    await promise;

    expect(callCount).toBe(4);
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Gap coverage: async onMessage backpressure (serial execution)
  // -----------------------------------------------------------------------

  it("awaits async onMessage handlers serially", async () => {
    const order: number[] = [];
    const mockFetch = vi.fn().mockResolvedValue(
      mockSSEResponse([
        sseChunk("data: 1"),
        sseChunk("data: 2"),
        sseChunk("data: 3"),
      ]),
    );

    await fetchEventSource("http://test/sse", {
      fetch: mockFetch,
      async onMessage(event) {
        const n = Number(event.data);
        // Stagger delays: message 1 takes longest, message 3 is instant.
        // If parallel, 3 would finish before 1.
        await new Promise((resolve) => setTimeout(resolve, (4 - n) * 10));
        order.push(n);
      },
    });

    expect(order).toEqual([1, 2, 3]);
  });

  // -----------------------------------------------------------------------
  // Gap coverage: URL object as input
  // -----------------------------------------------------------------------

  it("accepts a URL object as input", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(mockSSEResponse([sseChunk("data: ok")]));

    const messages: string[] = [];
    await fetchEventSource(new URL("http://test/sse"), {
      fetch: mockFetch,
      onMessage(event) {
        messages.push(event.data);
      },
    });

    expect(messages).toEqual(["ok"]);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  // -----------------------------------------------------------------------
  // Regression (H1): error paths must release the response body, not just
  // drop the reference and rely on GC.
  // -----------------------------------------------------------------------

  it("cancels the response body when onMessage throws and a retry is scheduled", async () => {
    vi.useFakeTimers();
    const cancelSpy = vi.fn();
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(encoder.encode(sseChunk("data: 1")));
          },
          cancel: cancelSpy,
        });
        return Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { "content-type": EventStreamContentType },
          }),
        );
      }
      return Promise.resolve(mockSSEResponse([sseChunk("data: ok")]));
    });

    let thrown = false;
    const promise = fetchEventSource("http://test/sse", {
      fetch: mockFetch,
      classifyError() {
        return { retryAfter: 0 };
      },
      onMessage() {
        if (!thrown) {
          thrown = true;
          throw new Error("boom");
        }
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(cancelSpy).toHaveBeenCalled();
    expect(callCount).toBe(2);
    vi.useRealTimers();
  });

  it("cancels the response body when onOpen throws", async () => {
    const cancelSpy = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(sseChunk("data: 1")));
      },
      cancel: cancelSpy,
    });
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "content-type": EventStreamContentType },
      }),
    );

    await expect(
      fetchEventSource("http://test/sse", {
        fetch: mockFetch,
        onOpen() {
          throw new FatalError("open failed");
        },
      }),
    ).rejects.toThrow("open failed");

    expect(cancelSpy).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Regression (H2): an external abort during the retry window opened by an
  // `onClose(eof)` that threw must still terminate the stream — it must not
  // be swallowed by the `closeCalled` guard (which would hang the promise
  // forever and leave the retry timer running).
  // -----------------------------------------------------------------------

  it("lets an external abort terminate after onClose throws on eof", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const onClose = vi.fn((close: { reason: string }) => {
      if (close.reason === FetchEventSourceCloseReason.Eof) {
        throw new RetriableError("retry after eof");
      }
    });
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve(mockSSEResponse([sseChunk("data: 1")]));
    });

    const promise = fetchEventSource("http://test/sse", {
      fetch: mockFetch,
      signal: controller.signal,
      onClose,
      onMessage() {},
    });

    // First connection reaches EOF -> onClose(eof) throws -> retry scheduled.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(onClose).toHaveBeenCalledOnce();

    // Abort during the retry wait window. The promise must resolve (not hang
    // or reject), onClose must not fire a second time, and no retry fetch
    // may occur after the timer would have elapsed.
    controller.abort();
    await promise;

    await vi.advanceTimersByTimeAsync(5000);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith({
      reason: FetchEventSourceCloseReason.Eof,
      receiveState: ReceiveState.RECEIVED_NO_ID,
    });
    expect(callCount).toBe(1);
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Regression (M2): a fatal ResponseError must expose a still-readable body
  // so callers can inspect the error payload.
  // -----------------------------------------------------------------------

  it("preserves the response body on a fatal ResponseError", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('{"error":"nope"}', {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    let caught: unknown;
    try {
      await fetchEventSource("http://test/sse", { fetch: mockFetch });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ResponseError);
    const text = await (caught as ResponseError).response.text();
    expect(text).toBe('{"error":"nope"}');
  });

  // -----------------------------------------------------------------------
  // Regression (M1): an abort while an async classifyResponse is in flight
  // must not leak into onOpen / the read loop.
  // -----------------------------------------------------------------------

  it("does not call onOpen when aborted during an async classifyResponse", async () => {
    const controller = new AbortController();
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const mockFetch = vi
      .fn()
      .mockResolvedValue(mockSSEResponse([sseChunk("data: 1")]));

    await fetchEventSource("http://test/sse", {
      fetch: mockFetch,
      signal: controller.signal,
      onOpen,
      onClose,
      async classifyResponse() {
        // Abort while this async classifier is still pending.
        controller.abort();
        await Promise.resolve();
        return FetchEventSourceDecision.Accept;
      },
    });

    // The promise resolves on abort, but `create()` keeps running in the
    // background. Flush microtasks/timers so an erroneous `onOpen` (the bug
    // this guards) would have fired before we assert it did not.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(onOpen).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith({
      reason: FetchEventSourceCloseReason.Aborted,
      receiveState: ReceiveState.IDLE,
    });
  });

  // -----------------------------------------------------------------------
  // Regression (M3): hiding the page mid-stream must abort the active request
  // without reporting an aborted close, and resume on becoming visible again.
  // -----------------------------------------------------------------------

  it("pauses an active stream when hidden and resumes when visible without an aborted close", async () => {
    const mockDocument = installMockDocument();
    const onClose = vi.fn();
    const messages: string[] = [];
    let firstAborted = false;
    let callCount = 0;
    const mockFetch = vi
      .fn()
      .mockImplementation((_input: string, init?: RequestInit) => {
        callCount++;
        const count = callCount;
        const encoder = new TextEncoder();
        let streamController:
          | ReadableStreamDefaultController<Uint8Array>
          | undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(encoder.encode(sseChunk(`data: conn${count}`)));
            // The second (resumed) connection ends cleanly; the first stays
            // open until the visibility-driven abort tears it down.
            if (count === 2) controller.close();
          },
        });
        init?.signal?.addEventListener(
          "abort",
          () => {
            if (count === 1) firstAborted = true;
            // Mimic fetch: aborting the signal errors the body.
            streamController?.error(new DOMException("aborted", "AbortError"));
          },
          { once: true },
        );
        return Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { "content-type": EventStreamContentType },
          }),
        );
      });

    try {
      const promise = fetchEventSource("http://test/sse", {
        fetch: mockFetch,
        onClose,
        onMessage(ev) {
          messages.push(ev.data);
        },
      });

      // First connection opens and delivers a message.
      await vi.waitFor(() => expect(messages).toContain("conn1"));

      // Hide mid-stream: aborts the active request, must NOT report a close.
      mockDocument.setHidden(true);
      mockDocument.dispatchVisibilityChange();
      await vi.waitFor(() => expect(firstAborted).toBe(true));
      expect(onClose).not.toHaveBeenCalled();

      // Reveal: reconnect.
      mockDocument.setHidden(false);
      mockDocument.dispatchVisibilityChange();

      await promise;

      expect(callCount).toBe(2);
      expect(messages).toEqual(["conn1", "conn2"]);
      // onClose fired once, for eof — never for the visibility pause.
      expect(onClose).toHaveBeenCalledOnce();
      expect(onClose).toHaveBeenCalledWith({
        reason: FetchEventSourceCloseReason.Eof,
        receiveState: ReceiveState.RECEIVED_NO_ID,
      });
    } finally {
      mockDocument.restore();
    }
  });

  // -----------------------------------------------------------------------
  // Regression (Codex #1): on a fatal ResponseError, native fetch errors the
  // body when its signal is aborted. The library must NOT abort the
  // controller before rejecting, so the caller can still read the body.
  // -----------------------------------------------------------------------

  it("keeps the body readable after rejecting with ResponseError under native-fetch abort semantics", async () => {
    const mockFetch = vi.fn().mockImplementation(
      (_input: string, init?: RequestInit) => {
        let streamController:
          | ReadableStreamDefaultController<Uint8Array>
          | undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(new TextEncoder().encode('{"error":"nope"}'));
            controller.close();
          },
        });
        // Mimic native fetch: aborting the request signal errors the body.
        init?.signal?.addEventListener(
          "abort",
          () => streamController?.error(new DOMException("aborted", "AbortError")),
          { once: true },
        );
        return Promise.resolve(
          new Response(body, {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
        );
      },
    );

    let caught: unknown;
    try {
      await fetchEventSource("http://test/sse", { fetch: mockFetch });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ResponseError);
    const text = await (caught as ResponseError).response.text();
    expect(text).toBe('{"error":"nope"}');
  });

  // -----------------------------------------------------------------------
  // Regression (Codex #2 / heph round-3): abort during an async
  // `classifyResponse` that returns Accept must not let `onOpen` fire.
  // The retry/fatal branches have downstream guards, but the accept branch
  // would otherwise fall straight into `await onOpen` on a cancelled stream.
  // -----------------------------------------------------------------------

  it("does not call onOpen when aborted during an async classifyResponse that returns Accept", async () => {
    const controller = new AbortController();
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const mockFetch = vi
      .fn()
      .mockResolvedValue(mockSSEResponse([sseChunk("data: 1")]));

    await fetchEventSource("http://test/sse", {
      fetch: mockFetch,
      signal: controller.signal,
      onOpen,
      onClose,
      async classifyResponse() {
        controller.abort();
        await Promise.resolve();
        return FetchEventSourceDecision.Accept;
      },
    });

    // onOpen would otherwise fire after the promise resolves; flush.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(onOpen).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith({
      reason: FetchEventSourceCloseReason.Aborted,
      receiveState: ReceiveState.IDLE,
    });
  });

  // -----------------------------------------------------------------------
  // Regression (Codex #3): abort during an async onOpen must not let the
  // read loop start and emit messages on an already-resolved promise.
  // -----------------------------------------------------------------------

  it("does not start the read loop when aborted during an async onOpen", async () => {
    const controller = new AbortController();
    const onMessage = vi.fn();
    const onClose = vi.fn();
    const mockFetch = vi
      .fn()
      .mockResolvedValue(mockSSEResponse([sseChunk("data: 1")]));

    await fetchEventSource("http://test/sse", {
      fetch: mockFetch,
      signal: controller.signal,
      onMessage,
      onClose,
      async onOpen() {
        controller.abort();
        await Promise.resolve();
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(onMessage).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith({
      reason: FetchEventSourceCloseReason.Aborted,
      receiveState: ReceiveState.IDLE,
    });
  });

  // -----------------------------------------------------------------------
  // Regression (Codex round-3 High): an abort during an async classifyError
  // that returns fatal must not let the stale error reject the promise after
  // the abort path has resolved it.
  // -----------------------------------------------------------------------

  it("lets abort win over a late fatal classifyError verdict", async () => {
    const controller = new AbortController();
    const onClose = vi.fn(
      () => new Promise<void>((resolve) => setTimeout(resolve, 5)),
    );
    let firstThrow = false;
    const mockFetch = vi
      .fn()
      .mockResolvedValue(mockSSEResponse([sseChunk("data: 1")]));

    await expect(
      fetchEventSource("http://test/sse", {
        fetch: mockFetch,
        signal: controller.signal,
        onClose,
        onMessage() {
          if (!firstThrow) {
            firstThrow = true;
            throw new Error("boom");
          }
        },
        async classifyError() {
          controller.abort();
          await Promise.resolve();
          return FetchEventSourceDecision.Fatal;
        },
      }),
    ).resolves.toBeUndefined();

    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith({
      reason: FetchEventSourceCloseReason.Aborted,
      receiveState: expect.any(String),
    });
  });

  // -----------------------------------------------------------------------
  // Regression (Codex round-3 Medium reproduction): same race for
  // `rejectKeepingResponse` — abort during async classifyResponse that would
  // return fatal must not reject with ResponseError.
  // -----------------------------------------------------------------------

  it("lets abort win over a late fatal classifyResponse verdict", async () => {
    const controller = new AbortController();
    const onClose = vi.fn(
      () => new Promise<void>((resolve) => setTimeout(resolve, 5)),
    );
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("nope", {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      fetchEventSource("http://test/sse", {
        fetch: mockFetch,
        signal: controller.signal,
        onClose,
        async classifyResponse() {
          controller.abort();
          await Promise.resolve();
          return FetchEventSourceDecision.Fatal;
        },
      }),
    ).resolves.toBeUndefined();

    expect(onClose).toHaveBeenCalledWith({
      reason: FetchEventSourceCloseReason.Aborted,
      receiveState: ReceiveState.IDLE,
    });
  });

  // -----------------------------------------------------------------------
  // Regression (Low): default content-type check matches the media type by
  // its boundary, not a raw prefix.
  // -----------------------------------------------------------------------

  it("accepts text/event-stream with parameters but rejects look-alike media types", async () => {
    const messages: string[] = [];
    await fetchEventSource("http://test/sse", {
      fetch: vi.fn().mockResolvedValue(
        mockSSEResponse([sseChunk("data: ok")], {
          contentType: "text/event-stream; charset=utf-8",
        }),
      ),
      onMessage(ev) {
        messages.push(ev.data);
      },
    });
    expect(messages).toEqual(["ok"]);

    await expect(
      fetchEventSource("http://test/sse", {
        fetch: vi.fn().mockResolvedValue(
          mockSSEResponse([sseChunk("data: no")], {
            contentType: "text/event-streamevil",
          }),
        ),
      }),
    ).rejects.toBeInstanceOf(ResponseError);
  });
});
