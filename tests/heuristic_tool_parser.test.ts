import { describe, it, expect } from "bun:test";
import { HeuristicToolParser } from "../src/parsers/heuristic_tool_parser.js";

describe("HeuristicToolParser", () => {
  it("passes through plain text via flush", () => {
    const parser = new HeuristicToolParser();
    const [text, tools] = parser.feed("Hello, world!");
    // In streaming mode, text without ● is buffered. It comes out on flush.
    expect(tools).toEqual([]);
    const flush = parser.flush();
    expect(flush.text).toBe("Hello, world!");
    expect(flush.tools).toEqual([]);
  });

  it("detects function call with parameters", () => {
    const parser = new HeuristicToolParser();
    const input = '● <function=read_file><parameter=path>/etc/hosts</parameter>';
    const [text, tools] = parser.feed(input);
    // The tool call may still be buffered — flush to finalize
    const flush = parser.flush();
    const allTools = [...tools, ...flush.tools];
    expect(allTools.length).toBe(1);
    expect(allTools[0].name).toBe("read_file");
  });

  it("detects multiple function calls across separate feeds", () => {
    const parser = new HeuristicToolParser();
    const [, tools1] = parser.feed("● <function=read_file><parameter=path>/a</parameter>");
    const [, tools2] = parser.feed("● <function=write_file>");
    const [, tools3] = parser.feed("<parameter=path>/b</parameter><parameter=content>hello</parameter>");
    const [, tools4] = parser.feed(" end");
    const allTools = [...tools1, ...tools2, ...tools3, ...tools4];
    expect(allTools.length).toBe(2);
    expect(allTools[0].name).toBe("read_file");
    expect(allTools[1].name).toBe("write_file");
  });

  it("detects WebFetch JSON call", () => {
    const parser = new HeuristicToolParser();
    const [text, tools] = parser.feed('Use WebFetch {"url": "https://example.com"}');
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe("WebFetch");
    expect((tools[0].input as Record<string, unknown>).url).toBe("https://example.com");
  });

  it("detects WebSearch JSON call", () => {
    const parser = new HeuristicToolParser();
    const [text, tools] = parser.feed('Use WebSearch {"query": "test query"}');
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe("WebSearch");
    expect((tools[0].input as Record<string, unknown>).query).toBe("test query");
  });

  it("strips control tokens", () => {
    const parser = new HeuristicToolParser();
    parser.feed("hello <|special|> world");
    const flush = parser.flush();
    expect(flush.text).toBe("hello  world");
  });

  it("returns empty for empty feed", () => {
    const parser = new HeuristicToolParser();
    const [text, tools] = parser.feed("");
    expect(text).toBe("");
    expect(tools).toEqual([]);
  });

  it("flush returns partial tool calls", () => {
    const parser = new HeuristicToolParser();
    parser.feed('● <function=read_file><parameter=path>/tmp</parameter>');
    const flush = parser.flush();
    expect(flush.tools.length).toBe(1);
    expect(flush.tools[0].name).toBe("read_file");
  });

  it("flush returns empty tools when no pending tool call", () => {
    const parser = new HeuristicToolParser();
    parser.feed("plain text");
    parser.flush();
    const flush2 = parser.flush();
    expect(flush2.tools).toEqual([]);
    expect(flush2.text).toBe("");
  });

  it("ignores WebFetch without url", () => {
    const parser = new HeuristicToolParser();
    const [text, tools] = parser.feed('Use WebFetch {"query": "bad"}');
    expect(tools.length).toBe(0);
  });

  it("ignores WebSearch without query", () => {
    const parser = new HeuristicToolParser();
    const [text, tools] = parser.feed('Use WebSearch {"url": "bad"}');
    expect(tools.length).toBe(0);
  });

  it("emits text before ● and tools after", () => {
    const parser = new HeuristicToolParser();
    const [text, tools] = parser.feed('Hello ● <function=echo><parameter=msg>hi</parameter>');
    // Text before ● should be in feed output
    expect(text).toBe("Hello ");
    // Tool may be in feed or flush
    const allTools = [...tools, ...parser.flush().tools];
    expect(allTools.length).toBe(1);
    expect(allTools[0].name).toBe("echo");
  });
});
