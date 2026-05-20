/** HTTP route handlers for Anthropic-compatible API. */

import { buildBaseRequestBody, ReasoningReplayMode } from "../conversion/converter.js";
import type { RequestData } from "../conversion/converter.js";
import { streamOpenAIChatToAnthropicSse } from "../transport/stream.js";
import { estimateInputTokens } from "../core/tokens.js";
import { invalidRequestError, authenticationError, upstreamError, serverError } from "../core/errors.js";
import type { ServerConfig } from "./config.js";
import { ANTHROPIC_SSE_RESPONSE_HEADERS } from "../sse/builder.js";
import { createDumpSession } from "../core/dump.js";

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
    },
  };
}

/** Build the upstream OpenAI-compatible fetch request. */
function buildUpstreamRequest(requestData: RequestData, apiKey: string, config: ServerConfig): Request {
  const body = buildBaseRequestBody(requestData, 4096, ReasoningReplayMode.THINK_TAGS);
  const url = `${config.upstreamBaseUrl.replace(/\/+$/, "")}/chat/completions`;
  (body as Record<string, unknown>).stream = true;

  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
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

/** Convert an upstream ReadableStream into AsyncIterable of parsed chunks. */
async function* iterUpstreamChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
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
}

/** Handle POST /v1/messages. */
export async function handleMessages(request: Request, config: ServerConfig): Promise<Response> {
  const dump = createDumpSession(config.dumpDir);

  // Validate downstream auth token when configured
  if (!validateAuthToken(request, config)) {
    const err = authenticationError("Invalid auth token. Provide correct x-api-key header.");
    dump.writeResponse(JSON.stringify(err.json));
    dump.finish();
    return Response.json(err.json, { status: err.status });
  }

  const apiKey = resolveApiKey(request, config);
  if (!apiKey) {
    const err = authenticationError("No API key provided. Set --upstream-api-key or enable passthrough mode (no upstream key and no auth token).");
    dump.writeResponse(JSON.stringify(err.json));
    dump.finish();
    return Response.json(err.json, { status: err.status });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    const err = invalidRequestError("Invalid JSON in request body.");
    dump.writeResponse(JSON.stringify(err.json));
    dump.finish();
    return Response.json(err.json, { status: err.status });
  }

  dump.writeRequest(JSON.stringify(body, null, 2));

  const parsed = parseMessagesBody(body);
  if ("error" in parsed && parsed.error) {
    dump.writeResponse(JSON.stringify(parsed.error.json));
    dump.finish();
    return Response.json(parsed.error.json, { status: parsed.error.status });
  }

  const requestData = parsed.data;
  const inputTokens = estimateInputTokens(requestData.messages);

  const upstreamReq = buildUpstreamRequest(requestData, apiKey, config);
  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstreamReq);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const err = upstreamError(`Failed to connect to upstream: ${msg}`, 502);
    dump.writeResponse(JSON.stringify(err.json));
    dump.finish();
    return Response.json(err.json, { status: err.status });
  }

  if (!upstreamRes.ok) {
    const errBody = await upstreamRes.text().catch(() => "");
    const err = upstreamError(
      `Upstream returned ${upstreamRes.status}: ${errBody.slice(0, 500)}`,
      upstreamRes.status >= 500 ? 502 : upstreamRes.status,
    );
    dump.writeResponse(JSON.stringify(err.json));
    dump.finish();
    return Response.json(err.json, { status: err.status });
  }

  const upstreamBody = upstreamRes.body;
  if (!upstreamBody) {
    const err = serverError("Upstream returned empty body.");
    dump.writeResponse(JSON.stringify(err.json));
    dump.finish();
    return Response.json(err.json, { status: err.status });
  }

  const reader = upstreamBody.getReader();
  const chunks = iterUpstreamChunks(reader);
  const sseEvents = streamOpenAIChatToAnthropicSse(
    chunks as AsyncIterable<import("../transport/stream.js").StreamChunk>,
    requestData,
    inputTokens,
    config.enableThinking,
  );

  const responseChunks: string[] = [];

  const readable = new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await sseEvents.next();
        if (done) {
          dump.writeResponse(responseChunks.join(""));
          dump.finish();
          controller.close();
          return;
        }
        responseChunks.push(value as string);
        controller.enqueue(new TextEncoder().encode(value));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const errLine = `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: msg } })}\n\n`;
        dump.writeResponse(responseChunks.join("") + errLine);
        dump.finish();
        controller.enqueue(new TextEncoder().encode(errLine));
        controller.close();
      }
    },
    async cancel() {
      dump.writeResponse(responseChunks.join(""));
      dump.finish();
      reader.cancel().catch(() => {});
    },
  });

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      ...ANTHROPIC_SSE_RESPONSE_HEADERS,
    },
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
