import { describe, it, expect } from "bun:test";
import { loadRouteConfig, validateRouteConfig, type UpstreamConfig, type RouteConfigFile } from "../src/server/route_config.js";

describe("validateRouteConfig", () => {
  it("rejects empty upstreams array", () => {
    const config: RouteConfigFile = {
      upstreams: [],
      algorithm: "round-robin",
    };
    const result = validateRouteConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects duplicate upstream names", () => {
    const config: RouteConfigFile = {
      upstreams: [
        { name: "a", baseUrl: "https://a.com/v1", apiKey: "key-a" },
        { name: "a", baseUrl: "https://b.com/v1", apiKey: "key-b" },
      ],
      algorithm: "round-robin",
    };
    const result = validateRouteConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes("duplicate"))).toBe(true);
  });

  it("rejects upstream missing required fields", () => {
    const config: RouteConfigFile = {
      upstreams: [
        { name: "", baseUrl: "https://a.com/v1", apiKey: "key-a" },
      ],
      algorithm: "round-robin",
    };
    const result = validateRouteConfig(config);
    expect(result.valid).toBe(false);
  });

  it("rejects upstream with empty apiKey", () => {
    const config: RouteConfigFile = {
      upstreams: [
        { name: "a", baseUrl: "https://a.com/v1", apiKey: "" },
      ],
      algorithm: "round-robin",
    };
    const result = validateRouteConfig(config);
    expect(result.valid).toBe(false);
  });

  it("rejects invalid algorithm", () => {
    const config = {
      upstreams: [{ name: "a", baseUrl: "https://a.com/v1", apiKey: "key" }],
      algorithm: "invalid",
    };
    const result = validateRouteConfig(config as RouteConfigFile);
    expect(result.valid).toBe(false);
  });

  it("accepts valid config with minimal fields", () => {
    const config: RouteConfigFile = {
      upstreams: [
        { name: "nim", baseUrl: "https://api.nvidia.com/v1", apiKey: "nvapi-xxx" },
      ],
      algorithm: "round-robin",
    };
    const result = validateRouteConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts valid config with all optional fields", () => {
    const config: RouteConfigFile = {
      port: 9090,
      authToken: "secret",
      enableThinking: false,
      dumpDir: "/tmp/dump",
      algorithm: "weighted",
      upstreams: [
        {
          name: "nim",
          baseUrl: "https://api.nvidia.com/v1",
          apiKey: "nvapi-xxx",
          weight: 2,
          tokenBudget: 100000,
          aliases: { "claude-sonnet-4": "deepseek-v4-pro" },
          modelOverrides: [{ pattern: "deepseek*", extra: { reasoning_effort: "high" } }],
        },
      ],
      serverTools: {
        webSearch: true,
        webFetch: false,
        webSearchEngine: "brave",
        webSearchApiKey: "BST-xxx",
        webSearchBaseUrl: "https://api.search.brave.com",
        webFetchAllowedDomains: [],
        webFetchBlockedDomains: [],
        webFetchMaxContentTokens: 5000,
      },
    };
    const result = validateRouteConfig(config);
    expect(result.valid).toBe(true);
  });
});

describe("loadRouteConfig", () => {
  it("throws on missing file", () => {
    expect(() => loadRouteConfig("/nonexistent/path.json")).toThrow();
  });

  it("throws on invalid JSON", () => {
    const tmpFile = `/tmp/test-route-config-${Date.now()}.json`;
    require("fs").writeFileSync(tmpFile, "not json");
    try {
      expect(() => loadRouteConfig(tmpFile)).toThrow();
    } finally {
      try { require("fs").unlinkSync(tmpFile); } catch {}
    }
  });

  it("throws on validation failure", () => {
    const tmpFile = `/tmp/test-route-config-${Date.now()}.json`;
    require("fs").writeFileSync(tmpFile, JSON.stringify({ upstreams: [], algorithm: "round-robin" }));
    try {
      expect(() => loadRouteConfig(tmpFile)).toThrow();
    } finally {
      try { require("fs").unlinkSync(tmpFile); } catch {}
    }
  });

  it("loads and normalizes valid config", () => {
    const tmpFile = `/tmp/test-route-config-${Date.now()}.json`;
    const raw = {
      upstreams: [{ name: "nim", baseUrl: "https://api.nvidia.com/v1", apiKey: "nvapi-xxx" }],
      algorithm: "round-robin",
    };
    require("fs").writeFileSync(tmpFile, JSON.stringify(raw));
    try {
      const config = loadRouteConfig(tmpFile);
      expect(config.upstreams.length).toBe(1);
      expect(config.upstreams[0].name).toBe("nim");
      expect(config.upstreams[0].weight).toBe(1);
      expect(config.upstreams[0].tokenBudget).toBe(0);
      expect(config.upstreams[0].aliases).toEqual({});
      expect(config.upstreams[0].modelOverrides).toEqual([]);
      expect(config.port).toBe(8082);
      expect(config.algorithm).toBe("round-robin");
    } finally {
      try { require("fs").unlinkSync(tmpFile); } catch {}
    }
  });
});
