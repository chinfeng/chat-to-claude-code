import { describe, it, expect } from "bun:test";
import { routeRequest, applyAlias } from "../src/server/routes.js";
import type { ResolvedConfig } from "../src/server/config.js";
import type { UpstreamConfig } from "../src/server/route_config.js";
import { Router } from "../src/server/router.js";

const TEST_CONFIG: ResolvedConfig = {
  mode: "single",
  upstream: {
    baseUrl: "http://127.0.0.1:19999",
    apiKey: "test-key",
    modelOverrides: [],
  },
  authToken: "",
  port: 8082,
  enableThinking: true,
  dumpDir: "",
  serverTools: {
    webSearch: false,
    webFetch: false,
    webSearchApiKey: "",
    webSearchBaseUrl: "https://api.search.brave.com",
    webFetchAllowedDomains: [],
    webFetchBlockedDomains: [],
    webFetchMaxContentTokens: 5000,
  },
};

describe("routeRequest", () => {
  it("returns 404 for unknown routes", async () => {
    const req = new Request("http://localhost/v1/unknown");
    const res = await routeRequest(req, TEST_CONFIG);
    expect(res.status).toBe(404);
  });

  it("returns health check for /health", async () => {
    const req = new Request("http://localhost/health");
    const res = await routeRequest(req, TEST_CONFIG);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("returns 400 for missing model", async () => {
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    const res = await routeRequest(req, TEST_CONFIG);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("returns 400 for missing messages", async () => {
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o" }),
    });
    const res = await routeRequest(req, TEST_CONFIG);
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const res = await routeRequest(req, TEST_CONFIG);
    expect(res.status).toBe(400);
  });

  it("returns 401 when auth token is set and client key mismatches", async () => {
    const authConfig: ResolvedConfig = {
      ...TEST_CONFIG,
      mode: "single",
      upstream: { baseUrl: "http://127.0.0.1:19999", apiKey: "", modelOverrides: [] },
      authToken: "secret",
    };
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "wrong" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });
    const res = await routeRequest(req, authConfig);
    expect(res.status).toBe(401);
  });

  it("uses client API key in passthrough mode (no upstream key, no auth token)", async () => {
    const passthroughConfig: ResolvedConfig = {
      ...TEST_CONFIG,
      mode: "single",
      upstream: { baseUrl: "http://127.0.0.1:19999", apiKey: "", modelOverrides: [] },
      authToken: "",
    };
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "client-key" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });
    const res = await routeRequest(req, passthroughConfig);
    expect(res.status).not.toBe(401);
  });

  it("passes server_tools through in parsed request data", async () => {
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        server_tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    });
    // This will fail at fetch (no real upstream), but should not 400
    const res = await routeRequest(req, TEST_CONFIG);
    expect(res.status).not.toBe(400);
  });
});

describe("applyAlias", () => {
  it("returns original model when no alias matches", () => {
    expect(applyAlias("gpt-4o", {})).toBe("gpt-4o");
  });

  it("returns alias target when alias matches", () => {
    expect(applyAlias("claude-sonnet-4", { "claude-sonnet-4": "deepseek-v4" })).toBe("deepseek-v4");
  });

  it("returns original model when alias key does not match exactly", () => {
    expect(applyAlias("claude-sonnet-4.1", { "claude-sonnet-4": "deepseek-v4" })).toBe("claude-sonnet-4.1");
  });
});

describe("route mode handleMessages", () => {
  const routeUpstreams: UpstreamConfig[] = [
    { name: "nim", baseUrl: "http://127.0.0.1:19999", apiKey: "key-nim", weight: 1, tokenBudget: 0, aliases: {}, modelOverrides: [] },
    { name: "openrouter", baseUrl: "http://127.0.0.1:19999", apiKey: "key-or", weight: 1, tokenBudget: 0, aliases: { "claude-sonnet-4": "deepseek-v4" }, modelOverrides: [] },
  ];

  const ROUTE_CONFIG: ResolvedConfig = {
    mode: "route",
    authToken: "secret",
    port: 8082,
    enableThinking: true,
    dumpDir: "",
    serverTools: {
      webSearch: false,
      webFetch: false,
      webSearchApiKey: "",
      webSearchBaseUrl: "https://api.search.brave.com",
      webFetchAllowedDomains: [],
      webFetchBlockedDomains: [],
      webFetchMaxContentTokens: 5000,
    },
    route: {
      algorithm: "round-robin",
      upstreams: routeUpstreams,
    },
  };

  it("returns 401 when auth token mismatches in route mode", async () => {
    const router = new Router("round-robin", routeUpstreams);
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "wrong" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });
    const res = await routeRequest(req, ROUTE_CONFIG, router);
    expect(res.status).toBe(401);
  });

  it("accepts valid auth token in route mode", async () => {
    const router = new Router("round-robin", routeUpstreams);
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "secret" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });
    const res = await routeRequest(req, ROUTE_CONFIG, router);
    // Will fail at fetch (no real upstream), but should not 401
    expect(res.status).not.toBe(401);
  });

  it("route mode with no auth token accepts any client", async () => {
    const noAuthRouteConfig: ResolvedConfig = {
      ...ROUTE_CONFIG,
      authToken: "",
    };
    const router = new Router("round-robin", routeUpstreams);
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });
    const res = await routeRequest(req, noAuthRouteConfig, router);
    expect(res.status).not.toBe(401);
  });
});
