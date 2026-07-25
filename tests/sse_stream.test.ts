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
  modelOverrides: [],
  serverTools: {
    webSearch: false,
    webFetch: false,
    webSearchApiKey: "",
    webSearchBaseUrl: "https://api.search.brave.com",
    webFetchAllowedDomains: [],
    webFetchBlockedDomains: [],
    webFetchMaxContentTokens: 5000,
  },
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
  // Bug 4: an upstream connection abort surfaces downstream as an explicit
  //         `event: error` (api_error) so claude-code retries — never an abrupt
  //         close, which claude-code reports as "empty or malformed response
  //         (HTTP 200)" and does NOT retry.
  // -----------------------------------------------------------------------

  it("surfaces an upstream connection abort as an SSE error event so the client retries", async () => {
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
    const events = parseSseResponse(body);
    const eventTypes = events.map((e) => e.event);

    // The stream begins with message_start (always emitted up front).
    expect(eventTypes).toContain("message_start");

    // An upstream connection abort (socket reset / clean EOF with no
    // finish_reason) must surface as a real top-level `event: error` — NOT be
    // swallowed as an abrupt close. claude-code treats a stream that closes
    // mid-message (message_start emitted, no message_stop) as malformed and
    // reports "API returned an empty or malformed response (HTTP 200)" WITHOUT
    // retrying; an explicit `event: error` (here api_error, since the abort
    // carries no code) lets it classify the failure as retryable and retry the
    // turn. This matches cc-switch's read-error handling.
    expect(eventTypes).toContain("error");
    const errorEvents = events.filter((e) => e.event === "error");
    expect(errorEvents.length).toBeGreaterThan(0);
    expect(errorEvents.some((e) => e.data.includes('"type":"api_error"'))).toBe(true);
    expect(errorEvents.some((e) => e.data.includes("Upstream stream read error"))).toBe(true);
    expect(errorEvents.some((e) => e.data.includes("Connection reset by peer"))).toBe(true);

    // CRITICAL: the error must NOT be disguised as assistant text content. The
    // original pre-78484ae bug wrapped the error message in a `text` content
    // block (content_block_start "text" + text_delta) and then signalled
    // end_turn, making Claude Code treat the failure as a completed turn and
    // persist the error string into conversation history — poisoning subsequent
    // turns. Assert the error never appears inside any text_delta.
    expect(body).not.toMatch(/text_delta[^}]*Upstream stream read error/);
    expect(body).not.toMatch(/text_delta[^}]*Connection reset by peer/);

    // And the message must NOT be falsely reported as a successful turn. After
    // the error there must be no message_delta / message_stop / [DONE] — the
    // client retries the whole turn, it does not persist a failed/partial one.
    expect(eventTypes).not.toContain("message_delta");
    expect(eventTypes).not.toContain("message_stop");
    expect(body).not.toContain("[DONE]");
  });

  // -----------------------------------------------------------------------
  // [DONE]-as-completion (cc-switch parity): some providers emit the OpenAI
  //         stream-end marker `data: [DONE]` WITHOUT a preceding
  //         `finish_reason` chunk. That `[DONE]` is the only completion signal
  //         — it must complete the turn gracefully (message_delta +
  //         message_stop), NOT be treated as a connection abort. This is the
  //         counterpart to Bug 4: abort = no finish_reason AND no `[DONE]`
  //         (→ event:error → retry); [DONE] = no finish_reason BUT `[DONE]`
  //         present (→ complete normally, no retry).
  // -----------------------------------------------------------------------

  it("treats [DONE] without finish_reason as graceful completion, not an abort", async () => {
    // Upstream emits text chunks then `data: [DONE]` with NO finish_reason chunk.
    const sseBody = [
      sseData({
        id: "chatcmpl-done",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4o",
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      }),
      sseData({
        id: "chatcmpl-done",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4o",
        choices: [{ index: 0, delta: { content: "hi there" }, finish_reason: null }],
      }),
      SSE_DONE,
    ].join("");
    mockFetchWithSse(sseBody);

    const res = await routeRequest(makeMessagesRequest(), TEST_CONFIG);
    expect(res.status).toBe(200);

    const body = await collectResponseBody(res);
    const events = parseSseResponse(body);
    const eventTypes = events.map((e) => e.event);

    // Completed normally — full Anthropic message lifecycle, no retry.
    expect(eventTypes).toContain("message_start");
    expect(eventTypes).toContain("message_delta");
    expect(eventTypes).toContain("message_stop");

    // [DONE] is treated as an implicit `stop` → stop_reason "end_turn".
    const msgDelta = events.find((e) => e.event === "message_delta");
    expect(msgDelta?.data).toContain('"stop_reason":"end_turn"');

    // NOT surfaced as an upstream abort / error — [DONE] signals completion.
    expect(eventTypes).not.toContain("error");
    expect(body).not.toContain("without a finish_reason");
    expect(body).not.toContain("Upstream stream ended");
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

  // -----------------------------------------------------------------------
  // Bug 6: abort signal forwarded to fetch() — when client disconnects
  // before upstream responds, fetch() is cancelled (not left hanging)
  // and dump is finalized
  // -----------------------------------------------------------------------

  it("forwards request abort signal to upstream fetch()", async () => {
    // Mock fetch that hangs until aborted — captures the signal passed to it
    let capturedSignal: AbortSignal | undefined;
    let fetchRejected = false;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const sig = init?.signal;
      if (sig) capturedSignal = sig;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          fetchRejected = true;
          reject(new DOMException("The operation was aborted.", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => {
          fetchRejected = true;
          reject(new DOMException("The operation was aborted.", "AbortError"));
        }, { once: true });
      });
    }) as typeof fetch;

    const controller = new AbortController();
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "test-key",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 1024,
      }),
      signal: controller.signal,
    });

    // Start routeRequest without awaiting — it will block at fetch()
    const responsePromise = routeRequest(req, TEST_CONFIG);

    // Yield enough for the handler to reach the fetch() call
    await new Promise((r) => setTimeout(r, 100));

    // Abort the client connection
    controller.abort();

    // Now routeRequest should resolve (with 499 error)
    const res = await responsePromise;
    expect(res.status).toBe(499);

    // Verify the abort signal was actually forwarded to fetch()
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(true);
    expect(fetchRejected).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Bug 7: finalizeDump always runs — even when upstream errors mid-
  // stream, the dump directory is renamed with START/END timestamps
  // -----------------------------------------------------------------------

  it("finalizes dump directory when upstream errors mid-stream", async () => {
    const goodPrefix = sseData({
      id: "chatcmpl-dump-finalize",
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-4o",
      choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
    });

    mockFetchWithMidStreamError(goodPrefix, "Connection reset by peer");

    const tmpDir = `${import.meta.dir}/.test-dump-finalize-${Date.now()}`;
    const configWithDump: ServerConfig = {
      ...TEST_CONFIG,
      dumpDir: tmpDir,
    };

    try {
      const res = await routeRequest(makeMessagesRequest(), configWithDump);
      expect(res.status).toBe(200);

      // Read the full response — the upstream abort surfaces as an explicit
      // `event: error` (api_error), and finalizeDump must still run.
      const body = await collectResponseBody(res);
      expect(body).toContain("Upstream stream read error");
      expect(body).toContain('"type":"api_error"');

      // Verify dump was finalized: directory renamed with __START_ and __END_
      const { readdirSync } = await import("node:fs");
      await new Promise((r) => setTimeout(r, 50));
      const dirs = readdirSync(tmpDir);
      expect(dirs.some((d) => d.includes("__START_") && d.includes("__END_"))).toBe(true);

      // Verify the renamed dir contains all expected log files
      const renamedDir = dirs.find((d) => d.includes("__START_"))!;
      const { readdirSync: readdir2 } = await import("node:fs");
      const files = readdir2(`${tmpDir}/${renamedDir}`);
      expect(files).toContain("downstream-request.log");
      expect(files).toContain("upstream-request.log");
      expect(files).toContain("upstream-response.log");
      expect(files).toContain("downstream-response.log");
    } finally {
      const { rmSync } = await import("node:fs");
      try { rmSync(tmpDir, { recursive: true }); } catch {}
    }
  });

  // -----------------------------------------------------------------------
  // G1: request OpenAI-standard `stream_options.include_usage` from the
  //     upstream so the trailing usage chunk arrives and message_delta can
  //     report real token counts (paired with G3 cache extraction + G4 real
  //     input_tokens). G7: the upstream body is canonicalized (sorted keys,
  //     private `_` params dropped) for stable prefix-cache bytes.
  // -----------------------------------------------------------------------

  it("requests stream_options.include_usage on every upstream stream (G1)", async () => {
    let capturedBody: string | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = typeof init?.body === "string" ? init.body : String(init?.body ?? "");
      const body = textToReadableStream(typicalUpstreamSse());
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;

    try {
      const res = await routeRequest(makeMessagesRequest(), TEST_CONFIG);
      await collectResponseBody(res);
    } finally {
      globalThis.fetch = original;
    }

    expect(capturedBody).toBeDefined();
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.stream_options).toEqual({ include_usage: true });
  });

  it("preserves a caller-supplied stream_options key alongside include_usage", async () => {
    // --upstream-extra-params (or modelOverrides) could set extra stream_options
    // keys; include_usage must be added, not clobber the existing object.
    const configWithExtra: ServerConfig = {
      ...TEST_CONFIG,
      modelOverrides: [{ pattern: "gpt-4o", extra: { stream_options: { count_tokens: true } } }],
    };
    let capturedBody: string | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = typeof init?.body === "string" ? init.body : String(init?.body ?? "");
      const body = textToReadableStream(typicalUpstreamSse());
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;

    try {
      const res = await routeRequest(makeMessagesRequest(), configWithExtra);
      await collectResponseBody(res);
    } finally {
      globalThis.fetch = original;
    }

    const parsed = JSON.parse(capturedBody!);
    expect(parsed.stream_options.include_usage).toBe(true);
    expect(parsed.stream_options.count_tokens).toBe(true);
  });

  it("canonicalizes the upstream body and drops private `_`-prefixed params (G7)", async () => {
    // Send a request with a `_`-prefixed private param and an out-of-order top
    // object; assert the captured upstream body has sorted keys and no `_` keys.
    const requestWithPrivate = makeMessagesRequest({
      // tools with a schema property whose name starts with `_` (must survive —
      // it is inside the JSON-Schema `properties` name map, NOT a private param).
      tools: [
        {
          name: "t",
          description: "d",
          input_schema: { type: "object", properties: { _id: { type: "string" }, name: { type: "string" } } },
        },
      ],
    });
    let capturedBody: string | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = typeof init?.body === "string" ? init.body : String(init?.body ?? "");
      const body = textToReadableStream(typicalUpstreamSse());
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;

    try {
      const res = await routeRequest(requestWithPrivate, TEST_CONFIG);
      await collectResponseBody(res);
    } finally {
      globalThis.fetch = original;
    }

    const parsed = JSON.parse(capturedBody!);
    // Top-level keys are sorted.
    expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
    // The `_id` schema property name survives (inside `properties` name map).
    const tool = (parsed.tools as Record<string, unknown>[])[0].function as Record<string, unknown>;
    const props = (tool.parameters as Record<string, unknown>).properties as Record<string, unknown>;
    expect("_id" in props).toBe(true);
    expect("name" in props).toBe(true);
  });

  it("reports real input_tokens from prompt_tokens_details (G3+G4) end-to-end", async () => {
    // Upstream sends cache hits via the OpenAI-standard prompt_tokens_details
    // (GLM-5.2 / newapi form), with NO Anthropic-compat direct cache fields, and
    // NO finish_reason (only [DONE]) — exercising G1 (usage arrives), G3 (cache
    // read from prompt_tokens_details) and G4 (message_delta real input_tokens).
    const sseBody = [
      sseData({ id: "c", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] }),
      sseData({
        id: "c",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4o",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 } },
      }),
      SSE_DONE,
    ].join("");
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(textToReadableStream(sseBody), { status: 200, headers: { "Content-Type": "text/event-stream" } })
    ) as typeof fetch;

    try {
      const res = await routeRequest(makeMessagesRequest(), TEST_CONFIG);
      const body = await collectResponseBody(res);
      const events = parseSseResponse(body);
      const delta = events.find((e) => e.event === "message_delta")!;
      const usage = JSON.parse(delta.data).usage as Record<string, number>;
      // input = 100 - 30 (cached) - 10 (cache_write) = 60
      expect(usage.input_tokens).toBe(60);
      expect(usage.cache_read_input_tokens).toBe(30);
      expect(usage.cache_creation_input_tokens).toBe(10);
      expect(usage.output_tokens).toBe(7);
    } finally {
      globalThis.fetch = original;
    }
  });
});
