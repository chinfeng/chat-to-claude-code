/** OpenAI-style chat transport: streams /chat/completions upstream, emits Anthropic SSE downstream. */

import { randomUUID } from "crypto";
import { SSEBuilder, mapStopReason } from "../sse/builder.js";
import { ThinkTagParser, ContentType, HeuristicToolParser } from "../parsers/index.js";
import type { RequestData } from "../conversion/converter.js";
import type { ServerToolConfig } from "../server/config.js";
import type { DumpSession } from "../core/dump.js";

/** Thrown when the upstream embeds an error object in the SSE stream (HTTP 200 with error payload). */
export class UpstreamStreamError extends Error {
  readonly code: number;
  constructor(message: string, code = 500) {
    super(message);
    this.name = "UpstreamStreamError";
    this.code = code;
  }
}

export interface StreamChunk {
  choices?: {
    delta: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: {
        index: number;
        id?: string | null;
        function: { name?: string | null; arguments?: string | null };
      }[];
    } | null;
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

function* iterHeuristicToolUseSse(sse: SSEBuilder, toolUse: Record<string, unknown>): Generator<string> {
  if (toolUse.name === "Task" && typeof toolUse.input === "object" && toolUse.input !== null) {
    const taskInput = toolUse.input as Record<string, unknown>;
    if (taskInput.run_in_background !== false) {
      taskInput.run_in_background = false;
    }
  }
  yield* sse.close_content_blocks();
  const blockIdx = sse.blocks.allocateIndex();
  yield sse.content_block_start(blockIdx, "tool_use", {
    id: toolUse.id,
    name: toolUse.name,
  });
  yield sse.content_block_delta(blockIdx, "input_json_delta", JSON.stringify(toolUse.input));
  yield sse.content_block_stop(blockIdx);
}

function isThinkingEnabled(request: RequestData, hint?: boolean | null): boolean {
  if (hint !== undefined && hint !== null) return hint;
  // Default: enabled if model name suggests it
  return true;
}

export async function* streamOpenAIChatToAnthropicSse(
  upstreamStream: AsyncIterable<StreamChunk>,
  request: RequestData,
  inputTokens: number,
  thinkingEnabledHint?: boolean | null,
  _serverToolConfig?: ServerToolConfig,
  dump?: DumpSession,
): AsyncGenerator<string> {
  const messageId = `msg_${randomUUID()}`;
  const sse = new SSEBuilder(messageId, request.model, inputTokens);
  const thinkingEnabled = isThinkingEnabled(request, thinkingEnabledHint);

  const thinkParser = new ThinkTagParser();
  const heuristicParser = new HeuristicToolParser();
  let finishReason: string | null = null;
  let usageInfo: { prompt_tokens?: number; completion_tokens?: number } | null = null;

  yield sse.message_start();

  try {
    for await (const chunk of upstreamStream) {
      if (chunk.usage) usageInfo = chunk.usage;

      // Detect upstream error objects in SSE stream (e.g. {"error":{"message":"...","type":"upstream_error","code":500}})
      // Some providers return HTTP 200 but embed errors as SSE data chunks.
      const chunkAny = chunk as Record<string, unknown>;
      if (chunkAny.error && typeof chunkAny.error === "object" && chunkAny.error !== null) {
        const err = chunkAny.error as Record<string, unknown>;
        const message = typeof err.message === "string" ? err.message : JSON.stringify(err);
        const code = typeof err.code === "number" ? err.code : 500;
        throw new UpstreamStreamError(message, code);
      }

      if (!chunk.choices?.length) continue;

      const choice = chunk.choices[0];
      const delta = choice.delta;
      if (!delta) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      // Handle reasoning_content (OpenAI extended format)
      const reasoning = delta.reasoning_content;
      if (thinkingEnabled && reasoning) {
        for (const event of sse.ensure_thinking_block()) yield event;
        yield sse.emit_thinking_delta(reasoning);
      }

      // Handle text content
      if (delta.content) {
        for (const part of thinkParser.feed(delta.content)) {
          if (part.type === ContentType.THINKING) {
            if (!thinkingEnabled) continue;
            for (const event of sse.ensure_thinking_block()) yield event;
            yield sse.emit_thinking_delta(part.content);
          } else {
            const [filteredText, detectedTools] = heuristicParser.feed(part.content);
            if (filteredText) {
              for (const event of sse.ensure_text_block()) yield event;
              yield sse.emit_text_delta(filteredText);
            }
            for (const toolUse of detectedTools) {
              for (const event of iterHeuristicToolUseSse(sse, toolUse)) yield event;
            }
          }
        }
      }

      // Handle native tool calls
      if (delta.tool_calls?.length) {
        // Flush any text buffered in the heuristic parser before starting tool blocks.
        // The HeuristicToolParser buffers text looking for ● patterns, but when native
        // tool_calls arrive, that buffered text must be emitted first so text content
        // blocks appear before tool_use blocks in the Anthropic SSE output.
        const heuristicFlush = heuristicParser.flush();
        if (heuristicFlush.text) {
          for (const event of sse.ensure_text_block()) yield event;
          yield sse.emit_text_delta(heuristicFlush.text);
        }
        for (const toolUse of heuristicFlush.tools) {
          for (const event of iterHeuristicToolUseSse(sse, toolUse)) yield event;
        }
        for (const event of sse.close_content_blocks()) yield event;
        for (const tc of delta.tool_calls) {
          const tcInfo = {
            index: tc.index,
            id: tc.id,
            function: { name: tc.function.name, arguments: tc.function.arguments },
          };
          for (const event of processToolCall(tcInfo, sse)) yield event;
        }
      }
    }
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    for (const event of sse.close_all_blocks()) yield event;
    if (sse.blocks.hasEmittedToolBlock()) {
      yield sse.emit_top_level_error(errorMessage);
    } else {
      for (const event of sse.emit_error(errorMessage)) yield event;
    }
    yield sse.message_delta("end_turn", 1);
    yield sse.message_stop();
    return;
  }

  // Flush remaining content
  const remaining = thinkParser.flush();
  if (remaining) {
    if (remaining.type === ContentType.THINKING) {
      if (thinkingEnabled) {
        for (const event of sse.ensure_thinking_block()) yield event;
        yield sse.emit_thinking_delta(remaining.content);
      }
    } else {
      for (const event of sse.ensure_text_block()) yield event;
      yield sse.emit_text_delta(remaining.content);
    }
  }

  const heuristicFlush = heuristicParser.flush();
  if (heuristicFlush.text) {
    for (const event of sse.ensure_text_block()) yield event;
    yield sse.emit_text_delta(heuristicFlush.text);
  }
  for (const toolUse of heuristicFlush.tools) {
    for (const event of iterHeuristicToolUseSse(sse, toolUse)) yield event;
  }

  // Ensure at least one content block exists
  const hasStartedTool = [...sse.blocks.toolStates.values()].some((s) => s.started);
  const hasContentBlocks =
    sse.blocks.textIndex !== -1 || sse.blocks.thinkingIndex !== -1 || hasStartedTool;

  if (!hasContentBlocks) {
    for (const event of sse.ensure_text_block()) yield event;
    yield sse.emit_text_delta(" ");
  } else if (
    !hasStartedTool &&
    !sse.accumulated_text.trim() &&
    sse.accumulated_reasoning.trim()
  ) {
    for (const event of sse.ensure_text_block()) yield event;
    yield sse.emit_text_delta(" ");
  }

  // Flush task arg buffers
  for (const [toolIndex, out] of sse.blocks.flushTaskArgBuffers()) {
    yield sse.emit_tool_delta(toolIndex, out);
  }

  for (const event of sse.close_all_blocks()) yield event;

  const completion =
    usageInfo && typeof usageInfo.completion_tokens === "number"
      ? usageInfo.completion_tokens
      : sse.estimate_output_tokens();

  yield sse.message_delta(mapStopReason(finishReason), completion);
  yield sse.message_stop();
}

function* processToolCall(
  tc: { index: number; id?: string | null; function: { name?: string | null; arguments?: string | null } },
  sse: SSEBuilder,
): Generator<string> {
  const tcIndex = tc.index ?? 0;
  const fnDelta = tc.function;
  const incomingName = fnDelta.name;
  const arguments_ = fnDelta.arguments || "";

  if (tc.id != null) sse.blocks.setStreamToolId(tcIndex, tc.id);
  if (incomingName != null) sse.blocks.registerToolName(tcIndex, incomingName);

  const state = sse.blocks.toolStates.get(tcIndex);
  const resolvedId = (state?.toolId || tc.id) || `tool_${randomUUID()}`;
  const resolvedName = (state?.name || "").trim();

  if (!state || !state.started) {
    if (resolvedName) {
      yield sse.start_tool_block(tcIndex, String(resolvedId), resolvedName);
      const currentState = sse.blocks.toolStates.get(tcIndex)!;
      if (currentState.preStartArgs) {
        const pre = currentState.preStartArgs;
        currentState.preStartArgs = "";
        yield sse.emit_tool_delta(tcIndex, pre);
      }
    }
  }

  if (!arguments_) return;

  const currentState = sse.blocks.toolStates.get(tcIndex);
  if (!currentState?.started) {
    const ensuredState = sse.blocks.ensureToolState(tcIndex);
    if (!resolvedName) {
      ensuredState.preStartArgs += arguments_;
      return;
    }
  }

  yield sse.emit_tool_delta(tcIndex, arguments_);
}
