import { describe, it, expect } from "bun:test";
import { streamOpenAIChatToAnthropicSse, inferToolNameByIndex } from "../src/transport/stream.js";
import type { StreamChunk } from "../src/transport/stream.js";
import type { RequestData } from "../src/conversion/converter.js";
import { ThinkTagParser } from "../src/parsers/think_tag_parser.js";

const OPEN = ThinkTagParser.OPEN_TAG;
const CLOSE = ThinkTagParser.CLOSE_TAG;

/** Collect all SSE events from a stream into a string. */
async function collectStream(stream: AsyncGenerator<string>): Promise<string> {
  let result = "";
  for await (const chunk of stream) {
    result += chunk;
  }
  return result;
}

/** Create a simple async iterable from an array of chunks. */
async function* chunksToStream(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

const TEST_REQUEST: RequestData = {
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }],
};

describe("streamOpenAIChatToAnthropicSse", () => {
  it("produces a complete Anthropic SSE stream for text content", async () => {
    const chunks: StreamChunk[] = [
      { choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
      { choices: [{ delta: { content: " world" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ];

    const stream = streamOpenAIChatToAnthropicSse(
      chunksToStream(chunks),
      TEST_REQUEST,
      10,
      true,
    );

    const output = await collectStream(stream);
    expect(output).toContain("event: message_start");
    expect(output).toContain("event: content_block_start");
    expect(output).toContain("event: content_block_stop");
    expect(output).toContain("event: message_delta");
    expect(output).toContain("event: message_stop");
    expect(output).toContain("end_turn");
  });

  it("handles reasoning_content for thinking", async () => {
    const chunks: StreamChunk[] = [
      { choices: [{ delta: { reasoning_content: "I think..." }, finish_reason: null }] },
      { choices: [{ delta: { content: "Answer." }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];

    const stream = streamOpenAIChatToAnthropicSse(
      chunksToStream(chunks),
      TEST_REQUEST,
      10,
      true,
    );

    const output = await collectStream(stream);
    expect(output).toContain("I think...");
    expect(output).toContain("Answer.");
    expect(output).toContain("thinking");
  });

  it("skips reasoning when thinking is disabled", async () => {
    const chunks: StreamChunk[] = [
      { choices: [{ delta: { reasoning_content: "hidden" }, finish_reason: null }] },
      { choices: [{ delta: { content: "Visible." }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];

    const stream = streamOpenAIChatToAnthropicSse(
      chunksToStream(chunks),
      TEST_REQUEST,
      10,
      false,
    );

    const output = await collectStream(stream);
    expect(output).not.toContain("hidden");
    expect(output).toContain("Visible.");
  });

  it("handles tool_calls", async () => {
    const chunks: StreamChunk[] = [
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_001",
              function: { name: "read_file", arguments: null },
            }],
          },
          finish_reason: null,
        }],
      },
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: null,
              function: { name: null, arguments: '{"path":"/tmp"}' },
            }],
          },
          finish_reason: null,
        }],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];

    const stream = streamOpenAIChatToAnthropicSse(
      chunksToStream(chunks),
      TEST_REQUEST,
      10,
      true,
    );

    const output = await collectStream(stream);
    expect(output).toContain("tool_use");
    expect(output).toContain("read_file");
    expect(output).toContain("/tmp");
    expect(output).toContain("tool_use"); // stop_reason
  });

  it("handles empty stream with fallback text block", async () => {
    const chunks: StreamChunk[] = [
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];

    const stream = streamOpenAIChatToAnthropicSse(
      chunksToStream(chunks),
      TEST_REQUEST,
      10,
      true,
    );

    const output = await collectStream(stream);
    expect(output).toContain("event: message_start");
    expect(output).toContain("event: message_stop");
  });

  it("rethrows upstream stream error instead of disguising it as assistant text", async () => {
    async function* errorStream(): AsyncIterable<StreamChunk> {
      yield { choices: [{ delta: { content: "partial" }, finish_reason: null }] };
      throw new Error("upstream disconnected");
    }

    const stream = streamOpenAIChatToAnthropicSse(
      errorStream(),
      TEST_REQUEST,
      10,
      true,
    );

    // The converter must surface the failure by rethrowing so the route layer
    // can emit a top-level SSE `event: error` and mark the termination reason.
    // The original bug swallowed the error, wrapped its message in a `text`
    // content block, and signalled `end_turn` + `message_stop` — making the
    // client treat the failure as a completed assistant turn and persist the
    // error string into conversation history.
    await expect(collectStream(stream)).rejects.toThrow("upstream disconnected");
  });

  it("closes any opened content blocks before rethrowing an upstream stream error", async () => {
    async function* errorStream(): AsyncIterable<StreamChunk> {
      // reasoning_content eagerly opens a thinking block (no parser buffering),
      // so we can verify that an opened block is closed before the rethrow.
      yield { choices: [{ delta: { reasoning_content: "thinking..." }, finish_reason: null }] };
      throw new Error("upstream disconnected");
    }

    const stream = streamOpenAIChatToAnthropicSse(
      errorStream(),
      TEST_REQUEST,
      10,
      true,
    );

    let collected = "";
    await expect(async () => {
      try {
        for await (const chunk of stream) collected += chunk;
      } catch {
        // expected rethrow
      }
    }).not.toThrow();

    // A thinking block was opened, so it must be closed before the error
    // propagates — downstream parsers must see a well-formed stream up to the
    // failure point (no dangling open block).
    const starts = (collected.match(/event: content_block_start/g) || []).length;
    const stops = (collected.match(/event: content_block_stop/g) || []).length;
    expect(starts).toBeGreaterThan(0);
    expect(stops).toBeGreaterThanOrEqual(starts);
  });

  it("does not fabricate error-as-text or end_turn when no content arrived before failure", async () => {
    // Error fires before any content delta arrives — no block is open. The
    // converter must surface the failure by rethrowing and must NOT fabricate
    // a text block carrying the error message (the original bug) nor pretend
    // the turn completed with end_turn + message_stop.
    async function* errorStream(): AsyncIterable<StreamChunk> {
      throw new Error("upstream disconnected");
    }

    const stream = streamOpenAIChatToAnthropicSse(
      errorStream(),
      TEST_REQUEST,
      10,
      true,
    );

    let collected = "";
    await expect(async () => {
      try {
        for await (const chunk of stream) collected += chunk;
      } catch {
        // expected rethrow
      }
    }).not.toThrow();

    expect(collected).not.toContain("text_delta");
    expect(collected).not.toContain("upstream disconnected");
    expect(collected).not.toContain("end_turn");
    expect(collected).not.toContain("event: message_stop");
  });

  it("handles think tags in content", async () => {
    const chunks: StreamChunk[] = [
      { choices: [{ delta: { content: `${OPEN}\nmy inner thought\n${CLOSE}public answer` }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];

    const stream = streamOpenAIChatToAnthropicSse(
      chunksToStream(chunks),
      TEST_REQUEST,
      10,
      true,
    );

    const output = await collectStream(stream);
    expect(output).toContain("my inner thought");
  });

  it("emits text before tool_use when upstream sends content with empty tool_calls array then native tool_calls", async () => {
    // Some upstream providers send tool_calls:[] alongside text content, then later
    // send tool_calls with actual entries. The text must appear BEFORE the tool_use
    // block in the Anthropic SSE output, not after.
    const chunks: StreamChunk[] = [
      { choices: [{ delta: { content: "Hello", tool_calls: [] }, finish_reason: null }] },
      { choices: [{ delta: { content: " World", tool_calls: [] }, finish_reason: null }] },
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_001",
              function: { name: "read_file", arguments: '{"path":"/tmp"}' },
            }],
          },
          finish_reason: null,
        }],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];

    const stream = streamOpenAIChatToAnthropicSse(
      chunksToStream(chunks),
      TEST_REQUEST,
      10,
      true,
    );

    const output = await collectStream(stream);

    // Text block must start before tool_use block
    const textBlockStart = output.indexOf('"type":"text"');
    const toolUseBlockStart = output.indexOf('"type":"tool_use"');
    expect(textBlockStart).toBeGreaterThan(-1);
    expect(toolUseBlockStart).toBeGreaterThan(-1);
    expect(textBlockStart).toBeLessThan(toolUseBlockStart);

    // The text content should be present
    expect(output).toContain("Hello World");
    expect(output).toContain("read_file");
  });

  it("ignores empty tool_calls array without text content", async () => {
    // Upstream may send tool_calls:[] without any content — should be silently ignored
    const chunks: StreamChunk[] = [
      { choices: [{ delta: { tool_calls: [] }, finish_reason: null }] },
      { choices: [{ delta: { content: "Just text", tool_calls: [] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];

    const stream = streamOpenAIChatToAnthropicSse(
      chunksToStream(chunks),
      TEST_REQUEST,
      10,
      true,
    );

    const output = await collectStream(stream);
    expect(output).toContain("Just text");
    expect(output).not.toContain("tool_use");
  });

  it("emits WebSearch tool calls as standard tool_use blocks (not server_tool_use)", async () => {
    // When Claude Code sends WebSearch as a regular tool, the proxy must
    // pass it through as a standard tool_use block — not intercept it as
    // a server_tool_use block with empty input.
    const chunks: StreamChunk[] = [
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_ws_001",
              function: { name: "WebSearch", arguments: "" },
            }],
          },
          finish_reason: null,
        }],
      },
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: null,
              function: { name: null, arguments: '{"query":"test search"}' },
            }],
          },
          finish_reason: null,
        }],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];

    const serverToolConfig = { webSearch: true, webFetch: false, webSearchEngine: "brave" as const, webSearchApiKey: "test", webSearchBaseUrl: "https://api.search.brave.com", webFetchAllowedDomains: [], webFetchBlockedDomains: [], webFetchMaxContentTokens: 5000 };

    const stream = streamOpenAIChatToAnthropicSse(
      chunksToStream(chunks),
      TEST_REQUEST,
      10,
      true,
      undefined,
      serverToolConfig,
    );

    const output = await collectStream(stream);

    // Must be tool_use, NOT server_tool_use
    expect(output).toContain('"type":"tool_use"');
    expect(output).not.toContain("server_tool_use");

    // Name must be WebSearch (original), not web_search
    expect(output).toContain("WebSearch");

    // Input must contain the query (streamed via input_json_delta)
    expect(output).toContain("test search");
  });

  it("emits WebFetch tool calls as standard tool_use blocks (not server_tool_use)", async () => {
    // Same as above but for WebFetch
    const chunks: StreamChunk[] = [
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_wf_001",
              function: { name: "WebFetch", arguments: "" },
            }],
          },
          finish_reason: null,
        }],
      },
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: null,
              function: { name: null, arguments: '{"url":"https://example.com","prompt":"summarize"}' },
            }],
          },
          finish_reason: null,
        }],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];

    const serverToolConfig = { webSearch: false, webFetch: true, webSearchEngine: "brave" as const, webSearchApiKey: "", webSearchBaseUrl: "https://api.search.brave.com", webFetchAllowedDomains: [], webFetchBlockedDomains: [], webFetchMaxContentTokens: 5000 };

    const stream = streamOpenAIChatToAnthropicSse(
      chunksToStream(chunks),
      TEST_REQUEST,
      10,
      true,
      undefined,
      serverToolConfig,
    );

    const output = await collectStream(stream);

    expect(output).toContain('"type":"tool_use"');
    expect(output).not.toContain("server_tool_use");
    expect(output).toContain("WebFetch");
    expect(output).toContain("example.com");
  });
  it("skips message_start/message_delta/message_stop when skipMessageLifecycle is set", async () => {
    const chunks: StreamChunk[] = [
      { choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];

    const stream = streamOpenAIChatToAnthropicSse(
      chunksToStream(chunks),
      TEST_REQUEST,
      10,
      true,
      undefined,
      undefined,
      { skipMessageLifecycle: true },
    );

    const output = await collectStream(stream);
    expect(output).not.toContain("event: message_start");
    expect(output).not.toContain("event: message_stop");
    expect(output).not.toContain("event: message_delta");
    expect(output).toContain("event: content_block_start");
    expect(output).toContain("Hello");
  });

  it("uses startingBlockIndex to offset content block indices", async () => {
    const chunks: StreamChunk[] = [
      { choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];

    const stream = streamOpenAIChatToAnthropicSse(
      chunksToStream(chunks),
      TEST_REQUEST,
      10,
      true,
      undefined,
      undefined,
      { skipMessageLifecycle: true, startingBlockIndex: 3 },
    );

    const output = await collectStream(stream);
    // The text block should start at index 3, not 0
    expect(output).toContain('"index":3');
  });

  it("handles tool_calls with missing name and id (GLM-5.1 incomplete tool_calls)", async () => {
    // GLM-5.1 via newapi proxy sometimes returns tool_calls with only
    // index and arguments, missing both id and function.name.
    // When request.tools is available, the proxy should infer the tool
    // name from the tools list (by index) and generate a valid tool_use block.
    const chunks: StreamChunk[] = [
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              // id and function.name are MISSING — this is the bug scenario
              function: { arguments: "{}" },
            }],
          },
          finish_reason: "tool_calls",
        }],
      },
    ];

    const requestWithTools: RequestData = {
      model: "z-ai/glm-5.1",
      messages: [{ role: "user", content: "Hello" }],
      tools: [
        { type: "custom", name: "Read", description: "Read a file", input_schema: { type: "object", properties: {} } },
      ],
    };

    const stream = streamOpenAIChatToAnthropicSse(
      chunksToStream(chunks),
      requestWithTools,
      10,
      true,
    );

    const output = await collectStream(stream);
    // Should produce a valid tool_use block with the inferred name
    expect(output).toContain('"type":"tool_use"');
    expect(output).toContain("Read");
    expect(output).toContain("tool_use"); // stop_reason
  });

  it("gracefully degrades when tool_calls missing name and no tools list available", async () => {
    // When tool_calls has no name and request.tools is not available,
    // the proxy should NOT emit stop_reason: "tool_use" (which would cause
    // Claude Code to fail). Instead, it should degrade to end_turn.
    const chunks: StreamChunk[] = [
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: "{}" },
            }],
          },
          finish_reason: "tool_calls",
        }],
      },
    ];

    const stream = streamOpenAIChatToAnthropicSse(
      chunksToStream(chunks),
      TEST_REQUEST, // no tools
      10,
      true,
    );

    const output = await collectStream(stream);
    // Should NOT have tool_use stop_reason since no tool_use block was emitted
    expect(output).not.toContain('"stop_reason":"tool_use"');
    // Should degrade gracefully to end_turn
    expect(output).toContain("end_turn");
  });

  it("handles tool_calls with missing name but text content present (GLM-5.1 pattern)", async () => {
    // Session 2 from the dump: model outputs text first, then an incomplete tool_call
    const chunks: StreamChunk[] = [
      { choices: [{ delta: { content: "让我", tool_calls: [] }, finish_reason: null }] },
      { choices: [{ delta: { content: "用 Chrome DevTools 截图查看当前页面状态", tool_calls: [] }, finish_reason: null }] },
      { choices: [{ delta: { content: "：", tool_calls: [] }, finish_reason: null }] },
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: "{}" },
            }],
          },
          finish_reason: "tool_calls",
        }],
      },
    ];

    const requestWithTools: RequestData = {
      model: "z-ai/glm-5.1",
      messages: [{ role: "user", content: "Hello" }],
      tools: [
        { type: "custom", name: "chrome-devtools-mcp:chrome-devtools", description: "Chrome DevTools", input_schema: { type: "object", properties: {} } },
      ],
    };

    const stream = streamOpenAIChatToAnthropicSse(
      chunksToStream(chunks),
      requestWithTools,
      10,
      true,
    );

    const output = await collectStream(stream);
    // Text must appear before tool_use
    const textBlockStart = output.indexOf('"type":"text"');
    const toolUseBlockStart = output.indexOf('"type":"tool_use"');
    expect(textBlockStart).toBeGreaterThan(-1);
    expect(toolUseBlockStart).toBeGreaterThan(-1);
    expect(textBlockStart).toBeLessThan(toolUseBlockStart);
    expect(output).toContain("Chrome DevTools");
    expect(output).toContain("chrome-devtools-mcp:chrome-devtools");
  });
});

/** Extract the parsed `message_delta` event data from a raw SSE string. */
function parseMessageDeltaEvent(sse: string): Record<string, unknown> | null {
  const blocks = sse.split("\n\n");
  for (const block of blocks) {
    if (!block.startsWith("event: message_delta")) continue;
    const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
    if (dataLine) {
      try { return JSON.parse(dataLine.slice(6)); } catch { return null; }
    }
  }
  return null;
}

/** Extract the parsed `message_start` event data from a raw SSE string. */
function parseMessageStartEvent(sse: string): Record<string, unknown> | null {
  const blocks = sse.split("\n\n");
  for (const block of blocks) {
    if (!block.startsWith("event: message_start")) continue;
    const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
    if (dataLine) {
      try { return JSON.parse(dataLine.slice(6)); } catch { return null; }
    }
  }
  return null;
}

describe("streamOpenAIChatToAnthropicSse usage accounting (G1+G3+G4)", () => {
  it("reads cache buckets from prompt_tokens_details (G3) into message_delta", async () => {
    // GLM-5.2 / OpenAI surface cache hits in prompt_tokens_details, NOT in the
    // Anthropic-compat direct cache_*_input_tokens fields.
    const chunks: StreamChunk[] = [
      { choices: [{ delta: { content: "hi" }, finish_reason: null }] },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 },
        },
      },
    ];

    const stream = streamOpenAIChatToAnthropicSse(chunksToStream(chunks), TEST_REQUEST, 10, true);
    const output = await collectStream(stream);
    const delta = parseMessageDeltaEvent(output)!;

    // input_tokens = prompt_tokens - cache_read - cache_creation (saturating).
    expect((delta.usage as Record<string, unknown>).input_tokens).toBe(60);
    expect((delta.usage as Record<string, unknown>).cache_read_input_tokens).toBe(30);
    expect((delta.usage as Record<string, unknown>).cache_creation_input_tokens).toBe(10);
    expect((delta.usage as Record<string, unknown>).output_tokens).toBe(5);
  });

  it("prefers the Anthropic-compat direct cache fields over prompt_tokens_details", async () => {
    const chunks: StreamChunk[] = [
      { choices: [{ delta: { content: "hi" }, finish_reason: null }] },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          cache_read_input_tokens: 40, // direct takes priority
          cache_creation_input_tokens: 20,
          prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 },
        },
      },
    ];

    const output = await collectStream(
      streamOpenAIChatToAnthropicSse(chunksToStream(chunks), TEST_REQUEST, 10, true),
    );
    const delta = parseMessageDeltaEvent(output)!;
    // Direct fields win: 100 - 40 - 20 = 40 input_tokens.
    expect((delta.usage as Record<string, unknown>).input_tokens).toBe(40);
    expect((delta.usage as Record<string, unknown>).cache_read_input_tokens).toBe(40);
    expect((delta.usage as Record<string, unknown>).cache_creation_input_tokens).toBe(20);
  });

  it("reports real input_tokens in message_delta (G4) instead of the estimate", async () => {
    const chunks: StreamChunk[] = [
      { choices: [{ delta: { content: "hi" }, finish_reason: null }] },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1234, completion_tokens: 7 },
      },
    ];

    // inputTokens estimate is 10 — message_delta must report the REAL 1234,
    // not the estimate.
    const output = await collectStream(
      streamOpenAIChatToAnthropicSse(chunksToStream(chunks), TEST_REQUEST, 10, true),
    );
    const delta = parseMessageDeltaEvent(output)!;
    expect((delta.usage as Record<string, unknown>).input_tokens).toBe(1234);
    expect((delta.usage as Record<string, unknown>).output_tokens).toBe(7);

    // message_start is emitted BEFORE the usage chunk, so it still uses the
    // estimate (no usage has arrived yet) — unchanged from prior behavior.
    const start = parseMessageStartEvent(output)!;
    const startUsage = (start.message as Record<string, unknown>).usage as Record<string, unknown>;
    expect(startUsage.input_tokens).toBe(10);
  });

  it("saturates input_tokens to 0 when cache buckets exceed prompt_tokens (clamp)", async () => {
    const chunks: StreamChunk[] = [
      { choices: [{ delta: { content: "hi" }, finish_reason: null }] },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 100 } },
      },
    ];

    const output = await collectStream(
      streamOpenAIChatToAnthropicSse(chunksToStream(chunks), TEST_REQUEST, 10, true),
    );
    const delta = parseMessageDeltaEvent(output)!;
    expect((delta.usage as Record<string, unknown>).input_tokens).toBe(0);
  });

  it("falls back to the inputTokens estimate when no usage chunk arrives", async () => {
    // No usage (e.g. upstream ignored include_usage) — message_delta must use
    // the constructor estimate, preserving prior behavior.
    const chunks: StreamChunk[] = [
      { choices: [{ delta: { content: "hi" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];

    const output = await collectStream(
      streamOpenAIChatToAnthropicSse(chunksToStream(chunks), TEST_REQUEST, 42, true),
    );
    const delta = parseMessageDeltaEvent(output)!;
    expect((delta.usage as Record<string, unknown>).input_tokens).toBe(42);
  });
});

describe("inferToolNameByIndex", () => {
  const baseRequest: RequestData = {
    model: "z-ai/glm-5.1",
    messages: [{ role: "user", content: "Hello" }],
  };

  it("returns tool name from tools list by index", () => {
    const request: RequestData = {
      ...baseRequest,
      tools: [
        { type: "custom", name: "Read", description: "Read a file", input_schema: { type: "object", properties: {} } },
        { type: "custom", name: "Write", description: "Write a file", input_schema: { type: "object", properties: {} } },
      ],
    };
    expect(inferToolNameByIndex(request, 0)).toBe("Read");
    expect(inferToolNameByIndex(request, 1)).toBe("Write");
  });

  it("returns null when toolIndex is out of bounds", () => {
    const request: RequestData = {
      ...baseRequest,
      tools: [
        { type: "custom", name: "Read", description: "Read a file", input_schema: { type: "object", properties: {} } },
      ],
    };
    expect(inferToolNameByIndex(request, 1)).toBeNull();
    expect(inferToolNameByIndex(request, 99)).toBeNull();
  });

  it("returns null when tools list is empty or missing", () => {
    expect(inferToolNameByIndex(baseRequest, 0)).toBeNull();
    expect(inferToolNameByIndex({ ...baseRequest, tools: [] }, 0)).toBeNull();
  });

  it("returns null when tool name is empty or not a string", () => {
    const request: RequestData = {
      ...baseRequest,
      tools: [
        { type: "custom", name: "", description: "Empty name", input_schema: { type: "object", properties: {} } },
        { type: "custom", name: 42 as unknown as string, description: "Number name", input_schema: { type: "object", properties: {} } },
      ],
    };
    expect(inferToolNameByIndex(request, 0)).toBeNull();
    expect(inferToolNameByIndex(request, 1)).toBeNull();
  });
});
