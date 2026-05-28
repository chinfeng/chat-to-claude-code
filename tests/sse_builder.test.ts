import { describe, it, expect } from "bun:test";
import { SSEBuilder, ContentBlockManager, formatSseEvent, mapStopReason } from "../src/sse/builder.js";

describe("formatSseEvent", () => {
  it("formats a proper SSE event string", () => {
    const result = formatSseEvent("message_start", { type: "message_start", message: {} });
    expect(result).toContain("event: message_start\n");
    expect(result).toContain("data: ");
    expect(result.endsWith("\n\n")).toBe(true);
  });
});

describe("mapStopReason", () => {
  it("maps OpenAI stop reasons to Anthropic equivalents", () => {
    expect(mapStopReason("stop")).toBe("end_turn");
    expect(mapStopReason("length")).toBe("max_tokens");
    expect(mapStopReason("tool_calls")).toBe("tool_use");
    expect(mapStopReason("content_filter")).toBe("end_turn");
  });

  it("defaults to end_turn for unknown reasons", () => {
    expect(mapStopReason("unknown")).toBe("end_turn");
    expect(mapStopReason(null)).toBe("end_turn");
    expect(mapStopReason(undefined)).toBe("end_turn");
  });
});

describe("ContentBlockManager", () => {
  it("allocates sequential indices", () => {
    const mgr = new ContentBlockManager();
    expect(mgr.allocateIndex()).toBe(0);
    expect(mgr.allocateIndex()).toBe(1);
    expect(mgr.allocateIndex()).toBe(2);
  });

  it("tracks tool state by index", () => {
    const mgr = new ContentBlockManager();
    const state = mgr.ensureToolState(0);
    expect(state).toBeDefined();
    mgr.setStreamToolId(0, "tool_123");
    expect(mgr.toolStates.get(0)!.toolId).toBe("tool_123");
  });

  it("registers tool name progressively", () => {
    const mgr = new ContentBlockManager();
    mgr.registerToolName(0, "read");
    mgr.registerToolName(0, "read_file");
    expect(mgr.toolStates.get(0)!.name).toBe("read_file");
  });
});

describe("SSEBuilder", () => {
  it("produces message_start event", () => {
    const sse = new SSEBuilder("msg_test", "gpt-4o", 10);
    const event = sse.message_start();
    expect(event).toContain("event: message_start");
    const parsed = JSON.parse(event.split("data: ")[1].trim());
    expect(parsed.message.id).toBe("msg_test");
    expect(parsed.message.model).toBe("gpt-4o");
    expect(parsed.message.usage.input_tokens).toBe(10);
  });

  it("produces message_delta and message_stop events", () => {
    const sse = new SSEBuilder("msg_test", "gpt-4o", 10);
    const delta = sse.message_delta("end_turn", 50);
    expect(delta).toContain("event: message_delta");
    const parsed = JSON.parse(delta.split("data: ")[1].trim());
    expect(parsed.delta.stop_reason).toBe("end_turn");

    const stop = sse.message_stop();
    expect(stop).toContain("event: message_stop");
  });

  it("manages thinking block lifecycle", () => {
    const sse = new SSEBuilder("msg_test", "gpt-4o", 10);
    const events: string[] = [];
    for (const e of sse.ensure_thinking_block()) events.push(e);
    const start = events[0];
    expect(start).toContain("content_block_start");
    expect(start).toContain("thinking");

    const delta = sse.emit_thinking_delta("hmm...");
    expect(delta).toContain("thinking_delta");
    expect(delta).toContain("hmm...");

    const stop = sse.stop_thinking_block();
    expect(stop).toContain("content_block_stop");
  });

  it("manages text block lifecycle", () => {
    const sse = new SSEBuilder("msg_test", "gpt-4o", 10);
    const events: string[] = [];
    for (const e of sse.ensure_text_block()) events.push(e);
    expect(events[0]).toContain("content_block_start");
    expect(events[0]).toContain("text");

    const delta = sse.emit_text_delta("Hello");
    expect(delta).toContain("text_delta");

    const stop = sse.stop_text_block();
    expect(stop).toContain("content_block_stop");
  });

  it("manages tool block lifecycle", () => {
    const sse = new SSEBuilder("msg_test", "gpt-4o", 10);
    const start = sse.start_tool_block(0, "tool_001", "read_file");
    expect(start).toContain("tool_use");

    const delta = sse.emit_tool_delta(0, '{"path":');
    expect(delta).toContain("input_json_delta");

    const stop = sse.stop_tool_block(0);
    expect(stop).toContain("content_block_stop");
  });

  it("handles ensure_thinking_block switching from text", () => {
    const sse = new SSEBuilder("msg_test", "gpt-4o", 10);
    const events: string[] = [];
    for (const e of sse.ensure_text_block()) events.push(e);
    events.length = 0;
    // should stop text, then start thinking
    for (const e of sse.ensure_thinking_block()) events.push(e);
    expect(events.length).toBe(2); // stop text + start thinking
  });

  it("accumulates text and reasoning", () => {
    const sse = new SSEBuilder("msg_test", "gpt-4o", 10);
    for (const _ of sse.ensure_text_block()) {}
    sse.emit_text_delta("Hello ");
    sse.emit_text_delta("world");
    for (const _ of sse.ensure_thinking_block()) {}
    sse.emit_thinking_delta("hmm");
    expect(sse.accumulated_text).toBe("Hello world");
    expect(sse.accumulated_reasoning).toBe("hmm");
  });

  it("estimates output tokens", () => {
    const sse = new SSEBuilder("msg_test", "gpt-4o", 10);
    for (const _ of sse.ensure_text_block()) {}
    sse.emit_text_delta("a".repeat(100));
    const tokens = sse.estimate_output_tokens();
    expect(tokens).toBeGreaterThan(0);
  });

  it("emit_error produces text block with error message", () => {
    const sse = new SSEBuilder("msg_test", "gpt-4o", 10);
    const events: string[] = [];
    for (const e of sse.emit_error("Something broke")) events.push(e);
    expect(events.length).toBe(3); // start + delta + stop
    expect(events[1]).toContain("Something broke");
  });

  it("emit_top_level_error produces error event", () => {
    const sse = new SSEBuilder("msg_test", "gpt-4o", 10);
    const event = sse.emit_top_level_error("Fatal");
    expect(event).toContain("event: error");
    expect(event).toContain("Fatal");
  });

  it("emit_server_tool_use produces server_tool_use block", () => {
    const sse = new SSEBuilder("msg_test", "gpt-4o", 10);
    const events = [...sse.emit_server_tool_use("st_001", "web_search", { query: "test" })];
    expect(events.length).toBe(2); // block_start + block_stop
    const startEvent = events[0];
    expect(startEvent).toContain("event: content_block_start");
    expect(startEvent).toContain("server_tool_use");
    const data = JSON.parse(startEvent.split("data: ")[1]);
    expect(data.content_block.name).toBe("web_search");
    expect(data.content_block.id).toBe("st_001");
    expect(data.content_block.input.query).toBe("test");
  });

  it("emit_web_search_tool_result produces web_search_tool_result block", () => {
    const sse = new SSEBuilder("msg_test", "gpt-4o", 10);
    const content = [{ type: "web_search_result", url: "https://example.com", title: "Example" }];
    const events = [...sse.emit_web_search_tool_result("st_001", content)];
    expect(events.length).toBe(2);
    const startEvent = events[0];
    expect(startEvent).toContain("web_search_tool_result");
    const data = JSON.parse(startEvent.split("data: ")[1]);
    expect(data.content_block.type).toBe("web_search_tool_result");
    expect(data.content_block.tool_use_id).toBe("st_001");
  });

  it("emit_web_search_tool_result includes error status when provided", () => {
    const sse = new SSEBuilder("msg_test", "gpt-4o", 10);
    const content = [{ type: "web_search_result", url: "https://example.com", title: "Error" }];
    const events = [...sse.emit_web_search_tool_result("st_001", content, "error")];
    const startEvent = events[0];
    const data = JSON.parse(startEvent.split("data: ")[1]);
    expect(data.content_block.status).toBe("error");
  });

  it("emit_web_fetch_tool_result produces web_fetch_tool_result block", () => {
    const sse = new SSEBuilder("msg_test", "gpt-4o", 10);
    const content = [{ type: "text", text: "Fetched content" }];
    const events = [...sse.emit_web_fetch_tool_result("st_002", content)];
    expect(events.length).toBe(2);
    const startEvent = events[0];
    expect(startEvent).toContain("web_fetch_tool_result");
    const data = JSON.parse(startEvent.split("data: ")[1]);
    expect(data.content_block.type).toBe("web_fetch_tool_result");
    expect(data.content_block.tool_use_id).toBe("st_002");
  });

  it("emit_web_fetch_tool_result includes error status for failed fetches", () => {
    const sse = new SSEBuilder("msg_test", "gpt-4o", 10);
    const content = [{ type: "text", text: "Domain blocked" }];
    const events = [...sse.emit_web_fetch_tool_result("st_003", content, "error")];
    const startEvent = events[0];
    const data = JSON.parse(startEvent.split("data: ")[1]);
    expect(data.content_block.status).toBe("error");
  });

  it("content_block_start formats server_tool_use correctly", () => {
    const sse = new SSEBuilder("msg_test", "gpt-4o", 10);
    const event = sse.content_block_start(5, "server_tool_use", {
      id: "st_100",
      name: "web_search",
      input: { query: "hello" },
    });
    const data = JSON.parse(event.split("data: ")[1]);
    expect(data.index).toBe(5);
    expect(data.content_block.type).toBe("server_tool_use");
    expect(data.content_block.id).toBe("st_100");
    expect(data.content_block.name).toBe("web_search");
    expect(data.content_block.input.query).toBe("hello");
  });

  it("content_block_start formats web_search_tool_result correctly", () => {
    const sse = new SSEBuilder("msg_test", "gpt-4o", 10);
    const content = [{ type: "web_search_result", url: "https://x.com" }];
    const event = sse.content_block_start(6, "web_search_tool_result", {
      tool_use_id: "st_200",
      content,
    });
    const data = JSON.parse(event.split("data: ")[1]);
    expect(data.content_block.type).toBe("web_search_tool_result");
    expect(data.content_block.tool_use_id).toBe("st_200");
    expect(data.content_block.content).toEqual(content);
  });

  it("content_block_start formats web_fetch_tool_result correctly", () => {
    const sse = new SSEBuilder("msg_test", "gpt-4o", 10);
    const content = [{ type: "text", text: "data" }];
    const event = sse.content_block_start(7, "web_fetch_tool_result", {
      tool_use_id: "st_300",
      content,
      status: "error",
    });
    const data = JSON.parse(event.split("data: ")[1]);
    expect(data.content_block.type).toBe("web_fetch_tool_result");
    expect(data.content_block.tool_use_id).toBe("st_300");
    expect(data.content_block.status).toBe("error");
  });
});
