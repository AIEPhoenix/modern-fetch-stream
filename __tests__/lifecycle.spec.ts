import { describe, expect, it, vi } from "vitest";
import { FatalError, fetchEventSource } from "../src/index";

const sse = (data = "data: 1\n\ndata: 2\n\ndata: 3\n\n") =>
  new Response(data, { headers: { "content-type": "text/event-stream" } });

describe("connection lifecycle boundaries", () => {
  it("does not deliver buffered messages after cancellation", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    await fetchEventSource("http://test", {
      signal: controller.signal,
      fetch: async () => sse(),
      onMessage(event) {
        events.push(event.data);
        controller.abort();
      },
      onClose() { events.push("closed"); },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["1", "closed"]);
  });

  it("releases a response when its classifier throws before retrying", async () => {
    const cancel = vi.fn();
    let attempts = 0;
    let cancelledBeforeRetry = false;
    await fetchEventSource("http://test", {
      fetch: async () => {
        if (++attempts === 1) return new Response(new ReadableStream({ cancel }));
        cancelledBeforeRetry = cancel.mock.calls.length === 1;
        return sse();
      },
      classifyResponse() {
        if (attempts === 1) throw new Error("classifier failed");
        return "accept";
      },
      classifyError: () => ({ retryAfter: 0 }),
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancelledBeforeRetry).toBe(true);
  });

  it("accepts a null signal", async () => {
    await expect(fetchEventSource("http://test", {
      signal: null,
      fetch: async () => sse(),
    })).resolves.toBeUndefined();
  });

  it("cancels the body while an async message handler is still pending", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const onMessage = vi.fn(async () => { entered(); await pending; });
    const task = fetchEventSource("http://test", {
      signal: controller.signal,
      fetch: async () => new Response(new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode("data: 1\n\ndata: 2\n\n"));
        },
        cancel,
      }), { headers: { "content-type": "text/event-stream" } }),
      onMessage,
    });
    try {
      await started;
      controller.abort();
      await task;
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    } finally {
      release();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onMessage).toHaveBeenCalledOnce();
  });

  it("unblocks a pending read when a custom fetch ignores cancellation", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    let ready!: () => void;
    const reading = new Promise<void>((resolve) => { ready = resolve; });
    const task = fetchEventSource("http://test", {
      signal: controller.signal,
      fetch: async () => new Response(new ReadableStream({
        pull() { ready(); },
        cancel,
      }), { headers: { "content-type": "text/event-stream" } }),
    });
    await reading;
    // Allow onOpen and pipeline setup to finish before aborting a pending read.
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await task;
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it.each(["request", "stream"])("stops retrying a consumed %s body", async (kind) => {
    const input = kind === "request"
      ? new Request("http://test", { method: "POST", body: "hello" })
      : "http://test";
    const fetch = vi.fn(async () => sse());
    const classifyError = vi.fn(() => ({ retryAfter: 0 }));
    const controller = new AbortController();
    // Bound the old implementation's infinite retry loop.
    const timeout = setTimeout(() => controller.abort(), 100);
    try {
      await expect(fetchEventSource(input, {
        signal: controller.signal,
        ...(kind === "stream" ? { method: "POST", body: new ReadableStream() } : {}),
        fetch,
        classifyResponse: () => ({ retryAfter: 0 }),
        classifyError,
      })).rejects.toBeInstanceOf(FatalError);
      expect(fetch).toHaveBeenCalledOnce();
      expect(classifyError).not.toHaveBeenCalled();
    } finally {
      clearTimeout(timeout);
    }
  });

  it("replays a string body and accepts Headers instances", async () => {
    let attempts = 0;
    await fetchEventSource("http://test", {
      method: "POST",
      body: "hello",
      headers: new Headers({ "x-test": "yes" }),
      fetch: async (_, init) => {
        attempts++;
        expect(init?.body).toBe("hello");
        expect(new Headers(init?.headers).get("x-test")).toBe("yes");
        return sse();
      },
      classifyResponse: () => attempts === 1 ? { retryAfter: 0 } : "accept",
    });
    expect(attempts).toBe(2);
  });
});
