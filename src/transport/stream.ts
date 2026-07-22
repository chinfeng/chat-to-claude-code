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

/**
 * Thrown when the upstream CONNECTION terminates mid-stream — either a read
 * error/reset (the upstream socket was closed unexpectedly) or a clean EOF
 * with no `finish_reason` (the upstream closed without completing the
 * generation). Propagated to the route layer, which closes the downstream SSE
 * WITHOUT fabricating a terminal marker: no `event: error`, no
 * message_delta/message_stop (no self-defined finish_reason), no [DONE] — so
 * the abort propagates to the downstream client as an abrupt stream end.
 *
 * Contrast with UpstreamStreamError (upstream sent an explicit error object
 * while still connected), which still surfaces downstream as `event: error`.
 */
export class UpstreamAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamAbortedError";
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

export interface StreamOptions {
  /** Skip emitting message_start/message_delta/message_stop events.
   * Used when the agentic loop already emitted message_start and will
   * handle the message lifecycle events. */
  skipMessageLifecycle?: boolean;
  /** Starting block index for content blocks. Used when server_tool_use
   * blocks have already been emitted before this stream starts. */
  startingBlockIndex?: number;
}

export async function* streamOpenAIChatToAnthropicSse(
  upstreamStream: AsyncIterable<StreamChunk>,
  request: RequestData,
  inputTokens: number,
  thinkingEnabledHint?: boolean | null,
  _serverToolConfig?: ServerToolConfig,
  dump?: DumpSession,
  options?: StreamOptions,
): AsyncGenerator<string> {
  const messageId = `msg_${randomUUID()}`;
  const sse = new SSEBuilder(messageId, request.model, inputTokens);
  const thinkingEnabled = isThinkingEnabled(request, thinkingEnabledHint);

  // If startingBlockIndex is provided, advance the block counter
  // so that content_block indices continue after pre-emitted blocks
  if (options?.startingBlockIndex) {
    sse.blocks.nextIndex = options.startingBlockIndex;
  }

  const thinkParser = new ThinkTagParser();
  const heuristicParser = new HeuristicToolParser();
  let finishReason: string | null = null;
  let usageInfo: { prompt_tokens?: number; completion_tokens?: number } | null = null;

  if (!options?.skipMessageLifecycle) {
    yield sse.message_start();
  }

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

    // If the upstream stream ended WITHOUT a real `finish_reason`, the upstream
    // terminated the connection without completing the generation (a clean TCP
    // close after the last chunk, but no final finish_reason chunk). Propagate
    // that as an abort — do NOT flush partial buffered state and do NOT
    // fabricate message_delta/message_stop (no self-defined finish_reason).
    // The route layer closes the downstream SSE so the client sees the same
    // abrupt end the upstream produced.
    if (finishReason == null) {
      throw new UpstreamAbortedError(
        "Upstream stream ended without a finish_reason (connection terminated mid-generation).",
      );
    }
  } catch (e) {
    // On an upstream connection abort (reset, or clean EOF without a finish
    // reason), propagate the termination verbatim: stop emitting immediately
    // and rethrow. We do NOT close content blocks or emit message_delta/stop
    // — the route layer just closes the downstream SSE so the client sees the
    // same abrupt end, with no self-defined finish_reason, no error event,
    // no [DONE] (see UpstreamAbortedError).
    //
    // For a non-abort failure (e.g. the upstream embedded an error object in
    // the data), close any open content blocks first so the prefix is
    // well-formed, then rethrow — the route layer surfaces it as an explicit
    // `event: error`. We deliberately do NOT fake message_delta(end_turn) +
    // message_stop for these either: disguising a failure as a completed
    // assistant turn poisons conversation history. See dump/ for occurrences.
    if (!(e instanceof UpstreamAbortedError)) {
      for (const event of sse.close_all_blocks()) yield event;
    }
    throw e;
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

  // Resolve orphaned tool states — tool_calls that arrived without a name/id.
  // This happens with some upstream providers (e.g. GLM-5.1 via newapi) that
  // emit tool_calls chunks with only index and arguments, missing function.name
  // and id. We try to infer the name from request.tools (by index), or discard
  // the orphaned state and downgrade stop_reason from "tool_use" to "end_turn".
  let hasOrphanedToolStates = false;
  for (const [toolIndex, state] of sse.blocks.toolStates) {
    if (state.started) continue; // already started — not orphaned
    if (!state.preStartArgs && !state.name) continue; // no data — ignore

    // Try to infer tool name from request.tools by index
    const inferredName = inferToolNameByIndex(request, toolIndex);
    if (inferredName) {
      // We can infer the name — start the tool block now
      const resolvedId = state.toolId || `tool_${randomUUID()}`;
      for (const event of sse.close_content_blocks()) yield event;
      yield sse.start_tool_block(toolIndex, resolvedId, inferredName);
      if (state.preStartArgs) {
        yield sse.emit_tool_delta(toolIndex, state.preStartArgs);
        state.preStartArgs = "";
      }
    } else {
      // Cannot infer — mark as orphaned so we downgrade stop_reason later
      hasOrphanedToolStates = true;
      // Clear the orphaned state so it doesn't interfere with hasStartedTool
      state.preStartArgs = "";
      sse.blocks.toolStates.delete(toolIndex);
    }
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

  // If we had orphaned tool states (tool_calls without names that couldn't be
  // resolved), downgrade stop_reason from "tool_use" to "end_turn" so that
  // Claude Code doesn't fail trying to parse a non-existent tool_use block.
  const effectiveFinishReason = hasOrphanedToolStates ? "stop" : finishReason;

  if (!options?.skipMessageLifecycle) {
    yield sse.message_delta(mapStopReason(effectiveFinishReason), completion);
    yield sse.message_stop();
  }
}

/** Try to infer a tool name from the request's tools list by tool call index.
 * Returns the tool name if found, or null if inference is not possible.
 *
 * When upstream providers (e.g. GLM-5.1 via newapi) return tool_calls without
 * a function.name, we attempt to resolve it by matching the tool_call index
 * to the position in the tools array that was sent to the upstream API. */
export function inferToolNameByIndex(request: RequestData, toolIndex: number): string | null {
  const tools = request.tools;
  if (!tools || !tools.length) return null;

  // The tool call index corresponds to the position in the tools array
  // that was sent to the upstream API. After conversion from Anthropic to
  // OpenAI format, tools are in the same order, so index 0 = first tool, etc.
  if (toolIndex < tools.length) {
    const tool = tools[toolIndex];
    const name = tool.name;
    if (typeof name === "string" && name.trim()) {
      return name.trim();
    }
  }
  return null;
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
