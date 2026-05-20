import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { routeRequest } from "../src/server/routes.js";
import type { ServerConfig } from "../src/server/config.js";

const TEST_CONFIG: ServerConfig = {
  upstreamBaseUrl: "http://127.0.0.1:19999",
  apiKey: "test-key",
  enableApiKeyPassthrough: true,
  port: 8082,
  enableThinking: true,
  defaultModel: "gpt-4o",
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

  it("returns 401 when no API key and passthrough is disabled with no server key", async () => {
    const noKeyConfig: ServerConfig = {
      ...TEST_CONFIG,
      apiKey: "",
      enableApiKeyPassthrough: false,
    };
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "client-key" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });
    const res = await routeRequest(req, noKeyConfig);
    expect(res.status).toBe(401);
  });

  it("uses client API key when passthrough is enabled", async () => {
    const passthroughConfig: ServerConfig = {
      ...TEST_CONFIG,
      apiKey: "",
      enableApiKeyPassthrough: true,
    };
    // This will fail at fetch (no real upstream), but should not 401
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "client-key" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });
    const res = await routeRequest(req, passthroughConfig);
    // It might be 502 (upstream error) but NOT 401
    expect(res.status).not.toBe(401);
  });
});
