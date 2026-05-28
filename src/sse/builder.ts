/** SSE event builder for Anthropic-format streaming responses. */

import { createHash } from "crypto";

export const ANTHROPIC_SSE_RESPONSE_HEADERS: Record<string, string> = {
  "X-Accel-Buffering": "no",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

const STOP_REASON_MAP: Record<string, string> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  content_filter: "end_turn",
};

export function mapStopReason(openaiReason: string | null | undefined): string {
  if (!openaiReason) return "end_turn";
  return STOP_REASON_MAP[openaiReason] ?? "end_turn";
}

function safeUsageInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function formatSseEvent(eventType: string, data: Record<string, unknown>): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
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

  constructor(messageId: string, model: string, inputTokens = 0) {
    this.message_id = messageId;
    this.model = model;
    this.input_tokens = inputTokens;
    this.blocks = new ContentBlockManager();
  }

  message_start(): string {
    const safeInput = safeUsageInt(this.input_tokens);
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
        usage: { input_tokens: safeInput, output_tokens: 1 },
      },
    });
  }

  message_delta(stopReason: string, outputTokens: number | null): string {
    const safeIn = safeUsageInt(this.input_tokens);
    const safeOut = typeof outputTokens === "number" && Number.isFinite(outputTokens) ? outputTokens : 0;
    return formatSseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: safeIn, output_tokens: safeOut },
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

  content_block_stop(index: number): string {
    return formatSseEvent("content_block_stop", {
      type: "content_block_stop",
      index,
    });
  }

  start_thinking_block(): string {
    this.blocks.thinkingIndex = this.blocks.allocateIndex();
    this.blocks.thinkingStarted = true;
    return this.content_block_start(this.blocks.thinkingIndex, "thinking");
  }

  emit_thinking_delta(content: string): string {
    this._accumulatedReasoningParts.push(content);
    return this.content_block_delta(this.blocks.thinkingIndex, "thinking_delta", content);
  }

  stop_thinking_block(): string {
    this.blocks.thinkingStarted = false;
    return this.content_block_stop(this.blocks.thinkingIndex);
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
    if (this.blocks.thinkingStarted) yield this.stop_thinking_block();
    if (this.blocks.textStarted) yield this.stop_text_block();
  }

  *close_all_blocks(): Generator<string> {
    yield* this.close_content_blocks();
    for (const [toolIndex, state] of this.blocks.toolStates) {
      if (state.started) yield this.stop_tool_block(toolIndex);
    }
  }

  *emit_error(errorMessage: string): Generator<string> {
    const errorIndex = this.blocks.allocateIndex();
    yield this.content_block_start(errorIndex, "text");
    yield this.content_block_delta(errorIndex, "text_delta", errorMessage);
    yield this.content_block_stop(errorIndex);
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

  emit_top_level_error(errorMessage: string): string {
    return formatSseEvent("error", {
      type: "error",
      error: { type: "api_error", message: errorMessage },
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
