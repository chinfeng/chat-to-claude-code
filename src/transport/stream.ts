/** OpenAI-style chat transport: streams /chat/completions upstream, emits Anthropic SSE downstream. */

import { randomUUID } from "crypto";
import { SSEBuilder, mapStopReason, mapErrorType } from "../sse/builder.js";
import type { UsageInfo } from "../sse/builder.js";
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

/** Detect which stop sequence (if any) the accumulated text ends with.
 *  Some upstream APIs strip stop sequences from the output; this detection
 *  only fires when the upstream does NOT strip them. When the upstream has
 *  already stripped the sequence, returns null — the original behavior. */
function detectStopSequence(text: string, sequences: readonly string[] | null | undefined): string | null {
  if (!sequences?.length || !text) return null;
  for (const seq of sequences) {
    if (seq && text.endsWith(seq)) return seq;
  }
  return null;
}

/**
 * Thrown when the upstream CONNECTION terminates mid-stream — either a read
 * error/reset (the upstream socket was closed unexpectedly) or a clean EOF
 * with no `finish_reason` (the upstream closed without completing the
 * generation). Carries no upstream error code.
 *
 * Propagated to the route layer, which first close_all_blocks()'s any open
 * content blocks (well-formed prefix), then emits a top-level SSE
 * `event: error` — but NO message_delta/message_stop and NO self-defined
 * finish_reason, so the failure is never disguised as a completed assistant
 * turn and never poisons conversation history.
 *
 * Retry: the route layer emits the cc-switch-aligned mid-stream error shape
 * (`error.type = "stream_error"` with the descriptive upstream message; see
 * `buildMidStreamErrorSse`). claude-code's mid-stream retry predicate `sym`
 * fires only on HTTP 429/5xx (impossible mid-stream — 200 is already committed)
 * or the literal substring `'"type":"overloaded_error"'` inside `e.message`
 * (the SDK builds `e.message` from `body.error.message`, not `error.type`).
 * `stream_error` has neither, so claude-code does NOT retry a partially-
 * streamed turn. This is the accepted cc-switch trade-off: cc-switch recovers
 * from aborts by transparently failing over to another provider BEFORE
 * committing the 200 (a first-byte gate), and relies on the HTTP-status retry
 * trigger only for pre-commit failures; post-commit, it surfaces the error and
 * lets the client not retry. Same downstream `event: error` treatment as
 * UpstreamStreamError (upstream sent an explicit error object while still
 * connected) — that class carries a code but it is not used to alter the
 * error-event type, since cc-switch's streaming converter emits a single
 * non-retryable `stream_error` regardless of cause.
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
      refusal?: string | null;
      tool_calls?: {
        index: number;
        id?: string | null;
        function: { name?: string | null; arguments?: string | null };
      }[];
    } | null;
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** Anthropic-compat direct cache fields (some upstreams surface these). */
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    /** OpenAI-standard usage breakdown. GLM-5.2 / OpenAI expose cache hits here:
     *  cached_tokens = read from cache, cache_write_tokens = written to cache.
     *  These are the FALLBACK behind the direct compat fields above. */
    prompt_tokens_details?: {
      cached_tokens?: number;
      cache_write_tokens?: number;
    } | null;
  } | null;
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

/** Extract Anthropic-compatible usage from an OpenAI usage chunk.
 *
 *  Cache buckets are read with two-tier fallback (matching cc-switch
 *  `extract_cache_read_tokens` / `extract_cache_write_tokens`):
 *
 *    cache_read       = usage.cache_read_input_tokens        (Anthropic-compat direct)
 *                     | usage.prompt_tokens_details.cached_tokens   (OpenAI-standard)
 *    cache_creation   = usage.cache_creation_input_tokens    (Anthropic-compat direct)
 *                     | usage.prompt_tokens_details.cache_write_tokens (OpenAI-standard)
 *
 *  GLM-5.2 via newapi surfaces its cache hits in `prompt_tokens_details`
 *  (OpenAI-standard form), not in the Anthropic-compat direct fields — so reading
 *  only the direct fields dropped all cache accounting for the GLM upstream. */
export function extractUsageInfo(
  chunkUsage: StreamChunk["usage"],
): UsageInfo | null {
  if (!chunkUsage) return null;
  const prompt = chunkUsage.prompt_tokens ?? 0;
  const completion = chunkUsage.completion_tokens ?? 0;
  const details = chunkUsage.prompt_tokens_details ?? null;
  const cacheRead =
    chunkUsage.cache_read_input_tokens ??
    (details?.cached_tokens && details.cached_tokens > 0 ? details.cached_tokens : 0);
  const cacheCreate =
    chunkUsage.cache_creation_input_tokens ??
    (details?.cache_write_tokens && details.cache_write_tokens > 0 ? details.cache_write_tokens : 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreate,
  };
}

/** Attempt to auto-close / repair a truncated JSON string by patching
 *  unbalanced braces and quotes. Returns the repaired JSON if successful,
 *  otherwise the original string. */
function repairTruncatedJson(raw: string): string {
  if (!raw.trim()) return "{}";
  try { JSON.parse(raw); return raw; } catch { /* needs repair */ }
  const trimmed = raw.trim();
  let result = trimmed;

  // Count open/close braces and brackets
  let braceDepth = 0;
  let bracketDepth = 0;
  let inString = false;
  let prevChar = "";
  for (let i = 0; i < result.length; i++) {
    const ch = result[i];
    if (ch === '"' && prevChar !== "\\") inString = !inString;
    if (inString) { prevChar = ch; continue; }
    if (ch === "{") braceDepth++;
    else if (ch === "}") braceDepth--;
    else if (ch === "[") bracketDepth++;
    else if (ch === "]") bracketDepth--;
    prevChar = ch;
  }
  // Close unpaired quotes
  if (inString) result += '"';
  // Close unpaired brackets first, then braces
  while (bracketDepth > 0) { result += "]"; bracketDepth--; }
  while (braceDepth > 0) { result += "}"; braceDepth--; }
  try { JSON.parse(result); return result; } catch { return trimmed; }
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
  const thinkingEnabled = isThinkingEnabled(request, thinkingEnabledHint);

  let firstUsageInfo: UsageInfo | null = null;
  // Set when the upstream sent the OpenAI stream-end marker `data: [DONE]` (surfaced
  // as the `{ __sseDone: true }` sentinel by parseSseLine in routes.ts). When set
  // we treat a finish-reason-less end as graceful completion (implicit `stop`),
  // not a connection abort — matches cc-switch's [DONE] handling.
  let seenDone = false;
  const sse = new SSEBuilder(messageId, request.model, inputTokens, firstUsageInfo);

  // If startingBlockIndex is provided, advance the block counter
  if (options?.startingBlockIndex) {
    sse.blocks.nextIndex = options.startingBlockIndex;
  }

  const thinkParser = new ThinkTagParser();
  const heuristicParser = new HeuristicToolParser();
  let finishReason: string | null = null;
  let usageInfo: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  } | null = null;

  if (!options?.skipMessageLifecycle) {
    yield sse.message_start();
  }

  // Cumulative tool-call argument accumulators for JSON repair on stream close
  const toolArgAccum: Map<number, string> = new Map();

  try {
    for await (const chunk of upstreamStream) {
      // OpenAI stream-end marker: `[DONE]` is an explicit completion signal even
      // when no `finish_reason` chunk arrived (some providers emit `[DONE]`
      // without finish_reason). Treat it as graceful completion (matching
      // cc-switch), not a connection abort. parseSseLine surfaces it as the
      // `{ __sseDone: true }` sentinel (see routes.ts); it carries no
      // choices/usage, so detect+break here before the normal-chunk handling.
      if ((chunk as Record<string, unknown>).__sseDone) {
        seenDone = true;
        break;
      }
      if (chunk.usage) {
        usageInfo = chunk.usage;
        // Update sse's usage info with the latest (most complete) chunk
        if (!firstUsageInfo) {
          firstUsageInfo = extractUsageInfo(chunk.usage);
          sse["_usageInfo"] = firstUsageInfo;
        } else {
          // Merge — fresher values win
          const merged = { ...firstUsageInfo, ...extractUsageInfo(chunk.usage) };
          sse["_usageInfo"] = merged;
          firstUsageInfo = merged;
        }
      }

      // Detect upstream error objects in SSE stream
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

      // Handle reasoning_content (thinking)
      const reasoning = delta.reasoning_content;
      if (thinkingEnabled && reasoning) {
        for (const event of sse.ensure_thinking_block()) yield event;
        sse.addThinkingText(reasoning);
        yield sse.content_block_delta(sse.blocks.thinkingIndex, "thinking_delta", reasoning);
      }

      // Handle refusal delta — forward as text content so the client sees it
      if (delta.refusal) {
        for (const event of sse.ensure_text_block()) yield event;
        yield sse.emit_text_delta(delta.refusal);
        continue; // refusal supersedes other delta fields in this chunk
      }

      // Handle text content
      if (delta.content) {
        for (const part of thinkParser.feed(delta.content)) {
          if (part.type === ContentType.THINKING) {
            if (!thinkingEnabled) continue;
            for (const event of sse.ensure_thinking_block()) yield event;
            sse.addThinkingText(part.content);
            yield sse.content_block_delta(sse.blocks.thinkingIndex, "thinking_delta", part.content);
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

      // Handle native tool calls (accumulate args for JSON repair later)
      if (delta.tool_calls?.length) {
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
          // Accumulate for JSON repair
          if (tc.function.arguments) {
            const prev = toolArgAccum.get(tc.index) || "";
            toolArgAccum.set(tc.index, prev + tc.function.arguments);
          }
          const tcInfo = {
            index: tc.index,
            id: tc.id,
            function: { name: tc.function.name, arguments: tc.function.arguments },
          };
          for (const event of processToolCall(tcInfo, sse)) yield event;
        }
      }
    }

    // No finish_reason chunk was seen. Two sub-cases:
    //  1. [DONE] arrived (seenDone): the upstream signalled completion
    //     explicitly even without a finish_reason chunk — treat it as an
    //     implicit `stop` and complete the turn gracefully (message_delta +
    //     message_stop), so we never turn a completed turn into a spurious
    //     abort/retry. Matches cc-switch's [DONE] handling.
    //  2. No [DONE], no finish_reason: the upstream terminated without
    //     completing (clean TCP close after the last chunk, or — via
    //     iterUpstreamChunks — a socket reset/abort). This is a connection
    //     abort: throw UpstreamAbortedError so the route layer emits an
    //     explicit, retryable `event: error` (api_error) — never a self-defined
    //     finish_reason/message_stop (that would disguise a failure as a
    //     completed turn and poison history), and never an abrupt close (which
    //     claude-code reports as "empty or malformed response (HTTP 200)" and
    //     does not retry).
    if (finishReason == null) {
      if (seenDone) {
        finishReason = "stop";
      } else {
        throw new UpstreamAbortedError(
          "Upstream stream ended without a finish_reason (connection terminated mid-generation).",
        );
      }
    }
  } catch (e) {
    // Close any content blocks opened so far so the downstream prefix is
    // well-formed up to the failure point, then rethrow: the route layer emits a
    // top-level `event: error` (retryable, e.g. api_error) — for BOTH an
    // upstream-embedded error object (UpstreamStreamError, carries a code) and
    // a connection abort (UpstreamAbortedError, no code). We deliberately do NOT
    // wrap the error in a `text` content block and do NOT emit
    // message_delta/message_stop: disguising a failure as a completed assistant
    // turn poisons conversation history, while an abrupt close with no terminal
    // marker makes claude-code report "empty or malformed response (HTTP 200)"
    // and never retry. `event: error` is the only signal that both avoids the
    // malformed-response error and triggers a retry, matching cc-switch's
    // read-error handling.
    for (const event of sse.close_all_blocks()) yield event;
    throw e;
  }

  // Flush remaining content
  const remaining = thinkParser.flush();
  if (remaining) {
    if (remaining.type === ContentType.THINKING) {
      if (thinkingEnabled) {
        for (const event of sse.ensure_thinking_block()) yield event;
        sse.addThinkingText(remaining.content);
        yield sse.content_block_delta(sse.blocks.thinkingIndex, "thinking_delta", remaining.content);
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
  let hasOrphanedToolStates = false;
  for (const [toolIndex, state] of sse.blocks.toolStates) {
    if (state.started) continue;
    if (!state.preStartArgs && !state.name) continue;

    const inferredName = inferToolNameByIndex(request, toolIndex);
    if (inferredName) {
      const resolvedId = state.toolId || `tool_${randomUUID()}`;
      for (const event of sse.close_content_blocks()) yield event;
      yield sse.start_tool_block(toolIndex, resolvedId, inferredName);
      // Attempt JSON repair on pre-start args
      const raw = state.preStartArgs;
      if (raw) {
        const repaired = repairTruncatedJson(raw);
        toolArgAccum.set(toolIndex, repaired);
        yield sse.emit_tool_delta(toolIndex, repaired);
        state.preStartArgs = "";
      }
    } else {
      hasOrphanedToolStates = true;
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

  // Flush task arg buffers with JSON repair fallback
  for (const [toolIndex, out] of sse.blocks.flushTaskArgBuffers()) {
    const repaired = repairTruncatedJson(out);
    toolArgAccum.set(toolIndex, repaired);
    yield sse.emit_tool_delta(toolIndex, repaired);
  }

  // Close all blocks — thinking blocks get signature_delta before content_block_stop
  for (const event of sse.close_all_blocks()) yield event;

  const completion =
    usageInfo && typeof usageInfo.completion_tokens === "number"
    ? usageInfo.completion_tokens
    : sse.estimate_output_tokens();

  const effectiveFinishReason = hasOrphanedToolStates ? "stop" : finishReason;

  // Detect matching stop sequence from accumulated text (best-effort —
  // upstream APIs often strip stop sequences, in which case this returns null).
  const detectedStopSeq = detectStopSequence(sse.accumulated_text, request.stop_sequences);

  if (!options?.skipMessageLifecycle) {
    yield sse.message_delta(mapStopReason(effectiveFinishReason), completion, detectedStopSeq);
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
