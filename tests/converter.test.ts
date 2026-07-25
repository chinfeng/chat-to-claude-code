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

    it("replays redacted_thinking as placeholder text for multi-turn reasoning chain", () => {
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
      expect(result).toEqual([{ role: "assistant", content: "[redacted thinking]\n\nResponse." }]);
    });

    it("converts user image blocks to image_url format", () => {
      const messages: AnthropicMessage[] = [
        {
          role: "user",
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "YWJj" } }],
        },
      ];
      const result = AnthropicToOpenAIConverter.convertMessages(messages);
      expect(result.length).toBe(1);
      expect(result[0].role).toBe("user");
      const content = result[0].content as Record<string, unknown>[];
      expect(content[0].type).toBe("image_url");
      expect(content[0].image_url).toEqual({ url: "data:image/png;base64,YWJj" });
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

    it("returns null for an empty string (drops empty system, G6)", () => {
      expect(AnthropicToOpenAIConverter.convertSystemPrompt("")).toBeNull();
    });
  });
});

describe("convertSystemPrompt — x-anthropic-billing-header stripping (G6)", () => {
  it("strips a leading billing-header line from a string system prompt", () => {
    const sys = "x-anthropic-billing-header: cch=abc123; cc_version=1;\nYou are helpful.";
    const result = AnthropicToOpenAIConverter.convertSystemPrompt(sys);
    expect(result).toEqual({ role: "system", content: "You are helpful." });
  });

  it("strips the leading billing-header line from each text block in an array system prompt", () => {
    const result = AnthropicToOpenAIConverter.convertSystemPrompt([
      { type: "text", text: "x-anthropic-billing-header: cch=zzz;\nPart A." },
      { type: "text", text: "Part B." },
    ]);
    expect(result).toEqual({ role: "system", content: "Part A.\n\nPart B." });
  });

  it("returns null when the system prompt is ONLY the billing header", () => {
    expect(AnthropicToOpenAIConverter.convertSystemPrompt("x-anthropic-billing-header: cch=rotating;")).toBeNull();
  });

  it("leaves a billing-like string not at offset 0 untouched", () => {
    // Only the FIRST line is stripped when it is the billing header.
    const sys = "You are helpful.\nx-anthropic-billing-header: not at start";
    const result = AnthropicToOpenAIConverter.convertSystemPrompt(sys);
    expect(result).toEqual({ role: "system", content: sys });
  });

  it("handles CRLF after the billing header line", () => {
    const sys = "x-anthropic-billing-header: cch=x;\r\nYou are helpful.";
    const result = AnthropicToOpenAIConverter.convertSystemPrompt(sys);
    expect(result).toEqual({ role: "system", content: "You are helpful." });
  });
});

describe("tool_use arguments canonicalization (G7)", () => {
  it("serializes tool_use input with sorted keys (canonical args)", () => {
    const messages: AnthropicMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "search", input: { z: 1, a: 2, m: 0 } },
        ],
      },
    ];
    const result = AnthropicToOpenAIConverter.convertMessages(messages);
    const msg = result[0];
    const args = (msg.tool_calls as Record<string, unknown>[])[0].function.arguments;
    expect(args).toBe(JSON.stringify({ a: 2, m: 0, z: 1 }));
  });

  it("produces stable arguments regardless of input key order", () => {
    const a = AnthropicToOpenAIConverter.convertMessages([
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "f", input: { b: 2, a: 1 } }] },
    ]);
    const b = AnthropicToOpenAIConverter.convertMessages([
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "f", input: { a: 1, b: 2 } }] },
    ]);
    expect((a[0].tool_calls as Record<string, unknown>[])[0].function.arguments).toBe(
      (b[0].tool_calls as Record<string, unknown>[])[0].function.arguments,
    );
  });
});

describe("tool_result media extraction (G10)", () => {
  it("extracts an image block from tool_result into a synthetic user turn", () => {
    const messages: AnthropicMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "screenshot", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: [
              { type: "text", text: "captured" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "YWJj" } },
            ],
          },
        ],
      },
    ];
    const result = AnthropicToOpenAIConverter.convertMessages(messages);
    // The tool message keeps the text content (image no longer stringified in).
    const toolMsg = result.find((m) => m.role === "tool")!;
    expect(toolMsg.tool_call_id).toBe("tu_1");
    expect(String(toolMsg.content)).toContain("captured");
    expect(String(toolMsg.content)).not.toContain("\"type\":\"image\""); // image not stringified
    expect(String(toolMsg.content)).toContain("[tool result media moved to the following user message]");

    // A synthetic user turn carries the image as an image_url part + the marker.
    const userMsgs = result.filter((m) => m.role === "user");
    const synthetic = userMsgs.find(
      (m) => Array.isArray(m.content) && (m.content as Record<string, unknown>[]).some((p) => p.type === "image_url"),
    );
    expect(synthetic).toBeDefined();
    const parts = synthetic!.content as Record<string, unknown>[];
    expect(parts.some((p) => p.type === "text")).toBe(true); // marker
    const imgPart = parts.find((p) => p.type === "image_url")!;
    const imageUrl = imgPart.image_url as Record<string, unknown>;
    expect(imageUrl.url).toBe("data:image/png;base64,YWJj");
  });

  it("does NOT synthesize a media turn for text-only tool results (no regression)", () => {
    const messages: AnthropicMessage[] = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "plain result" }],
      },
    ];
    const result = AnthropicToOpenAIConverter.convertMessages(messages);
    expect(result).toEqual([{ role: "tool", tool_call_id: "t1", content: "plain result" }]);
    expect(result.some((m) => m.role === "user")).toBe(false);
  });

  it("keeps structured (web_search_result) tool content as textified JSON, unchanged", () => {
    // Regression guard: G10 must not alter the web_search_result tool-content
    // serialization path (it has no image blocks).
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
    expect(result).toEqual([
      {
        role: "tool",
        tool_call_id: "st_1",
        content: '{"type":"web_search_result","url":"https://example.com","title":"Example"}',
      },
    ]);
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

describe("AnthropicToOpenAIConverter.convertTools with server tools", () => {
  it("skips web_search_20250305 type tools from conversion", () => {
    const tools = [
      { type: "web_search_20250305", name: "web_search", max_uses: 8 },
      { type: "custom", name: "read_file", input_schema: { type: "object", properties: { path: { type: "string" } } } },
    ];
    const result = AnthropicToOpenAIConverter.convertTools(tools);
    expect(result.length).toBe(1);
    expect(result[0]).toEqual({
      type: "function",
      function: {
        name: "read_file",
        description: "",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    });
  });

  it("skips web_fetch_20250305 type tools from conversion", () => {
    const tools = [
      { type: "web_fetch_20250305", name: "web_fetch" },
    ];
    const result = AnthropicToOpenAIConverter.convertTools(tools);
    expect(result.length).toBe(0);
  });

  it("converts regular tools normally", () => {
    const tools = [
      { name: "bash", description: "Run a bash command", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
    ];
    const result = AnthropicToOpenAIConverter.convertTools(tools);
    expect(result.length).toBe(1);
    expect(result[0].function.name).toBe("bash");
  });
});

describe("buildBaseRequestBody with server tools", () => {
  it("injects server tool function schemas into tools array", () => {
    const requestData: RequestData = {
      model: "test-model",
      messages: [{ role: "user", content: "search the web" }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
      server_tools: [{ type: "web_search_20250305", name: "web_search" }],
    };
    const body = buildBaseRequestBody(requestData, 4096);
    const tools = body.tools as Record<string, unknown>[];
    expect(tools.length).toBe(1);
    expect(tools[0]).toEqual({
      type: "function",
      function: {
        name: "web_search",
        description: "Search the web for information. Use this tool when you need to find current information, look up facts, or research topics on the internet.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The search query string",
            },
          },
          required: ["query"],
        },
      },
    });
  });

  it("injects server tool usage instructions into system prompt", () => {
    const requestData: RequestData = {
      model: "test-model",
      messages: [{ role: "user", content: "search the web" }],
      system: [{ type: "text", text: "You are a helpful assistant." }],
      server_tools: [{ type: "web_search_20250305", name: "web_search" }],
    };
    const body = buildBaseRequestBody(requestData, 4096);
    const messages = body.messages as Record<string, unknown>[];
    const systemMsg = messages.find((m) => m.role === "system");
    expect(systemMsg).toBeDefined();
    const content = String(systemMsg!.content);
    expect(content).toContain("You are a helpful assistant.");
    expect(content).toContain("web_search");
  });

  it("combines regular tools with server tool schemas", () => {
    const requestData: RequestData = {
      model: "test-model",
      messages: [{ role: "user", content: "test" }],
      tools: [
        { type: "web_search_20250305", name: "web_search", max_uses: 8 },
        { name: "bash", description: "Run command", input_schema: { type: "object", properties: { command: { type: "string" } } } },
      ],
      server_tools: [{ type: "web_search_20250305", name: "web_search" }],
    };
    const body = buildBaseRequestBody(requestData, 4096);
    const tools = body.tools as Record<string, unknown>[];
    expect(tools.length).toBe(2);
  });
});
