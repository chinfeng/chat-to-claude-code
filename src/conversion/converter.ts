/** Anthropic Messages API → OpenAI Chat Completions API conversion. */

import { isServerToolType, buildServerToolFunctionSchema, buildServerToolSystemPromptSuffix } from "../server/server_tools.js";
import { canonicalJsonStringify } from "./canonical.js";

export class OpenAIConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAIConversionError";
  }
}

export enum ReasoningReplayMode {
  DISABLED = "disabled",
  THINK_TAGS = "think_tags",
  REASONING_CONTENT = "reasoning_content",
}

function thinkTagContent(reasoning: string): string {
  return `<think>\n${reasoning}\n</think>`;
}

function toolInputSchema(tool: Record<string, unknown>): Record<string, unknown> {
  const schema = tool.input_schema;
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    return schema as Record<string, unknown>;
  }
  return { type: "object", properties: {} };
}

/** Remove the single line terminator (\r\n | \r | \n) starting at fromIndex. */
function stripTrailingNewline(text: string, fromIndex: number): string {
  if (text[fromIndex] === "\r" && text[fromIndex + 1] === "\n") {
    return text.slice(0, fromIndex) + text.slice(fromIndex + 2);
  }
  return text.slice(0, fromIndex) + text.slice(fromIndex + 1);
}

/** Strip a leading `x-anthropic-billing-header: <value>` line from a system
 *  prompt text block.
 *
 *  Claude Code prepends a `x-anthropic-billing-header: cch=<rotating value>;`
 *  line to the system prompt on every request. The value rotates per request,
 *  so it mutates the prompt prefix run-to-run and defeats upstream prefix-cache
 *  reuse (two otherwise-identical turns never share a cache entry because the
 *  billing line differs). Stripping just this FIRST line — only when it is
 *  exactly the billing header at offset 0 — restores a stable prefix. A later
 *  occurrence lower in the text (e.g. a billing-like string a user pasted
 *  mid-prompt) is left untouched. Matches cc-switch
 *  `strip_leading_anthropic_billing_header`.
 *
 *  Returns the text with the header line + its single trailing terminator
 *  removed; returns "" if the header line IS the entire string. */
function stripLeadingAnthropicBillingHeader(text: string): string {
  if (!text.startsWith("x-anthropic-billing-header:")) return text;
  const nl = text.search(/\r\n|\r|\n/);
  if (nl === -1) return ""; // header line is the entire string
  return stripTrailingNewline(text, nl);
}

/** OpenAI `role: tool` messages can only carry text. Media blocks inside an
 *  Anthropic `tool_result` (e.g. an MCP tool returning an image) would otherwise
 *  be JSON-stringified into the tool content — useless to the model. So we split
 *  the content into: `text` for the tool message, and `images` (OpenAI
 *  `image_url` parts) to re-emit as a synthetic `{role: user}` turn immediately
 *  after the tool message(s). Matches cc-switch `tool_media.rs`. */
const TOOL_RESULT_MEDIA_MARKER = "[tool result media moved to the following user message]";

interface ToolResultSerialization {
  text: string;
  images: Record<string, unknown>[];
}

function serializeToolResultContent(toolContent: unknown): ToolResultSerialization {
  if (toolContent === null || toolContent === undefined) return { text: "", images: [] };
  if (typeof toolContent === "string") return { text: toolContent, images: [] };
  if (typeof toolContent === "object" && !Array.isArray(toolContent)) {
    return { text: JSON.stringify(toolContent), images: [] };
  }
  if (Array.isArray(toolContent)) {
    const textParts: string[] = [];
    const images: Record<string, unknown>[] = [];
    for (const item of toolContent) {
      if (item !== null && typeof item === "object") {
        const itemType = (item as Record<string, unknown>).type;
        if (itemType === "text") {
          textParts.push(String((item as Record<string, unknown>).text ?? ""));
        } else if (itemType === "image") {
          const part = buildImagePartFromBlock(item as ContentBlock);
          if (part) images.push(part);
        } else {
          // Structured blocks (web_search_result, etc.) — textified as before.
          textParts.push(JSON.stringify(item));
        }
      } else {
        textParts.push(String(item));
      }
    }
    return { text: textParts.join("\n"), images };
  }
  return { text: String(toolContent), images: [] };
}

/** Build an OpenAI `image_url` content part from an Anthropic image block
 *  (base64 `source` → `data:` URL, or url `source` → passthrough), preserving
 *  any `detail` hint. Returns null for unsupported/empty sources. Shared by the
 *  user-message image path and the tool_result media-extraction path. */
function buildImagePartFromBlock(block: ContentBlock): Record<string, unknown> | null {
  const source = getBlockAttr(block, "source", {}) as Record<string, unknown>;
  if (!source || typeof source !== "object") return null;
  const sourceType = String(source.type ?? "");
  if (sourceType === "base64") {
    const mediaType = String(source.media_type || source.mime_type || "image/png");
    const data = String(source.data ?? "");
    if (!data || !isImageMimeType(mediaType)) return null;
    const url = data.startsWith("data:") ? data : `data:${mediaType};base64,${data}`;
    return { type: "image_url", image_url: mergeImageDetail({ url }, block) };
  }
  if (sourceType === "url") {
    const url = String(source.url ?? "");
    if (!url) return null;
    return { type: "image_url", image_url: mergeImageDetail({ url }, block) };
  }
  return null;
}

function cleanReasoningContent(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value || null;
}

interface PendingAfterTools {
  remainingToolIds: Set<string>;
  deferredBlocks: ContentBlock[];
  topLevelReasoning: string | null;
  reasoningReplay: ReasoningReplayMode;
  deferredEmitted: boolean;
}

function needsDeferred(p: PendingAfterTools): boolean {
  return p.deferredBlocks.length > 0 && !p.deferredEmitted;
}

type ContentBlock = Record<string, unknown>;

function getBlockType(block: ContentBlock): string | null {
  return (block.type as string) ?? null;
}

function getBlockAttr(block: ContentBlock, attr: string, defaultValue: unknown = null): unknown {
  if (block !== null && typeof block === "object" && attr in block) {
    return block[attr];
  }
  return defaultValue;
}

function indexFirstToolUse(blocks: ContentBlock[]): number | null {
  for (let i = 0; i < blocks.length; i++) {
    if (getBlockType(blocks[i]) === "tool_use") return i;
  }
  return null;
}

function iterToolUsesInOrder(blocks: ContentBlock[]): Record<string, unknown>[] {
  const toolCalls: Record<string, unknown>[] = [];
  for (const block of blocks) {
    if (getBlockType(block) !== "tool_use") continue;
    const toolInput = getBlockAttr(block, "input", {});
    toolCalls.push({
      id: getBlockAttr(block, "id"),
      type: "function",
      function: {
        name: getBlockAttr(block, "name"),
        // Canonical (sorted-keys) serialization so the same tool invocation
        // produces identical wire bytes regardless of input key order —
        // stable prefix for upstream cache reuse. See canonical.ts.
        arguments:
          typeof toolInput === "object" && toolInput !== null && !Array.isArray(toolInput)
            ? canonicalJsonStringify(toolInput)
            : String(toolInput),
      },
    });
  }
  return toolCalls;
}

function deferredPostToolBlocks(content: ContentBlock[], firstToolIndex: number): ContentBlock[] {
  return content.filter(
    (b, i) => i > firstToolIndex && getBlockType(b) !== "tool_use",
  );
}

/** Check for forbidden assistant content blocks that need graceful degradation.
 *  Returns a text placeholder for blocks that are tolerated but not natively
 *  supported by OpenAI Chat format (e.g. images → "[Image]"), or null if the
 *  block is safe to skip silently (server_tool_use, etc.). Only throws for truly
 *  unsupported block types that cannot be mapped at all. */
function assertNoForbiddenAssistantBlock(block: ContentBlock): string | null {
  const blockType = getBlockType(block);
  if (blockType === "image") {
    // OpenAI Chat does not support image blocks in assistant messages.
    // Degrade gracefully: insert a text placeholder so conversation flow
    // is preserved and the user knows an image was present.
    return "[Image]";
  }
  // server_tool_use, web_search_tool_result, web_fetch_tool_result are handled
  // separately by server tool injection — they are not forbidden, just skipped
  // in normal conversion since they're proxy-side only.
  return null;
}

/** Check if a block type is a tool-result-like block that should be serialized
 *  as an OpenAI "tool" role message. */
function isToolResultBlockType(blockType: string | null): boolean {
  return blockType === "tool_result" ||
    blockType === "web_search_tool_result" ||
    blockType === "web_fetch_tool_result";
}

export interface AnthropicMessage {
  role: string;
  content: string | ContentBlock[];
  reasoning_content?: string | null;
}

function _convertAssistantMessage(
  content: ContentBlock[],
  reasoningContent: string | null = null,
  reasoningReplay: ReasoningReplayMode = ReasoningReplayMode.THINK_TAGS,
): Record<string, unknown>[] {
  const contentParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls: Record<string, unknown>[] = [];

  for (const block of content) {
    const blockType = getBlockType(block);
    if (blockType === "text") {
      contentParts.push(String(getBlockAttr(block, "text", "") ?? ""));
    } else if (blockType === "thinking") {
      if (reasoningReplay === ReasoningReplayMode.DISABLED) continue;
      const thinking = String(getBlockAttr(block, "thinking", "") ?? "");
      // Preserve the signature as base64-encoded opaque data within the
      // reasoning replay so it round-trips across turns. We wrap it as a
      // prefix delimiter in the think_tags output: the proxy recognizes
      // it on re-ingestion and strips it from the visible content.
      const signature = String(getBlockAttr(block, "signature", "") ?? "");
      if (reasoningReplay === ReasoningReplayMode.THINK_TAGS) {
        const tagged = signature
          ? `<!--sig:${signature}-->\n${thinkTagContent(thinking)}`
          : thinkTagContent(thinking);
        contentParts.push(tagged);
      } else if (reasoningContent === null) {
        thinkingParts.push(thinking);
        if (signature) {
          // Stash signature as a hidden prefix in the first thinking part
          thinkingParts.push(`<!--sig:${signature}-->`);
        }
      }
    } else if (blockType === "redacted_thinking") {
      if (reasoningReplay === ReasoningReplayMode.DISABLED) continue;
      // Preserve redacted thinking as an opaque placeholder so multi-turn
      // thinking chain verification doesn't break: replay "[redacted thinking]"
      // in the reasoning stream so the upstream model knows thinking existed.
      if (reasoningReplay === ReasoningReplayMode.THINK_TAGS) {
        contentParts.push("[redacted thinking]");
      } else if (reasoningContent === null) {
        thinkingParts.push("[redacted thinking]");
      }
    } else if (blockType === "tool_use") {
      const toolInput = getBlockAttr(block, "input", {});
      toolCalls.push({
        id: getBlockAttr(block, "id"),
        type: "function",
        function: {
          name: getBlockAttr(block, "name"),
          // Canonical (sorted-keys) serialization — stable wire bytes for the
          // same invocation regardless of input key order. See canonical.ts.
          arguments:
            typeof toolInput === "object" && toolInput !== null && !Array.isArray(toolInput)
              ? canonicalJsonStringify(toolInput)
              : String(toolInput),
        },
      });
    } else {
      const placeholder = assertNoForbiddenAssistantBlock(block);
      if (placeholder) contentParts.push(placeholder);
    }
  }

  let contentStr = contentParts.join("\n\n");
  if (!contentStr && !toolCalls.length) contentStr = " ";

  const msg: Record<string, unknown> = { role: "assistant", content: contentStr };

  if (toolCalls.length) msg.tool_calls = toolCalls;

  if (reasoningReplay === ReasoningReplayMode.REASONING_CONTENT) {
    const replayReasoning = reasoningContent || thinkingParts.join("\n");
    if (replayReasoning) msg.reasoning_content = replayReasoning;
  }

  return [msg];
}

function _deferredPostToolToMessages(pending: PendingAfterTools): Record<string, unknown>[] {
  if (!pending.deferredBlocks.length) return [];
  return _convertAssistantMessage(
    pending.deferredBlocks,
    pending.topLevelReasoning,
    pending.reasoningReplay,
  );
}

function _convertAssistantMessageWithSplit(
  content: ContentBlock[],
  firstToolIndex: number,
  reasoningContent: string | null,
  reasoningReplay: ReasoningReplayMode,
): { messages: Record<string, unknown>[]; pending: PendingAfterTools | null } {
  const pre = content.slice(0, firstToolIndex);
  const toolCalls = iterToolUsesInOrder(content);

  if (!toolCalls.length) {
    return {
      messages: _convertAssistantMessage(content, reasoningContent, reasoningReplay),
      pending: null,
    };
  }

  const deferredBlocks = deferredPostToolBlocks(content, firstToolIndex);

  let preMsg: Record<string, unknown>;
  if (!pre.length) {
    preMsg = { role: "assistant", content: "" };
    if (reasoningReplay === ReasoningReplayMode.REASONING_CONTENT) {
      const replay = reasoningContent;
      if (replay) preMsg.reasoning_content = replay;
    }
  } else {
    preMsg = {
      ..._convertAssistantMessage(pre, reasoningContent, reasoningReplay)[0],
    };
  }

  preMsg.tool_calls = toolCalls;
  if (toolCalls.length && preMsg.content === " ") preMsg.content = "";

  let pnd: PendingAfterTools | null = null;
  if (deferredBlocks.length) {
    const resIds = new Set<string>();
    for (const tc of toolCalls) {
      const tid = tc.id;
      if (tid !== null && tid !== undefined && String(tid).trim() !== "") {
        resIds.add(String(tid));
      }
    }
    pnd = {
      remainingToolIds: resIds,
      deferredBlocks,
      topLevelReasoning: reasoningContent,
      reasoningReplay,
      deferredEmitted: false,
    };
  }

  return { messages: [preMsg], pending: pnd };
}

function _convertUserMessageWithInjection(
  content: ContentBlock[],
  pending: PendingAfterTools,
): { messages: Record<string, unknown>[]; clearedPending: boolean } {
  if (!needsDeferred(pending) || !pending.remainingToolIds.size) {
    return { messages: _convertUserMessage(content), clearedPending: false };
  }

  const result: Record<string, unknown>[] = [];
  const textParts: string[] = [];
  const toolMedia: Record<string, unknown>[] = [];
  let cleared = false;

  const flushText = (): void => {
    if (textParts.length) {
      result.push({ role: "user", content: textParts.join("\n") });
      textParts.length = 0;
    }
  };

  for (const block of content) {
    const blockType = getBlockType(block);
    if (blockType === "text") {
      textParts.push(String(getBlockAttr(block, "text", "") ?? ""));
    } else if (blockType === "image") {
      throw new OpenAIConversionError(
        "User message image blocks are not supported for OpenAI chat conversion.",
      );
    } else if (isToolResultBlockType(blockType)) {
      flushText();
      const toolContent = getBlockAttr(block, "content", "");
      const isError = getBlockAttr(block, "is_error") === true;
      const { text, images } = serializeToolResultContent(toolContent);
      const tuid = getBlockAttr(block, "tool_use_id");
      const tuidS = tuid !== null && tuid !== undefined ? String(tuid) : "";
      const toolText = images.length
        ? `${text}${text ? "\n" : ""}${TOOL_RESULT_MEDIA_MARKER}`
        : text;
      const finalContent = (isError ? "[TOOL_ERROR] " : "") + (toolText || "");

      result.push({
        role: "tool",
        tool_call_id: tuid,
        content: finalContent,
      });
      if (images.length) toolMedia.push(...images);

      if (pending.remainingToolIds.has(tuidS)) {
        pending.remainingToolIds.delete(tuidS);
        if (!pending.remainingToolIds.size) {
          result.push(..._deferredPostToolToMessages(pending));
          pending.deferredEmitted = true;
          cleared = true;
        }
      }
    }
  }

  flushText();
  // Re-emit extracted tool_result media as a synthetic user turn after the
  // tool message(s) (+ any deferred assistant blocks) — OpenAI tool messages
  // cannot carry images (G10).
  if (toolMedia.length) {
    result.push({
      role: "user",
      content: [{ type: "text", text: TOOL_RESULT_MEDIA_MARKER }, ...toolMedia],
    });
  }
  return { messages: result, clearedPending: cleared };
}

function _convertUserMessage(content: ContentBlock[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const textParts: string[] = [];
  let imageParts: Record<string, unknown>[] = [];
  // Media blocks extracted from tool_result content — re-emitted as a synthetic
  // {role: user} turn after the tool message(s), since OpenAI tool messages
  // can't carry images (G10). See serializeToolResultContent.
  const toolMedia: Record<string, unknown>[] = [];

  const flushText = (): void => {
    if (textParts.length) {
      result.push({ role: "user", content: textParts.join("\n") });
      textParts.length = 0;
    }
  };

  const flushImages = (): void => {
    // OpenAI supports mixed text + image in a single user message via
    // content part array, but only when there are images. Coerce text-only
    // messages to string content for compatibility.
    if (imageParts.length) {
      flushText();
      // Pull all previously emitted simple "user" messages back into
      // content-parts format only when there's exactly one user message
      // with text content. If we have tool messages between user turns,
      // we can't merge — emit images separately.
      const contentParts: Record<string, unknown>[] = [];
      // Collect any loose text from the last emitted user message
      for (let i = result.length - 1; i >= 0; i--) {
        const msg = result[i];
        if (msg.role === "user" && typeof msg.content === "string") {
          contentParts.push({ type: "text", text: msg.content });
          result.splice(i, 1);
          break;
        }
      }
      contentParts.push(...imageParts);
      result.push({ role: "user", content: contentParts });
      imageParts = [];
    }
  };

  for (const block of content) {
    const blockType = getBlockType(block);
    if (blockType === "text") {
      // flushImages before accumulating more text (images need to be co-located)
      textParts.push(String(getBlockAttr(block, "text", "") ?? ""));
    } else if (blockType === "image") {
      const part = buildImagePartFromBlock(block);
      if (part) imageParts.push(part);
    } else if (blockType === "document") {
      // Anthropic document blocks carry PDFs/images/other media. OpenAI Chat
      // has no native "document" content part type. Strategy:
      //   - base64 image documents → image_url content part (preserves binary data)
      //   - base64 non-image documents → text reference with data URL (preserves data)
      //   - url documents → text reference with URL (existing behavior)
      const source = getBlockAttr(block, "source", {}) as Record<string, unknown>;
      const title = String(getBlockAttr(block, "title", "") ?? "");
      const context = String(getBlockAttr(block, "context", "") ?? "");
      if (source && typeof source === "object") {
        const sourceType = String(source.type ?? "");
        const mediaType = String(source.media_type ?? source.mime_type ?? "");
        if (sourceType === "base64" && isImageMimeType(mediaType)) {
          // Image document → convert to image_url content part
          const data = String(source.data ?? "");
          if (data) {
            flushText();
            const url = data.startsWith("data:") ? data : `data:${mediaType};base64,${data}`;
            imageParts.push({ type: "image_url", image_url: { url } });
          }
        } else if (sourceType === "base64") {
          // Non-image binary document → include data URL in text reference
          const data = String(source.data ?? "");
          const filename = title || "document";
          const dataUrl = data ? `data:${mediaType};base64,${data}` : mediaType;
          const desc = `${filename} (${dataUrl})`;
          textParts.push(context ? `[Document: ${desc}]\n${context}` : `[Document: ${desc}]`);
        } else {
          // URL source → existing behavior
          const filename = title || (sourceType === "url" ? String(source.url ?? "") : "document");
          const desc = mediaType ? `${filename} (${mediaType})` : filename;
          textParts.push(context ? `[Document: ${desc}]\n${context}` : `[Document: ${desc}]`);
        }
      }
    } else if (isToolResultBlockType(blockType)) {
      flushImages();
      flushText();
      const toolContent = getBlockAttr(block, "content", "");
      const isError = getBlockAttr(block, "is_error") === true;
      const { text, images } = serializeToolResultContent(toolContent);
      const toolText = images.length
        ? `${text}${text ? "\n" : ""}${TOOL_RESULT_MEDIA_MARKER}`
        : text;
      result.push({
        role: "tool",
        tool_call_id: getBlockAttr(block, "tool_use_id"),
        content: (isError ? "[TOOL_ERROR] " : "") + (toolText || ""),
      });
      if (images.length) toolMedia.push(...images);
    }
  }

  flushImages();
  flushText();
  // Re-emit extracted tool_result media as a synthetic user turn (after the tool
  // messages) — OpenAI tool messages cannot carry images (G10).
  if (toolMedia.length) {
    result.push({
      role: "user",
      content: [{ type: "text", text: TOOL_RESULT_MEDIA_MARKER }, ...toolMedia],
    });
  }
  return result;
}

function isImageMimeType(mime: string): boolean {
  return mime.toLowerCase().startsWith("image/");
}

function mergeImageDetail(
  imageUrl: Record<string, unknown>,
  block: ContentBlock,
): Record<string, unknown> {
  const detail = getBlockAttr(block, "detail", null);
  if (detail) (imageUrl as Record<string, unknown>).detail = detail;
  return imageUrl;
}

export class AnthropicToOpenAIConverter {
  static convertMessages(
    messages: AnthropicMessage[],
    reasoningReplay: ReasoningReplayMode = ReasoningReplayMode.THINK_TAGS,
  ): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = [];
    let pending: PendingAfterTools | null = null;

    for (const msg of messages) {
      const { role, content } = msg;
      const reasoningContent = cleanReasoningContent(msg.reasoning_content);

      if (role === "assistant" && Array.isArray(content)) {
        if (pending !== null && needsDeferred(pending)) {
          result.push(..._deferredPostToolToMessages(pending));
          pending.deferredEmitted = true;
          pending = null;
        }

        const firstI = indexFirstToolUse(content);
        if (firstI !== null) {
          for (const block of content) {
            if (getBlockType(block) === "tool_use") continue;
            assertNoForbiddenAssistantBlock(block);
          }
          const { messages: out, pending: newPending } = _convertAssistantMessageWithSplit(
            content,
            firstI,
            reasoningContent,
            reasoningReplay,
          );
          result.push(...out);
          if (newPending !== null) pending = newPending;
        } else {
          for (const block of content) assertNoForbiddenAssistantBlock(block);
          result.push(..._convertAssistantMessage(content, reasoningContent, reasoningReplay));
        }
      } else if (typeof content === "string") {
        if (role === "user" && pending !== null && needsDeferred(pending)) {
          result.push(..._deferredPostToolToMessages(pending));
          pending.deferredEmitted = true;
          pending = null;
        }

        const converted: Record<string, unknown> = { role, content };

        if (role === "assistant" && reasoningContent) {
          if (reasoningReplay === ReasoningReplayMode.REASONING_CONTENT) {
            converted.reasoning_content = reasoningContent;
          } else if (reasoningReplay === ReasoningReplayMode.THINK_TAGS) {
            const contentParts = [thinkTagContent(reasoningContent)];
            if (content) contentParts.push(content);
            converted.content = contentParts.join("\n\n");
          }
        }

        result.push(converted);
      } else if (Array.isArray(content)) {
        if (role === "user") {
          if (pending !== null && needsDeferred(pending)) {
            if (!pending.remainingToolIds.size) {
              result.push(..._deferredPostToolToMessages(pending));
              pending.deferredEmitted = true;
              pending = null;
            }
            if (pending !== null) {
              const pieces = _convertUserMessageWithInjection(content, pending);
              result.push(...pieces.messages);
              if (pieces.clearedPending) pending = null;
            } else {
              result.push(..._convertUserMessage(content));
            }
          } else {
            result.push(..._convertUserMessage(content));
          }
        }
      } else {
        if (role === "user" && pending !== null && needsDeferred(pending)) {
          result.push(..._deferredPostToolToMessages(pending));
          pending.deferredEmitted = true;
          pending = null;
        }
        result.push({ role, content: String(content) });
      }
    }

    if (pending !== null && needsDeferred(pending)) {
      result.push(..._deferredPostToolToMessages(pending));
    }

    return result;
  }

  static convertTools(
    tools: Record<string, unknown>[],
  ): Record<string, unknown>[] {
    return tools
      .filter((tool) => !isServerToolType(String(tool.type ?? "")))
      .map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description || "",
          parameters: toolInputSchema(tool),
        },
      }));
  }

  static convertToolChoice(toolChoice: unknown): unknown {
    if (typeof toolChoice !== "object" || toolChoice === null) return toolChoice;
    const tc = toolChoice as Record<string, unknown>;
    const choiceType = tc.type;

    if (choiceType === "tool") {
      const name = tc.name;
      if (name) return { type: "function", function: { name } };
    }
    if (choiceType === "any") return "required";
    if (choiceType === "auto" || choiceType === "none" || choiceType === "required") {
      return choiceType;
    }
    if (choiceType === "function" && typeof tc.function === "object" && tc.function !== null) {
      return toolChoice;
    }
    return toolChoice;
  }

  /** Check if the Anthropic `tool_choice` has `disable_parallel_tool_use: true`. */
  static hasDisableParallelToolUse(toolChoice: unknown): boolean {
    if (typeof toolChoice !== "object" || toolChoice === null) return false;
    const tc = toolChoice as Record<string, unknown>;
    return tc.disable_parallel_tool_use === true;
  }

  static convertSystemPrompt(
    system: unknown,
  ): Record<string, string> | null {
    if (typeof system === "string") {
      // Strip the rotating `x-anthropic-billing-header:` first line so the
      // system prompt has a stable prefix (upstream prefix-cache reuse).
      const stripped = stripLeadingAnthropicBillingHeader(system).trim();
      return stripped ? { role: "system", content: stripped } : null;
    }
    if (Array.isArray(system)) {
      const textParts: string[] = [];
      for (const block of system) {
        if (getBlockType(block as ContentBlock) === "text") {
          const text = stripLeadingAnthropicBillingHeader(
            String(getBlockAttr(block as ContentBlock, "text", "") ?? ""),
          ).trim();
          if (text) textParts.push(text);
        }
      }
      if (textParts.length) {
        return { role: "system", content: textParts.join("\n\n").trim() };
      }
    }
    return null;
  }
}

export interface RequestData {
  model: string;
  messages: AnthropicMessage[];
  system?: unknown;
  max_tokens?: number | null;
  temperature?: number | null;
  top_p?: number | null;
  stop_sequences?: string[] | null;
  tools?: Record<string, unknown>[] | null;
  tool_choice?: unknown;
  server_tools?: Record<string, unknown>[] | null;
}

export function buildBaseRequestBody(
  requestData: RequestData,
  defaultMaxTokens?: number,
  reasoningReplay: ReasoningReplayMode = ReasoningReplayMode.THINK_TAGS,
): Record<string, unknown> {
  const messages = AnthropicToOpenAIConverter.convertMessages(
    requestData.messages,
    reasoningReplay,
  );

  const system = requestData.system;
  const serverTools = requestData.server_tools;
  // Collect server tools from BOTH server_tools field AND tools array
  // (Claude Code puts server tools in tools array, not in server_tools field)
  const allServerTools: Record<string, unknown>[] = [];
  if (serverTools?.length) {
    for (const st of serverTools) {
      if (!allServerTools.some((t) => t.type === st.type && t.name === st.name)) {
        allServerTools.push(st);
      }
    }
  }
  if (requestData.tools?.length) {
    for (const tool of requestData.tools) {
      if (isServerToolType(String(tool.type ?? ""))) {
        if (!allServerTools.some((t) => t.type === tool.type && t.name === tool.name)) {
          allServerTools.push(tool);
        }
      }
    }
  }
  const serverToolPrompt = allServerTools.length ? buildServerToolSystemPromptSuffix(allServerTools) : "";

  if (system) {
    const systemMsg = AnthropicToOpenAIConverter.convertSystemPrompt(system);
    if (systemMsg) {
      if (serverToolPrompt) {
        systemMsg.content = String(systemMsg.content) + "\n\n" + serverToolPrompt;
      }
      messages.unshift(systemMsg);
    }
  } else if (serverToolPrompt) {
    messages.unshift({ role: "system", content: serverToolPrompt });
  }

  const body: Record<string, unknown> = { model: requestData.model, messages };

  const maxTokens = requestData.max_tokens ?? defaultMaxTokens;
  if (maxTokens !== null && maxTokens !== undefined) body.max_tokens = maxTokens;
  if (requestData.temperature !== null && requestData.temperature !== undefined) {
    body.temperature = requestData.temperature;
  }
  if (requestData.top_p !== null && requestData.top_p !== undefined) {
    body.top_p = requestData.top_p;
  }

  const stopSequences = requestData.stop_sequences;
  if (stopSequences && stopSequences.length) body.stop = stopSequences;

  const tools = requestData.tools;
  // Build server tool function schemas from BOTH server_tools field AND
  // server tool entries embedded in the tools array (e.g. type="web_search_20250305").
  // Claude Code sends server tools in the tools array, not in server_tools.
  const serverToolSchemas: Record<string, unknown>[] = [];
  const seenServerToolTypes = new Set<string>();

  // From server_tools field
  if (serverTools?.length) {
    for (const st of serverTools) {
      const stType = String(st.type ?? "");
      const stName = String(st.name ?? "");
      const schema = buildServerToolFunctionSchema(stType, stName);
      if (schema) {
        serverToolSchemas.push(schema);
        seenServerToolTypes.add(stType);
      }
    }
  }

  // From tools array — extract server tool entries that were filtered by convertTools
  if (tools?.length) {
    for (const tool of tools) {
      const toolType = String(tool.type ?? "");
      if (isServerToolType(toolType) && !seenServerToolTypes.has(toolType)) {
        const toolName = String(tool.name ?? "");
        const schema = buildServerToolFunctionSchema(toolType, toolName);
        if (schema) {
          serverToolSchemas.push(schema);
          seenServerToolTypes.add(toolType);
        }
      }
    }
  }

  if (tools && tools.length) {
    const regularTools = AnthropicToOpenAIConverter.convertTools(tools);
    const allTools = [...regularTools, ...serverToolSchemas];
    if (allTools.length) body.tools = allTools;
  } else if (serverToolSchemas.length) {
    body.tools = serverToolSchemas;
  }

  const toolChoice = requestData.tool_choice;
  if (toolChoice) {
    body.tool_choice = AnthropicToOpenAIConverter.convertToolChoice(toolChoice);
    if (AnthropicToOpenAIConverter.hasDisableParallelToolUse(toolChoice)) {
      body.parallel_tool_calls = false;
    }
  }

  return body;
}
