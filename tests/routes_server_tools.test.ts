import { describe, it, expect } from "bun:test";
import {
  isServerToolCall,
  collectToolCallArguments,
  executeServerToolCall,
} from "../src/server/routes.js";
import type { ServerToolConfig } from "../src/server/config.js";
import type { StreamChunk } from "../src/transport/stream.js";

const TEST_SERVER_TOOL_CONFIG: ServerToolConfig = {
  webSearch: true,
  webFetch: true,
  webSearchEngine: "brave",
  webSearchApiKey: "",
  webSearchBaseUrl: "https://api.search.brave.com",
  webFetchAllowedDomains: [],
  webFetchBlockedDomains: [],
  webFetchMaxContentTokens: 5000,
};

async function* chunksToStream(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  for (const chunk of chunks) yield chunk;
}

describe("isServerToolCall", () => {
  it("detects web_search tool call when enabled", () => {
    expect(isServerToolCall("web_search", TEST_SERVER_TOOL_CONFIG)).toBe(true);
  });

  it("detects web_fetch tool call when enabled", () => {
    expect(isServerToolCall("web_fetch", TEST_SERVER_TOOL_CONFIG)).toBe(true);
  });

  it("returns false when tool is disabled", () => {
    const disabled: ServerToolConfig = { ...TEST_SERVER_TOOL_CONFIG, webSearch: false, webFetch: false };
    expect(isServerToolCall("web_search", disabled)).toBe(false);
    expect(isServerToolCall("web_fetch", disabled)).toBe(false);
  });

  it("returns false for non-server tool names", () => {
    expect(isServerToolCall("bash", TEST_SERVER_TOOL_CONFIG)).toBe(false);
    expect(isServerToolCall("read_file", TEST_SERVER_TOOL_CONFIG)).toBe(false);
  });
});

describe("collectToolCallArguments", () => {
  it("collects tool call info from upstream chunks", async () => {
    const chunks: StreamChunk[] = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "web_search", arguments: "" } }] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: null, arguments: '{"query":"test"}' } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];

    const result = await collectToolCallArguments(chunksToStream(chunks));
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("web_search");
    expect(result.toolCalls[0].id).toBe("call_1");
    expect(result.toolCalls[0].arguments).toBe('{"query":"test"}');
    expect(result.finishReason).toBe("tool_calls");
    expect(result.hasServerToolCall).toBe(true);
  });

  it("returns empty when no tool calls", async () => {
    const chunks: StreamChunk[] = [
      { choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];

    const result = await collectToolCallArguments(chunksToStream(chunks));
    expect(result.toolCalls).toHaveLength(0);
    expect(result.hasServerToolCall).toBe(false);
    expect(result.textContent).toBe("Hello");
  });

  it("correctly buffers streaming tool call arguments", async () => {
    const chunks: StreamChunk[] = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "tc_1", function: { name: "web_search", arguments: "" } }] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: null, arguments: '{"qu' } }] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: null, arguments: 'ery":"test"}' } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];

    const result = await collectToolCallArguments(chunksToStream(chunks));
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("web_search");
    expect(result.toolCalls[0].arguments).toBe('{"query":"test"}');
    expect(result.hasServerToolCall).toBe(true);
    expect(result.finishReason).toBe("tool_calls");
  });

  it("handles multiple tool calls", async () => {
    const chunks: StreamChunk[] = [
      { choices: [{ delta: { tool_calls: [
        { index: 0, id: "tc_1", function: { name: "web_search", arguments: '{"query":"a"}' } },
        { index: 1, id: "tc_2", function: { name: "web_fetch", arguments: '{"url":"http' } },
      ] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { name: null, arguments: 's://x.com"}' } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];

    const result = await collectToolCallArguments(chunksToStream(chunks));
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].name).toBe("web_search");
    expect(result.toolCalls[1].name).toBe("web_fetch");
    expect(result.toolCalls[1].arguments).toBe('{"url":"https://x.com"}');
  });

  it("returns textContent when no tool calls", async () => {
    const chunks: StreamChunk[] = [
      { choices: [{ delta: { content: "Here is " }, finish_reason: null }] },
      { choices: [{ delta: { content: "the answer." }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];

    const result = await collectToolCallArguments(chunksToStream(chunks));
    expect(result.toolCalls).toHaveLength(0);
    expect(result.hasServerToolCall).toBe(false);
    expect(result.textContent).toBe("Here is the answer.");
    expect(result.finishReason).toBe("stop");
  });
});

describe("executeServerToolCall", () => {
  it("executes web_search and returns formatted result (no API key = empty results)", async () => {
    const result = await executeServerToolCall(
      "web_search",
      '{"query":"test"}',
      TEST_SERVER_TOOL_CONFIG,
    );
    expect(result).toBeDefined();
    expect(result.role).toBe("tool");
    expect(result.tool_call_id).toBeDefined();
  });

  it("executes web_fetch and returns formatted result", async () => {
    const result = await executeServerToolCall(
      "web_fetch",
      '{"url":"https://example.invalid/test"}',
      TEST_SERVER_TOOL_CONFIG,
    );
    expect(result).toBeDefined();
    expect(result.role).toBe("tool");
  });

  it("returns error for unknown tool name", async () => {
    const result = await executeServerToolCall(
      "unknown_tool",
      '{}',
      TEST_SERVER_TOOL_CONFIG,
    );
    expect(result).toBeDefined();
    expect(result.role).toBe("tool");
    expect(String(result.content)).toContain("Unknown server tool");
  });
});
