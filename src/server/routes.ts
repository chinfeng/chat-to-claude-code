/** HTTP route handlers for Anthropic-compatible API. */

import { buildBaseRequestBody, ReasoningReplayMode } from "../conversion/converter.js";
import type { RequestData } from "../conversion/converter.js";
import { streamOpenAIChatToAnthropicSse } from "../transport/stream.js";
import { estimateInputTokens } from "../core/tokens.js";
import { invalidRequestError, authenticationError, upstreamError, serverError } from "../core/errors.js";
import type { ServerConfig } from "./config.js";
import { resolveModelExtra, deepMerge } from "./config.js";
import { ANTHROPIC_SSE_RESPONSE_HEADERS } from "../sse/builder.js";
import { createDumpSession, type DumpTermination, type TerminationReason } from "../core/dump.js";

/** Whether passthrough mode is active: no upstream key and no downstream auth token. */
function isPassthroughMode(config: ServerConfig): boolean {
  return !config.upstreamApiKey && !config.authToken;
}

/** Validate downstream auth token when AUTH_TOKEN is configured. */
function validateAuthToken(request: Request, config: ServerConfig): boolean {
  if (!config.authToken) return true;
  const clientKey = request.headers.get("x-api-key") || request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  return clientKey === config.authToken;
}

/** Resolve the API key: passthrough from client header, or server config. */
function resolveApiKey(request: Request, config: ServerConfig): string | null {
  const clientKey = request.headers.get("x-api-key") || request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (isPassthroughMode(config) && clientKey) return clientKey;
  if (config.upstreamApiKey) return config.upstreamApiKey;
  return null;
}

/** Extract request headers as a plain object for dump logging. */
function extractRequestHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

/** Extract response headers as a plain object for dump logging. */
function extractResponseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

/** Parse and validate the Anthropic /v1/messages request body. */
function parseMessagesBody(body: unknown): { data: RequestData; error?: never } | { data?: never; error: { json: unknown; status: number } } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: invalidRequestError("Request body must be a JSON object.") };
  }
  const b = body as Record<string, unknown>;
  const model = b.model;
  if (typeof model !== "string" || !model) {
    return { error: invalidRequestError("`model` is required and must be a string.") };
  }
  const messages = b.messages;
  if (!Array.isArray(messages)) {
    return { error: invalidRequestError("`messages` is required and must be an array.") };
  }
  return {
    data: {
      model,
      messages,
      system: b.system,
      max_tokens: b.max_tokens as number | undefined,
      temperature: b.temperature as number | undefined,
      top_p: b.top_p as number | undefined,
      stop_sequences: b.stop_sequences as string[] | undefined,
      tools: b.tools as Record<string, unknown>[] | undefined,
      tool_choice: b.tool_choice,
      server_tools: b.server_tools as Record<string, unknown>[] | undefined,
    },
  };
}

/** Build the upstream OpenAI-compatible fetch request. */
function buildUpstreamRequest(requestData: RequestData, apiKey: string, config: ServerConfig): { request: Request; requestBody: string; requestHeaders: Record<string, string> } {
  let body = buildBaseRequestBody(requestData, 4096, ReasoningReplayMode.THINK_TAGS);
  const url = `${config.upstreamBaseUrl.replace(/\/+$/, "")}/chat/completions`;
  body.stream = true;

  const extra = resolveModelExtra(requestData.model, config.modelOverrides);
  if (Object.keys(extra).length) {
    body = deepMerge(body, extra);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
  };
  const requestBody = JSON.stringify(body, null, 2);

  const request = new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  return { request, requestBody, requestHeaders: headers };
}

/** Parse an SSE line from the upstream into a JSON object. */
function parseSseLine(line: string): unknown | null {
  if (!line.startsWith("data: ")) return null;
  const data = line.slice(6).trim();
  if (data === "[DONE]") return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/** Convert an upstream ReadableStream into AsyncIterable of parsed chunks,
 * while also collecting raw upstream text for dump logging.
 * Handles both \n and \r\n line endings from upstream / reverse proxies. */
async function* iterUpstreamChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  rawChunks?: string[],
): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      let value: Uint8Array | undefined;
      let done: boolean;
      try {
        ({ done, value } = await reader.read());
      } catch (e) {
        // Network error or proxy disconnection mid-stream — propagate as error
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Upstream stream read error: ${msg}`);
      }
      if (done) break;

      const decoded = decoder.decode(value, { stream: true });
      if (rawChunks) rawChunks.push(decoded);
      buffer += decoded;
      // Split on \n — handles both \n (LF) and \r\n (CRLF) since we .trim() below
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const chunk = parseSseLine(trimmed);
        if (chunk) yield chunk;
      }
    }

    // flush remaining buffer
    if (buffer.trim()) {
      const chunk = parseSseLine(buffer.trim());
      if (chunk) yield chunk;
    }
  } finally {
    // Always release the reader lock so the stream can be properly cleaned up
    try { reader.releaseLock(); } catch { /* already released or cancelled */ }
  }
}

/** Handle POST /v1/messages. */
export async function handleMessages(request: Request, config: ServerConfig): Promise<Response> {
  const dump = createDumpSession(config.dumpDir);
  const requestStartMs = Date.now();
  const requestDatetime = new Date().toISOString();

  // Validate downstream auth token when configured
  if (!validateAuthToken(request, config)) {
    const err = authenticationError("Invalid auth token. Provide correct x-api-key header.");
    dump.finish();
    return Response.json(err.json, { status: err.status });
  }

  const apiKey = resolveApiKey(request, config);
  if (!apiKey) {
    const err = authenticationError("No API key provided. Set --upstream-api-key or enable passthrough mode (no upstream key and no auth token).");
    dump.finish();
    return Response.json(err.json, { status: err.status });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    const err = invalidRequestError("Invalid JSON in request body.");
    dump.finish();
    return Response.json(err.json, { status: err.status });
  }

  // Log downstream request with headers and datetime
  const requestHeaders = extractRequestHeaders(request);
  dump.writeDownstreamRequest({
    headers: requestHeaders,
    datetime: requestDatetime,
    body: JSON.stringify(body, null, 2),
  });

  const parsed = parseMessagesBody(body);
  if ("error" in parsed && parsed.error) {
    dump.finish();
    return Response.json(parsed.error.json, { status: parsed.error.status });
  }

  const requestData = parsed.data;
  const inputTokens = estimateInputTokens(requestData.messages);

  // Forward the client's abort signal so fetch() is cancelled when the
  // downstream client disconnects mid-request — otherwise fetch() hangs
  // indefinitely and dump.finish() is never called.  Must pass signal
  // via the second argument of fetch() because Bun does not propagate
  // Request.signal through fetch(request) to the init layer.
  const abortSignal = request.signal;
  const { request: upstreamReq, requestBody: upstreamRequestBody, requestHeaders: upstreamReqHeaders } = buildUpstreamRequest(requestData, apiKey, config);

  // Log upstream request (what the proxy sends to the upstream API)
  dump.writeUpstreamRequest({
    headers: upstreamReqHeaders,
    datetime: new Date().toISOString(),
    body: upstreamRequestBody,
  });
  let upstreamRes: Response;
  let ttfb: number | undefined;
  try {
    upstreamRes = await fetch(upstreamReq, { signal: abortSignal });
    ttfb = Date.now() - requestStartMs;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isAbort = abortSignal?.aborted || (e instanceof DOMException && e.name === "AbortError");
    const disconnectTime = new Date().toISOString();
    const termination: DumpTermination = isAbort
      ? { reason: "client_abort", disconnectTime }
      : { reason: "upstream_timeout", disconnectTime };
    dump.writeUpstreamResponse({ headers: {}, status: 0, body: "", termination });
    dump.writeDownstreamResponse({
      headers: {},
      status: isAbort ? 499 : 502,
      body: JSON.stringify(isAbort
        ? upstreamError(`Client disconnected before upstream responded: ${msg}`, 499).json
        : upstreamError(`Failed to connect to upstream: ${msg}`, 502).json),
      termination,
    });
    const err = isAbort
      ? upstreamError(`Client disconnected before upstream responded: ${msg}`, 499)
      : upstreamError(`Failed to connect to upstream: ${msg}`, 502);
    dump.finish();
    return Response.json(err.json, { status: err.status });
  }

  // Log upstream response headers and status
  const upstreamHeaders = extractResponseHeaders(upstreamRes);
  const upstreamStatus = upstreamRes.status;

  if (!upstreamRes.ok) {
    const errBody = await upstreamRes.text().catch(() => "");
    const termination: DumpTermination = { reason: "upstream_error", disconnectTime: new Date().toISOString() };
    dump.writeUpstreamResponse({
      headers: upstreamHeaders,
      status: upstreamStatus,
      body: errBody,
      termination,
    });
    const mappedStatus = upstreamRes.status >= 500 ? 502 : upstreamRes.status;
    const err = upstreamError(
      `Upstream returned ${upstreamRes.status}: ${errBody.slice(0, 500)}`,
      mappedStatus,
    );
    dump.writeDownstreamResponse({
      headers: {},
      status: mappedStatus,
      body: JSON.stringify(err.json),
      termination,
    });
    if (ttfb !== undefined) {
      dump.setTiming({ ttfb, totalTime: Date.now() - requestStartMs });
    }
    dump.finish();
    return Response.json(err.json, { status: err.status });
  }

  const upstreamBody = upstreamRes.body;
  if (!upstreamBody) {
    const termination: DumpTermination = { reason: "upstream_error", disconnectTime: new Date().toISOString() };
    dump.writeUpstreamResponse({
      headers: upstreamHeaders,
      status: upstreamStatus,
      body: "",
      termination,
    });
    const err = serverError("Upstream returned empty body.");
    dump.writeDownstreamResponse({
      headers: {},
      status: 500,
      body: JSON.stringify(err.json),
      termination,
    });
    if (ttfb !== undefined) {
      dump.setTiming({ ttfb, totalTime: Date.now() - requestStartMs });
    }
    dump.finish();
    return Response.json(err.json, { status: err.status });
  }

  const reader = upstreamBody.getReader();
  const rawUpstreamChunks: string[] = [];
  const chunks = iterUpstreamChunks(reader, rawUpstreamChunks);
  const sseEvents = streamOpenAIChatToAnthropicSse(
    chunks as AsyncIterable<import("../transport/stream.js").StreamChunk>,
    requestData,
    inputTokens,
    config.enableThinking,
    config.serverTools,
    dump,
  );

  const downstreamChunks: string[] = [];
  let downstreamAborted = false;
  let dumpFinished = false;
  let terminationReason: TerminationReason = "completed";

  /** Write dump logs and finish. Safe to call from both start() and cancel()
   * — the finished guard prevents double writes. */
  function finalizeDump(): void {
    if (dumpFinished) return;
    dumpFinished = true;
    const disconnectTime = terminationReason !== "completed" ? new Date().toISOString() : undefined;
    const termination: DumpTermination = { reason: terminationReason, disconnectTime };
    dump.writeUpstreamResponse({
      headers: upstreamHeaders,
      status: upstreamStatus,
      body: rawUpstreamChunks.join(""),
      termination,
    });
    dump.writeDownstreamResponse({
      headers: downstreamHeaders,
      status: 200,
      body: downstreamChunks.join(""),
      termination,
    });
    if (ttfb !== undefined) {
      dump.setTiming({ ttfb, totalTime: Date.now() - requestStartMs });
    }
    dump.finish();
  }

  const downstreamHeaders: Record<string, string> = {
    "Content-Type": "text/event-stream",
    ...ANTHROPIC_SSE_RESPONSE_HEADERS,
  };

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      // Fire-and-forget: start the SSE pump AFTER start() resolves so the
      // stream is "started" and the controller respects backpressure from
      // downstream pulls. Running the for-await loop directly inside
      // start() causes all enqueue()s to fire before the stream signals
      // readiness — the internal highWaterMark saturates and further
      // events are silently dropped, leaving the downstream client with
      // only message_start (output_tokens=1).
      (async () => {
        try {
          try {
            for await (const event of sseEvents) {
              if (downstreamAborted) break;
              downstreamChunks.push(event as string);
              controller.enqueue(encoder.encode(event));
            }
          } catch (e) {
            if (!downstreamAborted) {
              terminationReason = "upstream_abort";
              const msg = e instanceof Error ? e.message : String(e);
              const errLine = `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: msg } })}\n\n`;
              downstreamChunks.push(errLine);
              try { controller.enqueue(encoder.encode(errLine)); } catch { /* stream already closed */ }
            }
          }
        } finally {
          finalizeDump();
          try { controller.close(); } catch { /* already closed by cancel */ }
        }
      })();
    },
    cancel() {
      downstreamAborted = true;
          terminationReason = "client_abort";
      finalizeDump();
      reader.cancel().catch(() => {});
    },
  });

  return new Response(readable, {
    status: 200,
    headers: downstreamHeaders,
  });
}

/** Route a request to the appropriate handler. */
export async function routeRequest(request: Request, config: ServerConfig): Promise<Response> {
  const url = new URL(request.url);

  // Health check
  if (url.pathname === "/health" && request.method === "GET") {
    return Response.json({ status: "ok" });
  }

  // Anthropic Messages API
  if (url.pathname === "/v1/messages" && request.method === "POST") {
    return handleMessages(request, config);
  }

  // Fallback
  return Response.json({ type: "error", error: { type: "not_found_error", message: `No route for ${request.method} ${url.pathname}` } }, { status: 404 });
}
