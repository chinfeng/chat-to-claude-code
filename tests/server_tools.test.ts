import { describe, it, expect } from "bun:test";
import {
  requestHasWebSearch,
  requestHasWebFetch,
  isServerToolUseCall,
  formatWebSearchResultContent,
  formatWebFetchResultContent,
  detectServerToolInText,
  stripToolUseFromText,
  buildServerToolFunctionSchema,
  buildServerToolSystemPromptSuffix,
  isServerToolType,
} from "../src/server/server_tools.js";

describe("requestHasWebSearch", () => {
  it("returns false for null/undefined/empty", () => {
    expect(requestHasWebSearch(null)).toBe(false);
    expect(requestHasWebSearch(undefined)).toBe(false);
    expect(requestHasWebSearch([])).toBe(false);
  });

  it("detects web_search type", () => {
    expect(requestHasWebSearch([{ type: "web_search" }])).toBe(true);
  });

  it("detects versioned web_search types", () => {
    expect(requestHasWebSearch([{ type: "web_search_20250305" }])).toBe(true);
    expect(requestHasWebSearch([{ type: "web_search_20241022" }])).toBe(true);
  });

  it("returns false for unrelated server tools", () => {
    expect(requestHasWebSearch([{ type: "web_fetch" }])).toBe(false);
  });
});

describe("requestHasWebFetch", () => {
  it("returns false for null/undefined/empty", () => {
    expect(requestHasWebFetch(null)).toBe(false);
    expect(requestHasWebFetch(undefined)).toBe(false);
    expect(requestHasWebFetch([])).toBe(false);
  });

  it("detects web_fetch type", () => {
    expect(requestHasWebFetch([{ type: "web_fetch" }])).toBe(true);
  });

  it("detects versioned web_fetch types", () => {
    expect(requestHasWebFetch([{ type: "web_fetch_20250305" }])).toBe(true);
  });

  it("returns false for unrelated server tools", () => {
    expect(requestHasWebFetch([{ type: "web_search" }])).toBe(false);
  });
});

describe("isServerToolUseCall", () => {
  it("returns true for web_search", () => {
    expect(isServerToolUseCall("web_search")).toBe(true);
  });

  it("returns true for web_fetch", () => {
    expect(isServerToolUseCall("web_fetch")).toBe(true);
  });

  it("returns false for other names", () => {
    expect(isServerToolUseCall("WebSearch")).toBe(false);
    expect(isServerToolUseCall("read_file")).toBe(false);
    expect(isServerToolUseCall("")).toBe(false);
    expect(isServerToolUseCall("random")).toBe(false);
  });
});

describe("formatWebSearchResultContent", () => {
  it("formats search results as content blocks", () => {
    const results = [
      { url: "https://example.com", title: "Example", snippet: "A great example" },
    ];
    const blocks = formatWebSearchResultContent(results);
    expect(blocks).toEqual([
      { type: "web_search_result", url: "https://example.com", title: "Example", snippet: "A great example" },
    ]);
  });

  it("omits optional fields when not present", () => {
    const results = [{ url: "https://example.com", title: "Example" }];
    const blocks = formatWebSearchResultContent(results);
    expect(blocks).toEqual([
      { type: "web_search_result", url: "https://example.com", title: "Example" },
    ]);
  });

  it("includes page_age when present", () => {
    const results = [{ url: "https://example.com", title: "Example", page_age: "2 days" }];
    const blocks = formatWebSearchResultContent(results);
    expect(blocks).toEqual([
      { type: "web_search_result", url: "https://example.com", title: "Example", page_age: "2 days" },
    ]);
  });

  it("returns empty array for empty results", () => {
    expect(formatWebSearchResultContent([])).toEqual([]);
  });
});

describe("formatWebFetchResultContent", () => {
  it("formats fetch result with title", () => {
    const result = {
      content: "Page content",
      url: "https://example.com",
      status_code: 200,
      title: "Example Page",
    };
    const blocks = formatWebFetchResultContent(result);
    expect(blocks).toEqual([
      { type: "text", text: "Title: Example Page" },
      { type: "text", text: "URL: https://example.com" },
      { type: "text", text: "Page content" },
    ]);
  });

  it("formats fetch result without title", () => {
    const result = {
      content: "Page content",
      url: "https://example.com",
      status_code: 200,
    };
    const blocks = formatWebFetchResultContent(result);
    expect(blocks[0]).toEqual({ type: "text", text: "URL: https://example.com" });
  });

  it("includes status line for error codes", () => {
    const result = {
      content: "Not found",
      url: "https://example.com/404",
      status_code: 404,
    };
    const blocks = formatWebFetchResultContent(result);
    expect(blocks.some((b) => b.type === "text" && (b as Record<string, unknown>).text === "Status: 404")).toBe(true);
  });
});

describe("detectServerToolInText", () => {
  // --- Pattern 1: <tool_use> XML tags ---

  it("detects <tool_use> web_search tag", () => {
    const text = 'I\'ll search for that.\n\n<tool_use>\n{"name": "web_search", "input": {"query": "react-router v7 best practices"}}\n</tool_use>';
    const results = detectServerToolInText(text);
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("web_search");
    expect(results[0].input.query).toBe("react-router v7 best practices");
  });

  it("detects <tool_use> web_fetch tag", () => {
    const text = '<tool_use>\n{"name": "web_fetch", "input": {"url": "https://example.com"}}\n</tool_use>';
    const results = detectServerToolInText(text);
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("web_fetch");
    expect(results[0].input.url).toBe("https://example.com");
  });

  it("detects <tool_use> with prompt field for web_fetch", () => {
    const text = '<tool_use>\n{"name": "web_fetch", "input": {"url": "https://example.com", "prompt": "summarize"}}\n</tool_use>';
    const results = detectServerToolInText(text);
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("web_fetch");
    expect(results[0].input.url).toBe("https://example.com");
    expect(results[0].input.prompt).toBe("summarize");
  });

  it("detects multiple <tool_use> tags in same text", () => {
    const text = '<tool_use>\n{"name": "web_search", "input": {"query": "first query"}}\n</tool_use>\nSome text\n<tool_use>\n{"name": "web_fetch", "input": {"url": "https://example.com"}}\n</tool_use>';
    const results = detectServerToolInText(text);
    expect(results.length).toBe(2);
    expect(results[0].type).toBe("web_search");
    expect(results[1].type).toBe("web_fetch");
  });

  it("ignores <tool_use> tags for non-server tools", () => {
    const text = '<tool_use>\n{"name": "read_file", "input": {"path": "/tmp/test"}}\n</tool_use>';
    const results = detectServerToolInText(text);
    expect(results.length).toBe(0);
  });

  // --- Pattern 2: WebSearch/WebFetch natural language ---

  it("detects WebSearch with query", () => {
    const results = detectServerToolInText('WebSearch {"query": "test query"}');
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("web_search");
    expect(results[0].input.query).toBe("test query");
  });

  it("detects WebFetch with url", () => {
    const results = detectServerToolInText('WebFetch {"url": "https://example.com"}');
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("web_fetch");
    expect(results[0].input.url).toBe("https://example.com");
  });

  it("returns empty array for non-server-tool text", () => {
    expect(detectServerToolInText("Hello world")).toEqual([]);
    expect(detectServerToolInText('{"query": "test"}')).toEqual([]);
  });

  it("detects WebSearch case-insensitively", () => {
    const results = detectServerToolInText('websearch {"query": "test"}');
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("web_search");
  });

  it("detects WebSearch with extra text around it", () => {
    const results = detectServerToolInText('Let me search for that. WebSearch {"query": "latest news"}');
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("web_search");
  });

  it("returns empty array for malformed JSON", () => {
    expect(detectServerToolInText("WebSearch {broken")).toEqual([]);
  });

  it("returns empty array for WebSearch without query", () => {
    expect(detectServerToolInText('WebSearch {"other": "value"}')).toEqual([]);
  });

  it("returns empty array for WebFetch without url", () => {
    expect(detectServerToolInText('WebFetch {"other": "value"}')).toEqual([]);
  });

  // --- Real-world GLM-5.1 output test ---

  it("detects tool call from GLM-style <tool_use> output with hallucinated continuation", () => {
    const text = "I'll search for React Router v7 best practices for you.\n\n<tool_use>\n{\"name\": \"web_search\", \"input\": {\"query\": \"react-router v7 最佳实践 best practices\"}}\n</tool_use>\n\nBased on my search, here's a summary of React Router v7 best practices:\n\n---\n\n## React Router v7 Best Practices\n\n### 1. **Framework Mode vs Library Mode**";
    const results = detectServerToolInText(text);
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("web_search");
    expect(results[0].input.query).toBe("react-router v7 最佳实践 best practices");
  });
});

describe("stripToolUseFromText", () => {
  it("strips <tool_use> and everything after it", () => {
    const text = "I'll search for that.\n\n<tool_use>\n{\"name\": \"web_search\", \"input\": {\"query\": \"test\"}}\n</tool_use>\n\nBased on my search, here are the results...";
    const result = stripToolUseFromText(text);
    expect(result).toBe("I'll search for that.");
  });

  it("returns original text when no <tool_use> tag", () => {
    const text = "Just a normal response without tool calls.";
    expect(stripToolUseFromText(text)).toBe(text);
  });

  it("handles text that starts with <tool_use>", () => {
    const text = '<tool_use>\n{"name": "web_search", "input": {"query": "test"}}\n</tool_use>\nHallucinated results';
    const result = stripToolUseFromText(text);
    expect(result).toBe("");
  });

  it("strips trailing whitespace before tool_use", () => {
    const text = "Some text  \n\n<tool_use>\n...\n</tool_use>";
    const result = stripToolUseFromText(text);
    expect(result).toBe("Some text");
  });
});

describe("isServerToolType", () => {
  it("detects web_search types", () => {
    expect(isServerToolType("web_search_20250305")).toBe(true);
    expect(isServerToolType("web_search")).toBe(true);
  });

  it("detects web_fetch types", () => {
    expect(isServerToolType("web_fetch_20250305")).toBe(true);
    expect(isServerToolType("web_fetch")).toBe(true);
  });

  it("returns false for non-server-tool types", () => {
    expect(isServerToolType("function")).toBe(false);
    expect(isServerToolType("text")).toBe(false);
    expect(isServerToolType("")).toBe(false);
  });
});

describe("buildServerToolFunctionSchema", () => {
  it("returns web_search function schema with query parameter", () => {
    const schema = buildServerToolFunctionSchema("web_search_20250305", "web_search");
    expect(schema).toEqual({
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

  it("returns web_fetch function schema with url and prompt parameters", () => {
    const schema = buildServerToolFunctionSchema("web_fetch_20250305", "web_fetch");
    expect(schema).toEqual({
      type: "function",
      function: {
        name: "web_fetch",
        description: "Fetch the content of a web page. Use this tool when you need to read the content of a specific URL.",
        parameters: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The URL to fetch",
            },
            prompt: {
              type: "string",
              description: "What to look for or summarize from the page",
            },
          },
          required: ["url"],
        },
      },
    });
  });

  it("returns null for non-server-tool type", () => {
    expect(buildServerToolFunctionSchema("function", "read_file")).toBeNull();
    expect(buildServerToolFunctionSchema("text", "something")).toBeNull();
  });
});

describe("buildServerToolSystemPromptSuffix", () => {
  it("returns prompt for web_search", () => {
    const result = buildServerToolSystemPromptSuffix([{ type: "web_search_20250305", name: "web_search" }]);
    expect(result).toContain("web_search");
    expect(result).toContain("query");
  });

  it("returns prompt for web_fetch", () => {
    const result = buildServerToolSystemPromptSuffix([{ type: "web_fetch_20250305", name: "web_fetch" }]);
    expect(result).toContain("web_fetch");
    expect(result).toContain("url");
  });

  it("returns combined prompt for both", () => {
    const result = buildServerToolSystemPromptSuffix([
      { type: "web_search_20250305", name: "web_search" },
      { type: "web_fetch_20250305", name: "web_fetch" },
    ]);
    expect(result).toContain("web_search");
    expect(result).toContain("web_fetch");
  });

  it("returns empty string for empty array", () => {
    expect(buildServerToolSystemPromptSuffix([])).toBe("");
  });

  it("returns empty string for non-server-tools", () => {
    expect(buildServerToolSystemPromptSuffix([{ type: "function", name: "read_file" }])).toBe("");
  });
});
