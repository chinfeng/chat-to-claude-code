import { describe, it, expect } from "bun:test";
import { AnthropicToOpenAIConverter, buildBaseRequestBody, ReasoningReplayMode, OpenAIConversionError } from "../src/conversion/converter.js";
import type { AnthropicMessage, RequestData } from "../src/conversion/converter.js";

describe("AnthropicToOpenAIConverter", () => {
  describe("convertMessages", () => {
    it("converts a simple user message", () => {
      const messages: AnthropicMessage[] = [
        { role: "user", content: "Hello" },
      ];
      const result = AnthropicToOpenAIConverter.convertMessages(messages);
      expect(result).toEqual([{ role: "user", content: "Hello" }]);
    });

    it("converts user message with content blocks", () => {
      const messages: AnthropicMessage[] = [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ];
      const result = AnthropicToOpenAIConverter.convertMessages(messages);
      expect(result).toEqual([{ role: "user", content: "Hello" }]);
    });

    it("converts assistant message with text", () => {
      const messages: AnthropicMessage[] = [
        { role: "assistant", content: "Hi there" },
      ];
      const result = AnthropicToOpenAIConverter.convertMessages(messages);
      expect(result).toEqual([{ role: "assistant", content: "Hi there" }]);
    });

    it("converts assistant message with thinking blocks (THINK_TAGS)", () => {
      const messages: AnthropicMessage[] = [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me think..." },
            { type: "text", text: "Here is the answer." },
          ],
        },
      ];
      const result = AnthropicToOpenAIConverter.convertMessages(messages, ReasoningReplayMode.THINK_TAGS);
      expect(result.length).toBe(1);
      expect(result[0].role).toBe("assistant");
      const content = result[0].content as string;
      expect(content).toContain("Let me think...");
      expect(content).toContain("Here is the answer.");
      expect(content).toContain("\nLet me think...\n");
    });

    it("skips thinking blocks when DISABLED", () => {
      const messages: AnthropicMessage[] = [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Internal thought" },
            { type: "text", text: "Public answer." },
          ],
        },
      ];
      const result = AnthropicToOpenAIConverter.convertMessages(messages, ReasoningReplayMode.DISABLED);
      expect(result).toEqual([{ role: "assistant", content: "Public answer." }]);
    });

    it("uses reasoning_content with REASONING_CONTENT mode", () => {
      const messages: AnthropicMessage[] = [
        {
          role: "assistant",
          content: "Answer.",
          reasoning_content: "My reasoning",
        },
      ];
      const result = AnthropicToOpenAIConverter.convertMessages(messages, ReasoningReplayMode.REASONING_CONTENT);
      expect(result.length).toBe(1);
      expect(result[0].reasoning_content).toBe("My reasoning");
      expect(result[0].content).toBe("Answer.");
    });

    it("converts tool_use blocks to tool_calls", () => {
      const messages: AnthropicMessage[] = [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me look that up." },
            { type: "tool_use", id: "tool_001", name: "search", input: { query: "test" } },
          ],
        },
      ];
      const result = AnthropicToOpenAIConverter.convertMessages(messages);
      expect(result.length).toBe(1);
      const msg = result[0];
      expect(msg.role).toBe("assistant");
      expect(msg.tool_calls).toBeDefined();
      const calls = msg.tool_calls as Record<string, unknown>[];
      expect(calls.length).toBe(1);
      expect(calls[0].id).toBe("tool_001");
      expect(calls[0].function.name).toBe("search");
    });

    it("converts tool_result blocks to tool messages", () => {
      const messages: AnthropicMessage[] = [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tool_001", content: "result data" },
          ],
        },
      ];
      const result = AnthropicToOpenAIConverter.convertMessages(messages);
      expect(result).toEqual([{ role: "tool", tool_call_id: "tool_001", content: "result data" }]);
    });

    it("handles tool_result with array content", () => {
      const messages: AnthropicMessage[] = [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_001",
              content: [{ type: "text", text: "line 1" }, { type: "text", text: "line 2" }],
            },
          ],
        },
      ];
      const result = AnthropicToOpenAIConverter.convertMessages(messages);
      expect(result).toEqual([{ role: "tool", tool_call_id: "tool_001", content: "line 1\nline 2" }]);
    });

    it("handles deferred post-tool blocks", () => {
      const messages: AnthropicMessage[] = [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tool_001", name: "read", input: { path: "/a" } },
            { type: "text", text: "Now I can explain." },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tool_001", content: "file content" },
          ],
        },
      ];
      const result = AnthropicToOpenAIConverter.convertMessages(messages);
      const hasExplanation = result.some(
        (m) => m.role === "assistant" && typeof m.content === "string" && m.content.includes("Now I can explain."),
      );
      expect(hasExplanation).toBe(true);
    });

    it("skips redacted_thinking blocks", () => {
      const messages: AnthropicMessage[] = [
        {
          role: "assistant",
          content: [
            { type: "redacted_thinking", data: "..." },
            { type: "text", text: "Response." },
          ],
        },
      ];
      const result = AnthropicToOpenAIConverter.convertMessages(messages, ReasoningReplayMode.THINK_TAGS);
      expect(result).toEqual([{ role: "assistant", content: "Response." }]);
    });

    it("throws for image blocks in user message", () => {
      const messages: AnthropicMessage[] = [
        {
          role: "user",
          content: [{ type: "image", source: { type: "base64" } }],
        },
      ];
      expect(() => AnthropicToOpenAIConverter.convertMessages(messages)).toThrow(OpenAIConversionError);
    });

    it("handles server_tool_use blocks by skipping them (proxy-side only)", () => {
      const messages: AnthropicMessage[] = [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me search for that." },
            { type: "server_tool_use", id: "st_1", name: "web_search", input: { query: "test" } },
          ],
        },
      ];
      const result = AnthropicToOpenAIConverter.convertMessages(messages);
      expect(result.length).toBe(1);
      expect(result[0].role).toBe("assistant");
      const content = result[0].content as string;
      expect(content).toContain("Let me search for that.");
    });

    it("converts web_search_tool_result blocks as tool results", () => {
      const messages: AnthropicMessage[] = [
        {
          role: "user",
          content: [
            {
              type: "web_search_tool_result",
              tool_use_id: "st_1",
              content: [{ type: "web_search_result", url: "https://example.com", title: "Example" }],
            },
          ],
        },
      ];
      const result = AnthropicToOpenAIConverter.convertMessages(messages);
      expect(result).toEqual([{ role: "tool", tool_call_id: "st_1", content: '{"type":"web_search_result","url":"https://example.com","title":"Example"}' }]);
    });

    it("converts web_fetch_tool_result blocks as tool results", () => {
      const messages: AnthropicMessage[] = [
        {
          role: "user",
          content: [
            {
              type: "web_fetch_tool_result",
              tool_use_id: "st_2",
              content: [{ type: "text", text: "Page content here" }],
            },
          ],
        },
      ];
      const result = AnthropicToOpenAIConverter.convertMessages(messages);
      expect(result).toEqual([{ role: "tool", tool_call_id: "st_2", content: "Page content here" }]);
    });
  });

  describe("convertTools", () => {
    it("converts Anthropic tools to OpenAI function format", () => {
      const tools = [
        {
          name: "read_file",
          description: "Read a file",
          input_schema: { type: "object", properties: { path: { type: "string" } } },
        },
      ];
      const result = AnthropicToOpenAIConverter.convertTools(tools);
      expect(result).toEqual([
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ]);
    });

    it("provides default schema when input_schema is missing", () => {
      const tools = [{ name: "noop", description: "Does nothing" }];
      const result = AnthropicToOpenAIConverter.convertTools(tools);
      expect(result[0].function.parameters).toEqual({ type: "object", properties: {} });
    });
  });

  describe("convertToolChoice", () => {
    it("converts 'any' to 'required'", () => {
      expect(AnthropicToOpenAIConverter.convertToolChoice({ type: "any" })).toEqual("required");
    });

    it("converts 'tool' choice to function format", () => {
      expect(AnthropicToOpenAIConverter.convertToolChoice({ type: "tool", name: "search" })).toEqual({
        type: "function",
        function: { name: "search" },
      });
    });

    it("passes through 'auto' and 'none'", () => {
      expect(AnthropicToOpenAIConverter.convertToolChoice("auto")).toBe("auto");
      expect(AnthropicToOpenAIConverter.convertToolChoice("none")).toBe("none");
    });
  });

  describe("convertSystemPrompt", () => {
    it("converts string system prompt", () => {
      const result = AnthropicToOpenAIConverter.convertSystemPrompt("You are helpful.");
      expect(result).toEqual({ role: "system", content: "You are helpful." });
    });

    it("converts array system prompt", () => {
      const result = AnthropicToOpenAIConverter.convertSystemPrompt([
        { type: "text", text: "Part 1." },
        { type: "text", text: "Part 2." },
      ]);
      expect(result).toEqual({ role: "system", content: "Part 1.\n\nPart 2." });
    });

    it("returns null for null input", () => {
      expect(AnthropicToOpenAIConverter.convertSystemPrompt(null)).toBeNull();
    });

    it("returns object with empty content for empty string", () => {
      const result = AnthropicToOpenAIConverter.convertSystemPrompt("");
      expect(result).toEqual({ role: "system", content: "" });
    });
  });
});

describe("buildBaseRequestBody", () => {
  it("builds a complete request body", () => {
    const req: RequestData = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
      system: "You are helpful.",
      max_tokens: 1024,
      temperature: 0.7,
      tools: [{ name: "read", description: "Read file", input_schema: { type: "object", properties: {} } }],
      tool_choice: { type: "auto" },
    };
    const body = buildBaseRequestBody(req) as Record<string, unknown>;
    expect(body.model).toBe("gpt-4o");
    expect(body.max_tokens).toBe(1024);
    expect(body.temperature).toBe(0.7);
    expect(body.messages).toBeDefined();
    expect((body.messages as unknown[]).length).toBe(2); // system + user
  });

  it("uses default max_tokens when not provided", () => {
    const req: RequestData = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
    };
    const body = buildBaseRequestBody(req, 4096) as Record<string, unknown>;
    expect(body.max_tokens).toBe(4096);
  });

  it("omits max_tokens when null", () => {
    const req: RequestData = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: null,
    };
    const body = buildBaseRequestBody(req) as Record<string, unknown>;
    expect("max_tokens" in body).toBe(false);
  });
});
