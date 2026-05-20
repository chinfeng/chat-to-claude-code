/** Anthropic Messages API → OpenAI Chat Completions API conversion. */

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

function serializeToolResultContent(toolContent: unknown): string {
  if (toolContent === null || toolContent === undefined) return "";
  if (typeof toolContent === "string") return toolContent;
  if (typeof toolContent === "object" && !Array.isArray(toolContent)) {
    return JSON.stringify(toolContent);
  }
  if (Array.isArray(toolContent)) {
    const parts: string[] = [];
    for (const item of toolContent) {
      if (
        item !== null &&
        typeof item === "object" &&
        (item as Record<string, unknown>).type === "text"
      ) {
        parts.push(String((item as Record<string, unknown>).text ?? ""));
      } else if (item !== null && typeof item === "object") {
        parts.push(JSON.stringify(item));
      } else {
        parts.push(String(item));
      }
    }
    return parts.join("\n");
  }
  return String(toolContent);
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
        arguments:
          typeof toolInput === "object" && toolInput !== null && !Array.isArray(toolInput)
            ? JSON.stringify(toolInput)
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

function assertNoForbiddenAssistantBlock(block: ContentBlock): void {
  const blockType = getBlockType(block);
  if (blockType === "image") {
    throw new OpenAIConversionError(
      "Assistant image blocks are not supported for OpenAI chat conversion.",
    );
  }
  if (
    blockType === "server_tool_use" ||
    blockType === "web_search_tool_result" ||
    blockType === "web_fetch_tool_result"
  ) {
    throw new OpenAIConversionError(
      `OpenAI chat conversion does not support Anthropic server tool blocks (${JSON.stringify(blockType)} in an assistant message). Use a native Anthropic transport provider.`,
    );
  }
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
      if (reasoningReplay === ReasoningReplayMode.THINK_TAGS) {
        contentParts.push(thinkTagContent(thinking));
      } else if (reasoningContent === null) {
        thinkingParts.push(thinking);
      }
    } else if (blockType === "redacted_thinking") {
      continue;
    } else if (blockType === "tool_use") {
      const toolInput = getBlockAttr(block, "input", {});
      toolCalls.push({
        id: getBlockAttr(block, "id"),
        type: "function",
        function: {
          name: getBlockAttr(block, "name"),
          arguments:
            typeof toolInput === "object" && toolInput !== null && !Array.isArray(toolInput)
              ? JSON.stringify(toolInput)
              : String(toolInput),
        },
      });
    } else {
      assertNoForbiddenAssistantBlock(block);
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
    } else if (blockType === "tool_result") {
      flushText();
      const toolContent = getBlockAttr(block, "content", "");
      const serialized = serializeToolResultContent(toolContent);
      const tuid = getBlockAttr(block, "tool_use_id");
      const tuidS = tuid !== null && tuid !== undefined ? String(tuid) : "";

      result.push({
        role: "tool",
        tool_call_id: tuid,
        content: serialized || "",
      });

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
  return { messages: result, clearedPending: cleared };
}

function _convertUserMessage(content: ContentBlock[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const textParts: string[] = [];

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
    } else if (blockType === "tool_result") {
      flushText();
      const toolContent = getBlockAttr(block, "content", "");
      const serialized = serializeToolResultContent(toolContent);
      result.push({
        role: "tool",
        tool_call_id: getBlockAttr(block, "tool_use_id"),
        content: serialized || "",
      });
    }
  }

  flushText();
  return result;
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
            const pieces = _convertUserMessageWithInjection(content, pending);
            result.push(...pieces.messages);
            if (pieces.clearedPending) pending = null;
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
    return tools.map((tool) => ({
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

  static convertSystemPrompt(
    system: unknown,
  ): Record<string, string> | null {
    if (typeof system === "string") {
      return { role: "system", content: system };
    }
    if (Array.isArray(system)) {
      const textParts: string[] = [];
      for (const block of system) {
        if (getBlockType(block as ContentBlock) === "text") {
          const text = String(getBlockAttr(block as ContentBlock, "text", "") ?? "");
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
  if (system) {
    const systemMsg = AnthropicToOpenAIConverter.convertSystemPrompt(system);
    if (systemMsg) messages.unshift(systemMsg);
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
  if (tools && tools.length) {
    body.tools = AnthropicToOpenAIConverter.convertTools(tools);
  }

  const toolChoice = requestData.tool_choice;
  if (toolChoice) {
    body.tool_choice = AnthropicToOpenAIConverter.convertToolChoice(toolChoice);
  }

  return body;
}
