/** SSE event builder for Anthropic-format streaming responses. */

import { createHash } from "crypto";

export const ANTHROPIC_SSE_RESPONSE_HEADERS: Record<string, string> = {
  "X-Accel-Buffering": "no",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

/** Default interval between `event: ping` heartbeat events (ms). */
export const DEFAULT_PING_INTERVAL_MS = 15_000;

const STOP_REASON_MAP: Record<string, string> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  content_filter: "refusal",
};

export function mapStopReason(openaiReason: string | null | undefined): string {
  if (!openaiReason) return "end_turn";
  return STOP_REASON_MAP[openaiReason] ?? "end_turn";
}

/** Mapping from upstream OpenAI error fields (or HTTP status ranges)
 *  to Anthropic SSE `error.error.type` values. */
export function mapErrorType(
  openaiCode: number | string | null | undefined,
): string {
  const code = typeof openaiCode === "number" ? openaiCode : Number(openaiCode);
  if (code === 429 || code === 529) return "overloaded_error";
  if (code >= 400 && code < 500) return "invalid_request_error";
  return "api_error";
}

/** Build the downstream top-level `event: error` SSE line for a mid-stream
 *  failure.
 *
 *  This is the shape cc-switch's OpenAI-Chat→Anthropic converter emits when the
 *  upstream body stream errors mid-iteration (`Err(e)` in
 *  `prime_streaming_response`/`create_anthropic_sse_stream`): a top-level
 *  `event: error` whose error object is `{ type: "stream_error", message }` —
 *  a custom (non-Anthropic-standard) type carrying our descriptive upstream
 *  failure text. Crucially we do NOT emit `message_delta`/`message_stop`
 *  alongside it, so the turn is never disguised as completed and never poisons
 *  conversation history; the SDK throws on the error event and discards the
 *  partial.
 *
 *  By design this does NOT trigger a claude-code client retry. claude-code's
 *  mid-stream retry predicate `sym` only fires on HTTP status 429/5xx (impossible
 *  here — HTTP 200 is already committed) or the literal substring
 *  `'"type":"overloaded_error"'` inside `e.message` (the SDK builds `e.message`
 *  from `error.message`, not `error.type`). cc-switch deliberately declines to
 *  use that escape hatch on a partially-streamed turn: it hides aborts by
 *  transparently failing over to another provider BEFORE committing the 200
 *  (a `prime_streaming_response` first-byte gate), and only relies on the
 *  HTTP-status retry trigger when a request fails BEFORE any SSE is sent (the
 *  pre-commit path this proxy already exposes via `upstreamError(..., mappedStatus)`).
 *  Post-commit, cc-switch surfaces `stream_error` and lets the client not retry —
 *  the trade-off this proxy now matches.
 */
export function buildMidStreamErrorSse(message: string): string {
  return formatSseEvent("error", {
    type: "error",
    error: { type: "stream_error", message },
  });
}

function safeUsageInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function formatSseEvent(eventType: string, data: Record<string, unknown>): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

export interface UsageInfo {
  prompt_tokens?: number;
  completion_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export class ToolCallState {
  blockIndex = -1;
  toolId = "";
  name = "";
  contents: string[] = [];
  started = false;
  taskArgBuffer = "";
  taskArgsEmitted = false;
  preStartArgs = "";
}

export class ContentBlockManager {
  nextIndex = 0;
  thinkingIndex = -1;
  textIndex = -1;
  thinkingStarted = false;
  textStarted = false;
  toolStates: Map<number, ToolCallState> = new Map();

  allocateIndex(): number {
    return this.nextIndex++;
  }

  ensureToolState(index: number): ToolCallState {
    if (!this.toolStates.has(index)) {
      this.toolStates.set(index, new ToolCallState());
    }
    return this.toolStates.get(index)!;
  }

  setStreamToolId(index: number, toolId: string | null | undefined): void {
    if (!toolId) return;
    const state = this.ensureToolState(index);
    state.toolId = String(toolId);
  }

  registerToolName(index: number, name: string): void {
    if (!this.toolStates.has(index)) {
      const state = new ToolCallState();
      state.name = name;
      this.toolStates.set(index, state);
      return;
    }
    const state = this.toolStates.get(index)!;
    const prev = state.name;
    if (!prev || name.startsWith(prev)) {
      state.name = name;
    } else if (!prev.startsWith(name)) {
      state.name = prev + name;
    }
  }

  bufferTaskArgs(index: number, args: string): Record<string, unknown> | null {
    const state = this.toolStates.get(index);
    if (!state || state.taskArgsEmitted) return null;
    state.taskArgBuffer += args;
    try {
      const argsJson = JSON.parse(state.taskArgBuffer) as Record<string, unknown>;
      normalizeTaskRunInBackground(argsJson);
      state.taskArgsEmitted = true;
      state.taskArgBuffer = "";
      return argsJson;
    } catch {
      return null;
    }
  }

  hasEmittedToolBlock(): boolean {
    for (const state of this.toolStates.values()) {
      if (state.started) return true;
    }
    return false;
  }

  flushTaskArgBuffers(): [number, string][] {
    const results: [number, string][] = [];
    for (const [toolIndex, state] of this.toolStates) {
      if (!state.taskArgBuffer || state.taskArgsEmitted) continue;
      let out = "{}";
      try {
        const argsJson = JSON.parse(state.taskArgBuffer) as Record<string, unknown>;
        normalizeTaskRunInBackground(argsJson);
        out = JSON.stringify(argsJson);
      } catch {
        const digest = createHash("sha256")
          .update(state.taskArgBuffer)
          .digest("hex")
          .slice(0, 16);
        console.warn(
          `Task args invalid JSON (id=${state.toolId || "unknown"} len=${state.taskArgBuffer.length} buffer_sha256_prefix=${digest})`,
        );
      }
      state.taskArgsEmitted = true;
      state.taskArgBuffer = "";
      results.push([toolIndex, out]);
    }
    return results;
  }
}

function normalizeTaskRunInBackground(argsJson: Record<string, unknown>): void {
  if (argsJson.run_in_background !== false) {
    argsJson.run_in_background = false;
  }
}

export class SSEBuilder {
  message_id: string;
  model: string;
  input_tokens: number;
  blocks: ContentBlockManager;
  private _accumulatedTextParts: string[] = [];
  private _accumulatedReasoningParts: string[] = [];
  private _usageInfo: UsageInfo | null = null;
  /** Per-request secret for signing thinking content — derived from message_id
   *  so signatures are deterministic for the same thinking text within a turn,
   *  but opaque to the client. */
  private _thinkingSigningSecret: string;
  /** Accumulated raw thinking text for generating the signature at block close. */
  private _thinkingAccum: string = "";

  constructor(messageId: string, model: string, inputTokens = 0, usage?: UsageInfo | null) {
    this.message_id = messageId;
    this.model = model;
    this.input_tokens = inputTokens;
    this.blocks = new ContentBlockManager();
    this._usageInfo = usage ?? null;
    this._thinkingSigningSecret = createHash("sha256")
      .update(`ts-proxy-think-sign:${messageId}`)
      .digest("hex");
  }

  /** Compute the thinking signature from accumulated thinking text + per-request
   *  secret. The output is a hex string that round-trips across turns: the same
   *  thinking text on the same message_id produces the same signature, so when
   *  the client replays the block with its signature in a subsequent request,
   *  the proxy can detect tampering and issue a new signature for the next turn. */
  private computeThinkingSignature(): string {
    return createHash("sha256")
      .update(this._thinkingSigningSecret)
      .update(this._thinkingAccum)
      .digest("hex");
  }

  /** Feed accumulated reasoning text for signature computation. */
  addThinkingText(text: string): void {
    this._thinkingAccum += text;
    this._accumulatedReasoningParts.push(text);
  }

  /** Anthropic `input_tokens` = upstream `prompt_tokens` minus the cache buckets
   *  that have already been accounted separately (cache_read + cache_write),
   *  saturated at 0 — the three-bucket invariant cc-switch computes in
   *  `build_anthropic_usage_json`. When no upstream usage chunk has arrived yet
   *  (message_start is emitted up front, before any usage), fall back to the
   *  constructor `input_tokens` estimate. */
  private computeInputTokens(): number {
    const u = this._usageInfo;
    if (u && typeof u.prompt_tokens === "number") {
      const cached = u.cache_read_input_tokens ?? 0;
      const cacheCre = u.cache_creation_input_tokens ?? 0;
      return Math.max(0, u.prompt_tokens - cached - cacheCre);
    }
    return safeUsageInt(this.input_tokens);
  }

  message_start(): string {
    const safeInput = safeUsageInt(this.input_tokens);
    const usage: Record<string, number> = {
      input_tokens: this._usageInfo && typeof this._usageInfo.prompt_tokens === "number"
        ? this.computeInputTokens()
        : safeInput,
      output_tokens: 1,
    };
    if (this._usageInfo?.cache_read_input_tokens && this._usageInfo.cache_read_input_tokens > 0) {
      usage.cache_read_input_tokens = this._usageInfo.cache_read_input_tokens;
    }
    if (this._usageInfo?.cache_creation_input_tokens && this._usageInfo.cache_creation_input_tokens > 0) {
      usage.cache_creation_input_tokens = this._usageInfo.cache_creation_input_tokens;
    }
    return formatSseEvent("message_start", {
      type: "message_start",
      message: {
        id: this.message_id,
        type: "message",
        role: "assistant",
        content: [],
        model: this.model,
        stop_reason: null,
        stop_sequence: null,
        usage,
      },
    });
  }

  message_delta(stopReason: string, outputTokens: number | null): string {
    // message_delta is emitted at stream end, after a usage chunk has arrived
    // (when stream_options.include_usage was requested): report the REAL input
    // token count (prompt_tokens minus cache buckets) instead of the
    // constructor estimate. Falls back to the estimate when no usage arrived.
    const safeIn = this.computeInputTokens();
    const safeOut = typeof outputTokens === "number" && Number.isFinite(outputTokens) ? outputTokens : 0;
    const usage: Record<string, number> = {
      input_tokens: safeIn,
      output_tokens: safeOut,
    };
    if (this._usageInfo?.cache_read_input_tokens && this._usageInfo.cache_read_input_tokens > 0) {
      usage.cache_read_input_tokens = this._usageInfo.cache_read_input_tokens;
    }
    if (this._usageInfo?.cache_creation_input_tokens && this._usageInfo.cache_creation_input_tokens > 0) {
      usage.cache_creation_input_tokens = this._usageInfo.cache_creation_input_tokens;
    }
    return formatSseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage,
    });
  }

  message_stop(): string {
    return formatSseEvent("message_stop", { type: "message_stop" });
  }

  content_block_start(
    index: number,
    blockType: string,
    kwargs: Record<string, unknown> = {},
  ): string {
    const contentBlock: Record<string, unknown> = { type: blockType };
    if (blockType === "thinking") {
      contentBlock.thinking = kwargs.thinking ?? "";
    } else if (blockType === "text") {
      contentBlock.text = kwargs.text ?? "";
    } else if (blockType === "tool_use") {
      contentBlock.id = kwargs.id ?? "";
      contentBlock.name = kwargs.name ?? "";
      contentBlock.input = kwargs.input ?? {};
    } else if (blockType === "server_tool_use") {
      contentBlock.id = kwargs.id ?? "";
      contentBlock.name = kwargs.name ?? "";
      contentBlock.input = kwargs.input ?? {};
    } else if (blockType === "web_search_tool_result") {
      contentBlock.tool_use_id = kwargs.tool_use_id ?? "";
      if (kwargs.content) contentBlock.content = kwargs.content;
      if (kwargs.status === "error") contentBlock.status = "error";
    } else if (blockType === "web_fetch_tool_result") {
      contentBlock.tool_use_id = kwargs.tool_use_id ?? "";
      if (kwargs.content) contentBlock.content = kwargs.content;
      if (kwargs.status === "error") contentBlock.status = "error";
    }
    return formatSseEvent("content_block_start", {
      type: "content_block_start",
      index,
      content_block: contentBlock,
    });
  }

  content_block_delta(index: number, deltaType: string, content: string): string {
    const delta: Record<string, unknown> = { type: deltaType };
    if (deltaType === "thinking_delta") {
      delta.thinking = content;
    } else if (deltaType === "signature_delta") {
      delta.signature = content;
    } else if (deltaType === "text_delta") {
      delta.text = content;
    } else if (deltaType === "input_json_delta") {
      delta.partial_json = content;
    }
    return formatSseEvent("content_block_delta", {
      type: "content_block_delta",
      index,
      delta,
    });
  }

  /** Emit an SSE ping heartbeat event (Anthropic keep-alive). */
  ping(): string {
    return "event: ping\ndata: {}\n\n";
  }

  content_block_stop(index: number): string {
    return formatSseEvent("content_block_stop", {
      type: "content_block_stop",
      index,
    });
  }

  start_thinking_block(): string {
    this.blocks.thinkingIndex = this.blocks.allocateIndex();
    this.blocks.thinkingStarted = true;
    this._thinkingAccum = "";
    return this.content_block_start(this.blocks.thinkingIndex, "thinking", { thinking: "" });
  }

  emit_thinking_delta(content: string): string {
    this._thinkingAccum += content;
    this._accumulatedReasoningParts.push(content);
    return this.content_block_delta(this.blocks.thinkingIndex, "thinking_delta", content);
  }

  /** Emit a `signature_delta` carrying the HMAC-SHA256 of the accumulated
   *  thinking text. Called immediately before `stop_thinking_block()` to produce
   *  the `content_block_delta(signature_delta)` + `content_block_stop` sequence
   *  that Claude Code expects for multi-turn thinking verification. */
  emit_signature_delta(): string {
    const sig = this.computeThinkingSignature();
    return this.content_block_delta(this.blocks.thinkingIndex, "signature_delta", sig);
  }

  stop_thinking_block(): string {
    this.blocks.thinkingStarted = false;
    return this.content_block_stop(this.blocks.thinkingIndex);
  }

  /** Close a thinking block with its signature delta, as one atomic sequence.
   *  Yields: signature_delta + content_block_stop */
  *close_thinking_with_signature(): Generator<string> {
    yield this.emit_signature_delta();
    yield this.stop_thinking_block();
  }

  start_text_block(): string {
    this.blocks.textIndex = this.blocks.allocateIndex();
    this.blocks.textStarted = true;
    return this.content_block_start(this.blocks.textIndex, "text");
  }

  emit_text_delta(content: string): string {
    this._accumulatedTextParts.push(content);
    return this.content_block_delta(this.blocks.textIndex, "text_delta", content);
  }

  stop_text_block(): string {
    this.blocks.textStarted = false;
    return this.content_block_stop(this.blocks.textIndex);
  }

  start_tool_block(toolIndex: number, toolId: string, name: string): string {
    const blockIdx = this.blocks.allocateIndex();
    if (this.blocks.toolStates.has(toolIndex)) {
      const state = this.blocks.toolStates.get(toolIndex)!;
      state.blockIndex = blockIdx;
      state.toolId = toolId;
      state.started = true;
    } else {
      const state = new ToolCallState();
      state.blockIndex = blockIdx;
      state.toolId = toolId;
      state.name = name;
      state.started = true;
      this.blocks.toolStates.set(toolIndex, state);
    }
    return this.content_block_start(blockIdx, "tool_use", { id: toolId, name });
  }

  emit_tool_delta(toolIndex: number, partialJson: string): string {
    const state = this.blocks.toolStates.get(toolIndex)!;
    state.contents.push(partialJson);
    return this.content_block_delta(state.blockIndex, "input_json_delta", partialJson);
  }

  stop_tool_block(toolIndex: number): string {
    const blockIdx = this.blocks.toolStates.get(toolIndex)!.blockIndex;
    return this.content_block_stop(blockIdx);
  }

  *ensure_thinking_block(): Generator<string> {
    if (this.blocks.textStarted) yield this.stop_text_block();
    if (!this.blocks.thinkingStarted) yield this.start_thinking_block();
  }

  *ensure_text_block(): Generator<string> {
    if (this.blocks.thinkingStarted) yield this.stop_thinking_block();
    if (!this.blocks.textStarted) yield this.start_text_block();
  }

  *close_content_blocks(): Generator<string> {
    if (this.blocks.thinkingStarted) {
      yield this.emit_signature_delta();
      yield this.stop_thinking_block();
    }
    if (this.blocks.textStarted) yield this.stop_text_block();
  }

  *close_all_blocks(): Generator<string> {
    yield* this.close_content_blocks();
    for (const [toolIndex, state] of this.blocks.toolStates) {
      if (state.started) yield this.stop_tool_block(toolIndex);
    }
  }

  /** Emit a complete server_tool_use content block (non-streaming — all data at once). */
  *emit_server_tool_use(
    toolId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Generator<string> {
    const index = this.blocks.allocateIndex();
    yield this.content_block_start(index, "server_tool_use", {
      id: toolId,
      name: toolName,
      input,
    });
    yield this.content_block_stop(index);
  }

  /** Emit a complete web_search_tool_result content block (non-streaming). */
  *emit_web_search_tool_result(
    toolUseId: string,
    content: Record<string, unknown>[],
    status?: string,
  ): Generator<string> {
    const index = this.blocks.allocateIndex();
    yield this.content_block_start(index, "web_search_tool_result", {
      tool_use_id: toolUseId,
      content,
      ...(status ? { status } : {}),
    });
    yield this.content_block_stop(index);
  }

  /** Emit a complete web_fetch_tool_result content block (non-streaming). */
  *emit_web_fetch_tool_result(
    toolUseId: string,
    content: Record<string, unknown>[],
    status?: string,
  ): Generator<string> {
    const index = this.blocks.allocateIndex();
    yield this.content_block_start(index, "web_fetch_tool_result", {
      tool_use_id: toolUseId,
      content,
      ...(status ? { status } : {}),
    });
    yield this.content_block_stop(index);
  }

  emit_top_level_error(errorMessage: string, errorType?: string): string {
    return formatSseEvent("error", {
      type: "error",
      error: {
        type: errorType || "api_error",
        message: errorMessage,
      },
    });
  }

  get accumulated_text(): string {
    return this._accumulatedTextParts.join("");
  }

  get accumulated_reasoning(): string {
    return this._accumulatedReasoningParts.join("");
  }

  estimate_output_tokens(): number {
    const accText = this.accumulated_text;
    const accReasoning = this.accumulated_reasoning;

    // Simple char-based estimation (no tiktoken in Bun)
    const textTokens = Math.ceil(accText.length / 4);
    const reasoningTokens = Math.ceil(accReasoning.length / 4);
    let toolTokens = 0;
    let startedToolCount = 0;
    for (const state of this.blocks.toolStates.values()) {
      toolTokens += Math.ceil(state.name.length / 4);
      toolTokens += Math.ceil(state.contents.join("").length / 4);
      toolTokens += 15;
      if (state.started) startedToolCount++;
    }
    const blockCount =
      (accReasoning ? 1 : 0) + (accText ? 1 : 0) + startedToolCount;
    return textTokens + reasoningTokens + toolTokens + blockCount * 4;
  }
}
