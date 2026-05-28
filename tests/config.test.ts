import { describe, it, expect } from "bun:test";
import { loadConfig, globMatch, resolveModelExtra, deepMerge } from "../src/server/config.js";
import type { ModelOverride } from "../src/server/config.js";

describe("globMatch", () => {
  it("matches exact strings", () => {
    expect(globMatch("gpt-4o", "gpt-4o")).toBe(true);
    expect(globMatch("gpt-4o", "gpt-4")).toBe(false);
  });

  it("matches wildcard *", () => {
    expect(globMatch("claude-*", "claude-sonnet-4")).toBe(true);
    expect(globMatch("claude-*", "claude-opus-4-20250514")).toBe(true);
    expect(globMatch("claude-*", "gpt-4o")).toBe(false);
  });

  it("matches wildcard in the middle", () => {
    expect(globMatch("deepseek-*-pro", "deepseek-v4-pro")).toBe(true);
    expect(globMatch("deepseek-*-pro", "deepseek-v3-pro")).toBe(true);
    expect(globMatch("deepseek-*-pro", "deepseek-v4-chat")).toBe(false);
  });

  it("matches multiple wildcards", () => {
    expect(globMatch("*-*", "claude-sonnet")).toBe(true);
    expect(globMatch("*-*", "single")).toBe(false);
  });

  it("matches ? as single char", () => {
    expect(globMatch("model-?", "model-a")).toBe(true);
    expect(globMatch("model-?", "model-ab")).toBe(false);
  });

  it("matches * as catch-all (including empty string)", () => {
    expect(globMatch("*", "anything")).toBe(true);
    expect(globMatch("*", "")).toBe(true);
  });

  it("escapes regex special chars in pattern", () => {
    expect(globMatch("model.v2*", "model.v2-large")).toBe(true);
    expect(globMatch("model.v2*", "modelXv2-large")).toBe(false);
  });
});

describe("resolveModelExtra", () => {
  const overrides: ModelOverride[] = [
    { pattern: "claude-sonnet-*", extra: { thinking: { type: "enabled", budget_tokens: 10000 } } },
    { pattern: "deepseek*", extra: { reasoning_effort: "high" } },
    { pattern: "*", extra: { stream: true } },
  ];

  it("returns first matching pattern's extra", () => {
    const result = resolveModelExtra("claude-sonnet-4", overrides);
    expect(result).toEqual({ thinking: { type: "enabled", budget_tokens: 10000 } });
  });

  it("matches deepseek* pattern", () => {
    const result = resolveModelExtra("deepseek-v4-pro", overrides);
    expect(result).toEqual({ reasoning_effort: "high" });
  });

  it("matches catch-all * pattern", () => {
    const result = resolveModelExtra("gpt-4o", overrides);
    expect(result).toEqual({ stream: true });
  });

  it("returns empty object when no overrides", () => {
    expect(resolveModelExtra("anything", [])).toEqual({});
    expect(resolveModelExtra("anything", undefined)).toEqual({});
  });
});

describe("deepMerge", () => {
  it("merges flat objects", () => {
    expect(deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 })).toEqual({ a: 1, b: 3, c: 4 });
  });

  it("recursively merges nested objects", () => {
    const target = { thinking: { type: "disabled" }, model: "x" };
    const source = { thinking: { type: "enabled", budget_tokens: 10000 } };
    expect(deepMerge(target, source)).toEqual({
      thinking: { type: "enabled", budget_tokens: 10000 },
      model: "x",
    });
  });

  it("replaces arrays instead of concatenating", () => {
    expect(deepMerge({ tags: [1, 2] }, { tags: [3] })).toEqual({ tags: [3] });
  });

  it("handles null and primitive overrides", () => {
    expect(deepMerge({ a: { b: 1 } }, { a: null })).toEqual({ a: null });
    expect(deepMerge({ a: { b: 1 } }, { a: "string" })).toEqual({ a: "string" });
  });

  it("does not mutate target", () => {
    const target = { x: { y: 1 } };
    const result = deepMerge(target, { x: { z: 2 } });
    expect(result).toEqual({ x: { y: 1, z: 2 } });
    expect(target).toEqual({ x: { y: 1 } });
  });
});

describe("loadConfig", () => {
  it("loads default config values", () => {
    const origArgv = Bun.argv;
    Bun.argv = ["bun", "run", "src/server/index.ts"];

    const config = loadConfig();
    expect(config.upstreamBaseUrl).toBe("https://api.openai.com/v1");
    expect(config.upstreamApiKey).toBe("");
    expect(config.authToken).toBe("");
    expect(config.port).toBe(8082);
    expect(config.enableThinking).toBe(true);
    expect(config.dumpDir).toBe("");
    expect(config.modelOverrides).toEqual([]);
    expect(config.serverTools.webSearch).toBe(false);
    expect(config.serverTools.webFetch).toBe(false);
    expect(config.serverTools.webSearchApiKey).toBe("");
    expect(config.serverTools.webSearchBaseUrl).toBe("https://api.search.brave.com");
    expect(config.serverTools.webFetchAllowedDomains).toEqual([]);
    expect(config.serverTools.webFetchBlockedDomains).toEqual([]);
    expect(config.serverTools.webFetchMaxContentTokens).toBe(5000);

    Bun.argv = origArgv;
  });

  it("reads CLI arguments", () => {
    const origArgv = Bun.argv;
    Bun.argv = [
      "bun", "run", "src/server/index.ts",
      "--upstream-base-url", "https://custom.api/v1",
      "--upstream-api-key", "sk-test",
      "--auth-token", "my-token",
      "--port", "9090",
      "--no-enable-thinking",
      "--dump", "/tmp/dumps",
    ];

    const config = loadConfig();
    expect(config.upstreamBaseUrl).toBe("https://custom.api/v1");
    expect(config.upstreamApiKey).toBe("sk-test");
    expect(config.authToken).toBe("my-token");
    expect(config.port).toBe(9090);
    expect(config.enableThinking).toBe(false);
    expect(config.dumpDir).toBe("/tmp/dumps");

    Bun.argv = origArgv;
  });

  it("reads server tool CLI arguments", () => {
    const origArgv = Bun.argv;
    Bun.argv = [
      "bun", "run", "src/server/index.ts",
      "--enable-web-search",
      "--enable-web-fetch",
      "--web-search-api-key", "BST-xxx",
      "--web-search-base-url", "https://custom.search.api",
      "--web-fetch-allowed-domain", "example.com",
      "--web-fetch-allowed-domain", "docs.example.com",
      "--web-fetch-blocked-domain", "spam.com",
      "--web-fetch-max-content-tokens", "10000",
    ];

    const config = loadConfig();
    expect(config.serverTools.webSearch).toBe(true);
    expect(config.serverTools.webFetch).toBe(true);
    expect(config.serverTools.webSearchApiKey).toBe("BST-xxx");
    expect(config.serverTools.webSearchBaseUrl).toBe("https://custom.search.api");
    expect(config.serverTools.webFetchAllowedDomains).toEqual(["example.com", "docs.example.com"]);
    expect(config.serverTools.webFetchBlockedDomains).toEqual(["spam.com"]);
    expect(config.serverTools.webFetchMaxContentTokens).toBe(10000);

    Bun.argv = origArgv;
  });

  it("parses --upstream-extra-params with glob=JSON", () => {
    const origArgv = Bun.argv;
    Bun.argv = [
      "bun", "run", "src/server/index.ts",
      "--upstream-extra-params", 'claude-*={"thinking":{"type":"enabled","budget_tokens":10000}}',
      "--upstream-extra-params", 'deepseek*={"reasoning_effort":"high"}',
    ];

    const config = loadConfig();
    expect(config.modelOverrides).toEqual([
      { pattern: "claude-*", extra: { thinking: { type: "enabled", budget_tokens: 10000 } } },
      { pattern: "deepseek*", extra: { reasoning_effort: "high" } },
    ]);

    Bun.argv = origArgv;
  });

  it("supports --upstream-extra-params= format", () => {
    const origArgv = Bun.argv;
    Bun.argv = [
      "bun", "run", "src/server/index.ts",
      '--upstream-extra-params=*={"stream":true}',
    ];

    const config = loadConfig();
    expect(config.modelOverrides).toEqual([
      { pattern: "*", extra: { stream: true } },
    ]);

    Bun.argv = origArgv;
  });

  it("skips invalid --upstream-extra-params entries gracefully", () => {
    const origArgv = Bun.argv;
    const origWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: string) => warnings.push(msg);

    Bun.argv = [
      "bun", "run", "src/server/index.ts",
      "--upstream-extra-params", "no-equal-sign",
      "--upstream-extra-params", 'good*={"ok":1}',
      "--upstream-extra-params", 'bad={not json}',
      "--upstream-extra-params", 'arr*=[1,2]',
    ];

    const config = loadConfig();
    expect(config.modelOverrides).toEqual([
      { pattern: "good*", extra: { ok: 1 } },
    ]);
    expect(warnings.length).toBe(3);

    console.warn = origWarn;
    Bun.argv = origArgv;
  });
});
