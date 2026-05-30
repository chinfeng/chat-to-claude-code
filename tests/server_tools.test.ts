import { describe, it, expect } from "bun:test";
import {
  requestHasWebSearch,
  requestHasWebFetch,
  isServerToolUseCall,
  formatWebSearchResultContent,
  formatWebFetchResultContent,
  detectServerToolInText,
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
  it("detects WebSearch with query", () => {
    const result = detectServerToolInText('WebSearch {"query": "test query"}');
    expect(result).not.toBeNull();
    expect(result!.type).toBe("web_search");
    expect((result!.input as Record<string, unknown>).query).toBe("test query");
  });

  it("detects WebFetch with url", () => {
    const result = detectServerToolInText('WebFetch {"url": "https://example.com"}');
    expect(result).not.toBeNull();
    expect(result!.type).toBe("web_fetch");
    expect((result!.input as Record<string, unknown>).url).toBe("https://example.com");
  });

  it("returns null for non-server-tool text", () => {
    expect(detectServerToolInText("Hello world")).toBeNull();
    expect(detectServerToolInText('{"query": "test"}')).toBeNull();
  });

  it("detects WebSearch case-insensitively", () => {
    const result = detectServerToolInText('websearch {"query": "test"}');
    expect(result).not.toBeNull();
    expect(result!.type).toBe("web_search");
  });

  it("detects WebSearch with extra text around it", () => {
    const result = detectServerToolInText('Let me search for that. WebSearch {"query": "latest news"}');
    expect(result).not.toBeNull();
    expect(result!.type).toBe("web_search");
  });

  it("returns null for malformed JSON", () => {
    expect(detectServerToolInText("WebSearch {broken")).toBeNull();
  });

  it("returns null for WebSearch without query", () => {
    expect(detectServerToolInText('WebSearch {"other": "value"}')).toBeNull();
  });

  it("returns null for WebFetch without url", () => {
    expect(detectServerToolInText('WebFetch {"other": "value"}')).toBeNull();
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