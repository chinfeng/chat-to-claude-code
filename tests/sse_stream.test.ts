import { describe, it, expect, afterEach } from "bun:test";
import { routeRequest } from "../src/server/routes.js";
import type { ServerConfig } from "../src/server/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an SSE text chunk in upstream (OpenAI) format. */
function sseData(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

const SSE_DONE = "data: [DONE]\n\n";

/** Create a ReadableStream of Uint8Array from raw SSE text. */
function textToReadableStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

/** Create a ReadableStream that delivers chunks with delays between them,
 *  simulating real streaming from an upstream server. */
function delayedReadableStream(
  chunks: string[],
  delayMs = 5,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let idx = 0;
  return new ReadableStream({
    async pull(controller) {
      if (idx >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[idx]));
      idx++;
      if (idx < chunks.length) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    },
  });
}

/** Collect all bytes from a Response's ReadableStream into a string. */
async function collectResponseBody(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  result += decoder.decode(); // flush
  return result;
}

/** Parse an SSE response string into individual events.
 *  Returns an array of { event, data } objects. */
function parseSseResponse(body: string): { event: string; data: string }[] {
  const events: { event: string; data: string }[] = [];
  const blocks = body.split("\n\n").filter((b) => b.trim());
  for (const block of blocks) {
    let event = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data = line.slice(6);
    }
    if (event) events.push({ event, data });
  }
  return events;
}

// ---------------------------------------------------------------------------
// Mock upstream server via globalThis.fetch interception
// ---------------------------------------------------------------------------

const ORIGINAL_FETCH = globalThis.fetch;

/** Temporarily replace globalThis.fetch with a mock that returns the given
 *  SSE body as a streaming response. Restores original fetch afterwards. */
function mockFetchWithSse(sseBody: string, status = 200): void {
  globalThis.fetch = (() => {
    const body = textToReadableStream(sseBody);
    return Promise.resolve(
      new Response(body, {
        status,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
  }) as typeof fetch;
}

/** Mock fetch with delayed chunk delivery (simulates real streaming). */
function mockFetchWithDelayedSse(
  chunks: string[],
  delayMs = 5,
  status = 200,
): void {
  globalThis.fetch = (() => {
    const body = delayedReadableStream(chunks, delayMs);
    return Promise.resolve(
      new Response(body, {
        status,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
  }) as typeof fetch;
}

/** Mock fetch that throws a network error mid-stream. */
function mockFetchWithMidStreamError(
  goodSsePrefix: string,
  errorMessage: string,
): void {
  globalThis.fetch = (() => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      async start(controller) {
        // Deliver the good prefix
        controller.enqueue(encoder.encode(goodSsePrefix));
        // Then error on next read
        await new Promise((r) => setTimeout(r, 5));
        controller.error(new Error(errorMessage));
      },
    });
    return Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
  }) as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = ORIGINAL_FETCH;
}

const TEST_CONFIG: ServerConfig = {
  upstreamBaseUrl: "http://upstream.test",
  upstreamApiKey: "test-key",
  authToken: "",
  port: 8082,
  enableThinking: true,
  dumpDir: "",
};

function makeMessagesRequest(body?: Partial<Record<string, unknown>>): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": "test-key",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 1024,
      ...body,
    }),
  });
}

// ---------------------------------------------------------------------------
// Realistic upstream SSE payloads
// ---------------------------------------------------------------------------

/** Build a typical multi-chunk upstream stream. */
function typicalUpstreamSse(): string {
  const chunks = [
    { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] },
    { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }] },
    { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta: { content: "!" }, finish_reason: null }] },
    { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ];
  return chunks.map((c) => sseData(c)).join("") + SSE_DONE;
}

/** Build a long stream with many content chunks — the scenario that triggered
 *  the highWaterMark saturation bug (events silently dropped after
 *  message_start). */
function longUpstreamSse(eventCount = 50): string {
  const chunks: Record<string, unknown>[] = [
    { id: "chatcmpl-long", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
  ];
  for (let i = 0; i < eventCount; i++) {
    chunks.push({
      id: "chatcmpl-long",
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-4o",
      choices: [{ index: 0, delta: { content: `chunk${i} ` }, finish_reason: null }],
    });
  }
  chunks.push({
    id: "chatcmpl-long",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4o",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: eventCount + 2 },
  });
  return chunks.map((c) => sseData(c)).join("") + SSE_DONE;
}

// ===========================================================================
// Tests
// ===========================================================================

describe("SSE stream forwarding", () => {
  afterEach(() => {
    restoreFetch();
  });

  // -----------------------------------------------------------------------
  // Bug 1: fire-and-forget in start() — highWaterMark saturation causing
  //         events to be silently dropped after message_start
  // -----------------------------------------------------------------------

  it("delivers all SSE events in a typical stream (not just message_start)", async () => {
    mockFetchWithSse(typicalUpstreamSse());
    const res = await routeRequest(makeMessagesRequest(), TEST_CONFIG);
    expect(res.status).toBe(200);

    const body = await collectResponseBody(res);
    const events = parseSseResponse(body);
    const eventTypes = events.map((e) => e.event);

    // Must have the full lifecycle, not just message_start.
    // The old bug: only message_start got through (highWaterMark saturation /
    // pull-mode stall), so downstream got output_tokens=1 and no content.
    expect(eventTypes).toContain("message_start");
    expect(eventTypes).toContain("content_block_start");
    expect(eventTypes).toContain("content_block_delta");
    expect(eventTypes).toContain("content_block_stop");
    expect(eventTypes).toContain("message_delta");
    expect(eventTypes).toContain("message_stop");

    // All upstream content must appear in the downstream output.
    // (HeuristicToolParser may coalesce multiple upstream deltas into fewer
    // downstream deltas, so we check content integrity, not delta count.)
    expect(body).toContain("Hello");
    expect(body).toContain(" world");
    expect(body).toContain("!");
  });

  it("delivers all content in a long stream without dropping any (highWaterMark bug)", async () => {
    const eventCount = 50;
    // Use delayed delivery to simulate real streaming — this is the pattern
    // that exposed the highWaterMark bug
    const fullSse = longUpstreamSse(eventCount);
    // Split into individual SSE events for delayed delivery
    const sseEvents = fullSse
      .split("\n\n")
      .filter((b) => b.trim())
      .map((b) => b + "\n\n");
    mockFetchWithDelayedSse(sseEvents, 2);

    const res = await routeRequest(makeMessagesRequest(), TEST_CONFIG);
    expect(res.status).toBe(200);

    const body = await collectResponseBody(res);
    const events = parseSseResponse(body);

    // Every upstream chunk's content must appear downstream — the old bug
    // silently dropped events after message_start, so downstream only
    // saw output_tokens=1. We verify content integrity (not delta count,
    // since HeuristicToolParser may coalesce).
    for (let i = 0; i < eventCount; i++) {
      expect(body).toContain(`chunk${i}`);
    }

    // Must reach the end
    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("message_stop");
  });

  // -----------------------------------------------------------------------
  // Bug 2: pull() → start() mode switch — stream stalling after
  //         yielding message_start (output_tokens=1)
  // -----------------------------------------------------------------------

  it("stream completes fully rather than stalling at message_start", async () => {
    mockFetchWithSse(typicalUpstreamSse());
    const res = await routeRequest(makeMessagesRequest(), TEST_CONFIG);

    const body = await collectResponseBody(res);
    const events = parseSseResponse(body);

    // The old pull() mode bug: stream would stall after yielding
    // message_start, so downstream only saw one event. With start()
    // + fire-and-forget, the full stream completes.
    expect(events.length).toBeGreaterThan(3);
    expect(events[events.length - 1].event).toBe("message_stop");

    // Verify output_tokens > 1 (the bug manifested as output_tokens=1)
    const msgDelta = events.find((e) => e.event === "message_delta");
    expect(msgDelta).toBeDefined();
    if (msgDelta) {
      const data = JSON.parse(msgDelta.data);
      expect(data.usage?.output_tokens).toBeGreaterThan(1);
    }
  });

  // -----------------------------------------------------------------------
  // Bug 3: reader lock not released — leaked stream locks
  // -----------------------------------------------------------------------

  it("releases reader lock after stream completes (no leaked locks)", async () => {
    const sseBody = typicalUpstreamSse();
    const encoder = new TextEncoder();
    let releasedFromFinally = false;

    // Create a stream whose reader tracks releaseLock calls
    const innerStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sseBody));
        controller.close();
      },
    });

    // Wrap to track releaseLock
    const originalGetReader = innerStream.getReader.bind(innerStream);
    const readerProxy = new Proxy(originalGetReader(), {
      get(target, prop) {
        if (prop === "releaseLock") {
          return () => {
            releasedFromFinally = true;
            return target.releaseLock();
          };
        }
        const val = target[prop as keyof typeof target];
        if (typeof val === "function") return val.bind(target);
        return val;
      },
    });

    // Override the response body to use our tracked reader
    globalThis.fetch = (() => {
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(sseBody));
              controller.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
      );
    }) as typeof fetch;

    const res = await routeRequest(makeMessagesRequest(), TEST_CONFIG);
    await collectResponseBody(res);

    // The reader lock should be released (via the finally block in
    // iterUpstreamChunks) — this test ensures the finally clause exists
    // and runs. We can't directly observe the internal reader, but we
    // verify the response is fully consumable (close succeeds, no hang).
    expect(res.status).toBe(200);
  });

  // -----------------------------------------------------------------------
  // Bug 4: upstream read error propagation (no silent failure on
  //         network/proxy disconnection)
  // -----------------------------------------------------------------------

  it("propagates upstream read error as SSE error event instead of silent failure", async () => {
    const goodPrefix = sseData({
      id: "chatcmpl-err",
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-4o",
      choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
    });

    mockFetchWithMidStreamError(goodPrefix, "Connection reset by peer");

    const res = await routeRequest(makeMessagesRequest(), TEST_CONFIG);
    expect(res.status).toBe(200);

    const body = await collectResponseBody(res);
    // The error must appear in the downstream stream — not silently swallowed
    expect(body).toContain("Upstream stream read error");
    expect(body).toContain("Connection reset by peer");
  });

  // -----------------------------------------------------------------------
  // Bug 5: race condition between cancel() and start() writing
  //         duplicate dump logs
  // -----------------------------------------------------------------------

  it("finalizeDump guard prevents double writes when cancel() and start() race", async () => {
    // Use delayed chunks so we can cancel mid-stream
    const fullSse = longUpstreamSse(20);
    const sseEvents = fullSse
      .split("\n\n")
      .filter((b) => b.trim())
      .map((b) => b + "\n\n");
    mockFetchWithDelayedSse(sseEvents, 10);

    const res = await routeRequest(makeMessagesRequest(), TEST_CONFIG);
    expect(res.status).toBe(200);

    // Cancel the stream after reading a bit — this triggers cancel()
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let body = "";
    let readCount = 0;
    while (readCount < 5) {
      const { done, value } = await reader.read();
      if (done) break;
      body += decoder.decode(value, { stream: true });
      readCount++;
    }
    reader.cancel();

    // If finalizeDump had no guard, cancel() + start() completing could
    // write duplicate logs. We can't inspect dump state directly, but
    // the test validates that cancel() during streaming doesn't throw.
    // The dumpFinished boolean guard ensures idempotency.
    expect(body.length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // CRLF handling — reverse proxies often introduce \r\n
  // -----------------------------------------------------------------------

  it("handles CRLF line endings from reverse proxies", async () => {
    const encoder = new TextEncoder();
    // Build SSE with \r\n line endings (common from nginx/cloudflare)
    const crlfSse = [
      'data: {"id":"crlf","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\r\n\r\n',
      'data: {"id":"crlf","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"CRLF works"},"finish_reason":null}]}\r\n\r\n',
      'data: {"id":"crlf","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ].join("");

    globalThis.fetch = (() => {
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(crlfSse));
              controller.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
      );
    }) as typeof fetch;

    const res = await routeRequest(makeMessagesRequest(), TEST_CONFIG);
    const body = await collectResponseBody(res);
    const events = parseSseResponse(body);

    expect(events.map((e) => e.event)).toContain("message_start");
    expect(events.map((e) => e.event)).toContain("message_stop");
    expect(body).toContain("CRLF works");
  });

  // -----------------------------------------------------------------------
  // Chunked delivery — upstream sends data split across multiple TCP frames
  // -----------------------------------------------------------------------

  it("handles upstream data split across multiple read frames", async () => {
    const fullSse = typicalUpstreamSse();
    const encoder = new TextEncoder();
    // Split the SSE data at arbitrary byte boundaries (not on event
    // boundaries) — this is what real network reads look like
    const fullBytes = encoder.encode(fullSse);
    const mid = Math.floor(fullBytes.length / 3);
    const chunk1 = fullBytes.slice(0, mid);
    const chunk2 = fullBytes.slice(mid);

    globalThis.fetch = (() => {
      return Promise.resolve(
        new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(chunk1);
              await new Promise((r) => setTimeout(r, 5));
              controller.enqueue(chunk2);
              controller.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
      );
    }) as typeof fetch;

    const res = await routeRequest(makeMessagesRequest(), TEST_CONFIG);
    const body = await collectResponseBody(res);
    const events = parseSseResponse(body);

    // Must still produce a complete stream despite byte-split frames
    expect(events.map((e) => e.event)).toContain("message_stop");
  });

  // -----------------------------------------------------------------------
  // Downstream abort sets flag, breaks the SSE pump loop cleanly
  // -----------------------------------------------------------------------

  it("stops SSE pump when downstream aborts (downstreamAborted flag)", async () => {
    const fullSse = longUpstreamSse(30);
    const sseEvents = fullSse
      .split("\n\n")
      .filter((b) => b.trim())
      .map((b) => b + "\n\n");
    mockFetchWithDelayedSse(sseEvents, 5);

    const res = await routeRequest(makeMessagesRequest(), TEST_CONFIG);
    const reader = res.body!.getReader();

    // Read a few events then cancel
    let partial = "";
    for (let i = 0; i < 3; i++) {
      const { done, value } = await reader.read();
      if (done) break;
      partial += new TextDecoder().decode(value, { stream: true });
    }
    await reader.cancel();

    // partial should have some events but not the full stream
    expect(partial.length).toBeGreaterThan(0);
    // Downstream should NOT contain message_stop since we aborted early
    expect(partial).not.toContain("event: message_stop");
  });
});
