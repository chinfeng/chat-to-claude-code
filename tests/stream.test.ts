import { describe, it, expect } from "bun:test";
import { streamOpenAIChatToAnthropicSse } from "../src/transport/stream.js";
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

  it("handles error in upstream stream", async () => {
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

    const output = await collectStream(stream);
    expect(output).toContain("upstream disconnected");
    expect(output).toContain("event: message_stop");
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
});
