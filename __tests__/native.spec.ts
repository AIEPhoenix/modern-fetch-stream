import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FatalError, fetchEventSource } from "../src/index";

describe("native fetch lifecycle", () => {
  let server: Server;
  let url: string;
  let bodies: string[];

  beforeEach(async () => {
    bodies = [];
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      bodies.push(Buffer.concat(chunks).toString());
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("data: 1\n\ndata: 2\n\ndata: 3\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    url = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it("stops buffered callbacks after abort", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    await fetchEventSource(url, {
      signal: controller.signal,
      onMessage(event) { events.push(event.data); controller.abort(); },
      onClose(close) { events.push(close.reason); },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["1", "aborted"]);
  });

  it("sends a Request body once successfully", async () => {
    await fetchEventSource(new Request(url, { method: "POST", body: "hello" }));
    expect(bodies).toEqual(["hello"]);
  });

  it("fails clearly before retrying a consumed Request", async () => {
    await expect(fetchEventSource(new Request(url, { method: "POST", body: "hello" }), {
      classifyResponse: () => ({ retryAfter: 0 }),
    })).rejects.toThrow(FatalError);
    expect(bodies).toEqual(["hello"]);
  });

  it("replays reusable POST bodies", async () => {
    let attempts = 0;
    await fetchEventSource(url, {
      method: "POST",
      body: "hello",
      classifyResponse: () => ++attempts === 1 ? { retryAfter: 0 } : "accept",
    });
    expect(bodies).toEqual(["hello", "hello"]);
  });

  it("replays an explicit reusable body overriding a Request body", async () => {
    let attempts = 0;
    await fetchEventSource(new Request(url, { method: "POST", body: "original" }), {
      body: "replacement",
      classifyResponse: () => ++attempts === 1 ? { retryAfter: 0 } : "accept",
    });
    expect(bodies).toEqual(["replacement", "replacement"]);
  });
});
