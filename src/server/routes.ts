/** HTTP route handlers for Anthropic-compatible API. */

import { randomUUID } from "crypto";
import { buildBaseRequestBody, ReasoningReplayMode } from "../conversion/converter.js";
import type { RequestData } from "../conversion/converter.js";
import { streamOpenAIChatToAnthropicSse } from "../transport/stream.js";
import type { StreamChunk } from "../transport/stream.js";
import { estimateInputTokens } from "../core/tokens.js";
import { invalidRequestError, authenticationError, upstreamError, serverError } from "../core/errors.js";
import type { ServerConfig, ServerToolConfig } from "./config.js";
import { resolveModelExtra, deepMerge } from "./config.js";
import { ANTHROPIC_SSE_RESPONSE_HEADERS, SSEBuilder } from "../sse/builder.js";
import { createDumpSession, type DumpTermination, type TerminationReason, type ServerToolLogEntry } from "../core/dump.js";
import {
  isServerToolType,
  executeWebSearch,
  executeWebFetch,
  formatWebSearchResultContent,
  formatWebFetchResultContent,
  buildServerToolFunctionSchema,
  buildServerToolSystemPromptSuffix,
} from "./server_tools.js";

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

/** Check if a tool call name is a server tool that the proxy should intercept. */
export function isServerToolCall(
  name: string,
  config: ServerToolConfig,
): boolean {
  if (name === "web_search" && config.webSearch) return true;
  if (name === "web_fetch" && config.webFetch) return true;
  return false;
}

interface CollectedToolCall {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

interface CollectResult {
  toolCalls: CollectedToolCall[];
  finishReason: string | null;
  hasServerToolCall: boolean;
  textContent: string;
}

/** Collect tool call arguments from an upstream stream.
 *  Buffers all chunks to capture complete tool call arguments. */
export async function collectToolCallArguments(
  upstreamStream: AsyncIterable<StreamChunk>,
): Promise<CollectResult> {
  const toolCalls = new Map<number, CollectedToolCall>();
  let finishReason: string | null = null;
  let textContent = "";

  for await (const chunk of upstreamStream) {
    if (!chunk.choices?.length) continue;
    const choice = chunk.choices[0];
    const delta = choice.delta;
    if (!delta) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (delta.content) textContent += delta.content;

    if (delta.tool_calls?.length) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCalls.has(idx)) {
          toolCalls.set(idx, {
            index: idx,
            id: tc.id || "",
            name: tc.function.name || "",
            arguments: "",
          });
        }
        const existing = toolCalls.get(idx)!;
        if (tc.id) existing.id = tc.id;
        if (tc.function.name) existing.name = tc.function.name;
        if (tc.function.arguments) existing.arguments += tc.function.arguments;
      }
    }
  }

  const toolCallsList = Array.from(toolCalls.values());
  const hasServerToolCall = toolCallsList.some((tc) =>
    tc.name === "web_search" || tc.name === "web_fetch"
  );

  return {
    toolCalls: toolCallsList,
    finishReason,
    hasServerToolCall,
    textContent,
  };
}

/** Execute a server tool call and return the result as an OpenAI-format tool message. */
export async function executeServerToolCall(
  toolName: string,
  argumentsJson: string,
  config: ServerToolConfig,
  onLog?: (entry: ServerToolLogEntry) => void,
): Promise<{ role: string; tool_call_id: string; content: string }> {
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(argumentsJson);
  } catch {
    input = {};
  }

  if (toolName === "web_search" && config.webSearch) {
    const query = String(input.query ?? "");
    const results = await executeWebSearch(query, config, onLog);
    const contentBlocks = formatWebSearchResultContent(results);
    return {
      role: "tool",
      tool_call_id: `srvtool_${Date.now()}`,
      content: JSON.stringify(contentBlocks),
    };
  }

  if (toolName === "web_fetch" && config.webFetch) {
    const url = String(input.url ?? "");
    const result = await executeWebFetch(url, config, onLog);
    const contentBlocks = formatWebFetchResultContent(result);
    return {
      role: "tool",
      tool_call_id: `srvtool_${Date.now()}`,
      content: JSON.stringify(contentBlocks),
    };
  }

  return {
    role: "tool",
    tool_call_id: `srvtool_${Date.now()}`,
    content: JSON.stringify({ error: `Unknown server tool: ${toolName}` }),
  };
}

/** Extract server tool entries from the request's tools array and server_tools field. */
function extractServerToolsFromRequest(requestData: RequestData): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const tools = requestData.tools;
  if (tools?.length) {
    for (const tool of tools) {
      const type = String(tool.type ?? "");
      if (isServerToolType(type)) {
        result.push(tool);
      }
    }
  }
  if (requestData.server_tools?.length) {
    for (const st of requestData.server_tools) {
      const type = String(st.type ?? "");
      if (isServerToolType(type)) {
        // Avoid duplicates
        if (!result.some((r) => r.type === st.type && r.name === st.name)) {
          result.push(st);
        }
      }
    }
  }
  return result;
}

/** Build just the upstream request body (without creating a Request object). */
function buildUpstreamRequestBodyOnly(
  requestData: RequestData,
  apiKey: string,
  config: ServerConfig,
): { requestBody: string; requestHeaders: Record<string, string> } {
  let body = buildBaseRequestBody(requestData, 4096, ReasoningReplayMode.THINK_TAGS);
  body.stream = true;

  const extra = resolveModelExtra(requestData.model, config.modelOverrides);
  if (Object.keys(extra).length) {
    body = deepMerge(body, extra);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
  };

  return { requestBody: JSON.stringify(body), requestHeaders: headers };
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

  // --- Server Tool Agentic Loop ---
  // When --enable-web-search or --enable-web-fetch is active and the request
  // contains server tool types (web_search_*/web_fetch_*), we enter an agentic
  // loop: intercept web_search/web_fetch tool_calls, execute them proxy-side,
  // inject results into the message history, and re-request upstream until the
  // model produces a final text response without server tool calls.
  const requestServerTools = extractServerToolsFromRequest(requestData);
  const serverToolsEnabled = config.serverTools.webSearch || config.serverTools.webFetch;

  if (serverToolsEnabled && requestServerTools.length > 0) {
    return await handleServerToolRequest(
      requestData, apiKey, config, dump, requestStartMs,
      requestHeaders, requestDatetime, request.signal, inputTokens,
    );
  }

  // --- Standard streaming flow (no server tools) ---

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


/** Handle a request that contains server tools by running an agentic loop.
 *
 * When --enable-web-search or --enable-web-fetch is active, this function:
 * 1. Sends the request to the upstream model
 * 2. If the upstream returns a web_search/web_fetch tool_call, executes it proxy-side
 * 3. Appends the tool result to the message history
 * 4. Re-requests the upstream model with the augmented history
 * 5. Repeats until the model produces a final text response
 * 6. Emits the complete conversation (server_tool_use + result + text) as SSE
 */
async function handleServerToolRequest(
    requestData: RequestData,
    apiKey: string,
    config: ServerConfig,
    dump: ReturnType<typeof createDumpSession>,
    requestStartMs: number,
    requestHeaders: Record<string, string>,
    requestDatetime: string,
    abortSignal: AbortSignal,
    inputTokens: number,
): Promise<Response> {
    const MAX_ITERATIONS = 5;
    const onLog = dump.logServerTool.bind(dump);

    // Build the initial upstream request body
    const { requestBody: initialBody, requestHeaders: upstreamReqHeaders } =
        buildUpstreamRequestBodyOnly(requestData, apiKey, config);

    dump.writeUpstreamRequest({
        headers: upstreamReqHeaders,
        datetime: new Date().toISOString(),
        body: initialBody,
    });

    // Parse the initial body to get the messages array (we'll append to it in the loop)
    const initialBodyParsed = JSON.parse(initialBody) as Record<string, unknown>;
    let upstreamMessages = [...(initialBodyParsed.messages as Record<string, unknown>[])];
    const upstreamTools = initialBodyParsed.tools;
    const upstreamUrl = `${config.upstreamBaseUrl.replace(/\/+$/, "")}/chat/completions`;
    const upstreamHeadersObj: Record<string, string> = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
    };

    type ServerToolEvent = {
        type: "server_tool_use";
        toolUseId: string;
        toolName: string;
        input: Record<string, unknown>;
    } | {
        type: "web_search_tool_result";
        toolUseId: string;
        content: Record<string, unknown>[];
        status?: string;
    } | {
        type: "web_fetch_tool_result";
        toolUseId: string;
        content: Record<string, unknown>[];
        status?: string;
    };

    const serverToolEvents: ServerToolEvent[] = [];
    let iteration = 0;

    // === Agentic loop ===
    while (iteration < MAX_ITERATIONS) {
        iteration++;

        const currentBody = JSON.stringify({
            model: requestData.model,
            messages: upstreamMessages,
            max_tokens: requestData.max_tokens ?? 32000,
            stream: true,
            ...(upstreamTools ? { tools: upstreamTools } : {}),
            thinking: { type: "enabled" },
        });

        // Log each iteration's upstream request
        dump.logServerTool({
            tool: "agentic_loop",
            timestamp: new Date().toISOString(),
            input: `iteration ${iteration}, messages: ${upstreamMessages.length}`,
            engine: "proxy",
            durationMs: Date.now() - requestStartMs,
        });

        let upstreamRes: Response;
        try {
            upstreamRes = await fetch(upstreamUrl, {
                method: "POST",
                headers: upstreamHeadersObj,
                body: currentBody,
                signal: abortSignal,
            });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const isAbort = abortSignal?.aborted;
            if (isAbort) {
                dump.writeDownstreamResponse({
                    headers: {}, status: 499,
                    body: JSON.stringify(upstreamError(`Client disconnected: ${msg}`, 499).json),
                    termination: { reason: "client_abort", disconnectTime: new Date().toISOString() },
                });
            } else {
                dump.writeUpstreamResponse({ headers: {}, status: 0, body: "", termination: { reason: "upstream_timeout", disconnectTime: new Date().toISOString() } });
                dump.writeDownstreamResponse({
                    headers: {}, status: 502,
                    body: JSON.stringify(upstreamError(`Upstream fetch failed (iteration ${iteration}): ${msg}`, 502).json),
                    termination: { reason: "upstream_timeout", disconnectTime: new Date().toISOString() },
                });
            }
            dump.finish();
            const err = isAbort ? upstreamError(`Client disconnected: ${msg}`, 499) : upstreamError(`Upstream fetch failed (iteration ${iteration}): ${msg}`, 502);
            return Response.json(err.json, { status: err.status });
        }

        if (!upstreamRes.ok) {
            const errBody = await upstreamRes.text().catch(() => "");
            dump.writeUpstreamResponse({
                headers: extractResponseHeaders(upstreamRes),
                status: upstreamRes.status,
                body: errBody,
                termination: { reason: "upstream_error", disconnectTime: new Date().toISOString() },
            });
            const mappedStatus = upstreamRes.status >= 500 ? 502 : upstreamRes.status;
            const err = upstreamError(`Upstream returned ${upstreamRes.status}: ${errBody.slice(0, 500)}`, mappedStatus);
            dump.writeDownstreamResponse({
                headers: {}, status: mappedStatus,
                body: JSON.stringify(err.json),
                termination: { reason: "upstream_error", disconnectTime: new Date().toISOString() },
            });
            dump.finish();
            return Response.json(err.json, { status: err.status });
        }

        const upstreamBody = upstreamRes.body;
        if (!upstreamBody) {
            dump.finish();
            return Response.json(serverError("Upstream returned empty body in agentic loop.").json, { status: 500 });
        }

        // Read the full upstream response and collect tool call info
        const reader = upstreamBody.getReader();
        const rawChunks: string[] = [];
        const chunks = iterUpstreamChunks(reader, rawChunks);
        const collectResult = await collectToolCallArguments(
            chunks as AsyncIterable<StreamChunk>,
        );

        // Check if any tool calls are server tools that we should intercept
        const serverToolCalls = collectResult.toolCalls.filter((tc) =>
            isServerToolCall(tc.name, config.serverTools)
        );

        if (serverToolCalls.length === 0 || collectResult.finishReason !== "tool_calls") {
            // No more server tool calls — this is the final text response
            break;
        }

        // Execute server tool calls and append to message history
        const assistantToolCalls = collectResult.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
        }));

        upstreamMessages.push({
            role: "assistant",
            content: collectResult.textContent || null,
            tool_calls: assistantToolCalls,
        });

        for (const tc of collectResult.toolCalls) {
            if (isServerToolCall(tc.name, config.serverTools)) {
                const toolResult = await executeServerToolCall(
                    tc.name, tc.arguments, config.serverTools, onLog,
                );

                const toolUseId = tc.id || `srvtool_${randomUUID().slice(0, 12)}`;
                let input: Record<string, unknown>;
                try { input = JSON.parse(tc.arguments); } catch { input = {}; }

                serverToolEvents.push({
                    type: "server_tool_use",
                    toolUseId,
                    toolName: tc.name,
                    input,
                });

                let contentBlocks: Record<string, unknown>[];
                try { contentBlocks = JSON.parse(toolResult.content); } catch { contentBlocks = []; }

                if (tc.name === "web_search") {
                    serverToolEvents.push({
                        type: "web_search_tool_result",
                        toolUseId,
                        content: contentBlocks,
                    });
                } else if (tc.name === "web_fetch") {
                    const hasError = contentBlocks.some(
                        (b) => b.type === "text" && typeof b.text === "string" && b.text.startsWith("Status: 4")
                    );
                    serverToolEvents.push({
                        type: "web_fetch_tool_result",
                        toolUseId,
                        content: contentBlocks,
                        status: hasError ? "error" : undefined,
                    });
                }

                upstreamMessages.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: toolResult.content,
                });
            } else {
                upstreamMessages.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: "Tool execution not supported in server tool mode.",
                });
            }
        }
    }

    // === Final upstream request to get streaming text response ===
    const finalBody = JSON.stringify({
        model: requestData.model,
        messages: upstreamMessages,
        max_tokens: requestData.max_tokens ?? 32000,
        stream: true,
        ...(upstreamTools ? { tools: upstreamTools } : {}),
        thinking: { type: "enabled" },
    });

    let finalRes: Response;
    try {
        finalRes = await fetch(upstreamUrl, {
            method: "POST",
            headers: upstreamHeadersObj,
            body: finalBody,
            signal: abortSignal,
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        dump.writeUpstreamResponse({ headers: {}, status: 0, body: "", termination: { reason: "upstream_timeout", disconnectTime: new Date().toISOString() } });
        dump.finish();
        const err = upstreamError(`Final upstream request failed: ${msg}`, 502);
        return Response.json(err.json, { status: err.status });
    }

    if (!finalRes.ok) {
        const errBody = await finalRes.text().catch(() => "");
        const finalHeaders = extractResponseHeaders(finalRes);
        dump.writeUpstreamResponse({ headers: finalHeaders, status: finalRes.status, body: errBody });
        dump.writeDownstreamResponse({
            headers: {}, status: 502,
            body: JSON.stringify(upstreamError(`Final upstream returned ${finalRes.status}`, 502).json),
        });
        dump.finish();
        const err = upstreamError(`Final upstream returned ${finalRes.status}: ${errBody.slice(0, 500)}`, 502);
        return Response.json(err.json, { status: err.status });
    }

    const finalResBody = finalRes.body;
    if (!finalResBody) {
        dump.finish();
        return Response.json(serverError("Final upstream returned empty body.").json, { status: 500 });
    }

    // Stream the response to downstream:
    // First emit server_tool_use + tool_result events, then the final text stream
    const downstreamHeaders: Record<string, string> = {
        "Content-Type": "text/event-stream",
        ...ANTHROPIC_SSE_RESPONSE_HEADERS,
    };

    const encoder = new TextEncoder();
    const messageId = `msg_${randomUUID()}`;
    const sse = new SSEBuilder(messageId, requestData.model, inputTokens);

    const readable = new ReadableStream({
        async start(controller) {
            const downstreamChunks: string[] = [];

            function emit(event: string) {
                downstreamChunks.push(event);
                controller.enqueue(encoder.encode(event));
            }

            try {
                // 1. Emit message_start
                emit(sse.message_start());

                // 2. Emit server_tool_use + tool_result events
                for (const event of serverToolEvents) {
                    if (event.type === "server_tool_use") {
                        for (const e of sse.emit_server_tool_use(event.toolUseId, event.toolName, event.input)) {
                            emit(e);
                        }
                    } else if (event.type === "web_search_tool_result") {
                        for (const e of sse.emit_web_search_tool_result(event.toolUseId, event.content, event.status)) {
                            emit(e);
                        }
                    } else if (event.type === "web_fetch_tool_result") {
                        for (const e of sse.emit_web_fetch_tool_result(event.toolUseId, event.content, event.status)) {
                            emit(e);
                        }
                    }
                }

                // 3. Stream the final upstream response (text content from the model)
                const finalReader = finalResBody!.getReader();
                const finalRawChunks: string[] = [];
                const finalStreamChunks = iterUpstreamChunks(finalReader, finalRawChunks);
                const finalSseStream = streamOpenAIChatToAnthropicSse(
                    finalStreamChunks as AsyncIterable<StreamChunk>,
                    requestData,
                    inputTokens,
                    config.enableThinking,
                    config.serverTools,
                    dump,
                    { skipMessageLifecycle: true, startingBlockIndex: sse.blocks.nextIndex },
                );

                for await (const event of finalSseStream) {
                    emit(event);
                }

                // 4. Emit message_delta and message_stop
                emit(sse.message_delta("end_turn", sse.estimate_output_tokens()));
                emit(sse.message_stop());

                // 5. Finalize dump
                const upstreamHeaders = extractResponseHeaders(finalRes);
                dump.writeUpstreamResponse({
                    headers: upstreamHeaders,
                    status: finalRes.status,
                    body: finalRawChunks.join(""),
                });
                dump.writeDownstreamResponse({
                    headers: downstreamHeaders,
                    status: 200,
                    body: downstreamChunks.join(""),
                });
                dump.setTiming({ ttfb: Date.now() - requestStartMs, totalTime: Date.now() - requestStartMs });
            } catch (e) {
                if (!abortSignal?.aborted) {
                    const msg = e instanceof Error ? e.message : String(e);
                    const errLine = `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: msg } })}\n\n`;
                    try { emit(errLine); } catch { /* stream closed */ }
                }
                dump.writeDownstreamResponse({
                    headers: downstreamHeaders,
                    status: 200,
                    body: downstreamChunks.join(""),
                    termination: { reason: "upstream_abort", disconnectTime: new Date().toISOString() },
                });
            } finally {
                dump.finish();
                try { controller.close(); } catch {}
            }
        },
        cancel() {
            dump.finish();
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
