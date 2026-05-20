import { describe, it, expect } from "bun:test";
import { loadConfig } from "../src/server/config.js";

describe("loadConfig", () => {
  it("loads default config values", () => {
    // Clear relevant env vars for clean test
    const orig: Record<string, string | undefined> = {};
    const keys = ["UPSTREAM_BASE_URL", "API_KEY", "ENABLE_API_KEY_PASSTHROUGH", "PORT", "ENABLE_THINKING", "DEFAULT_MODEL"];
    for (const k of keys) {
      orig[k] = process.env[k];
      delete process.env[k];
    }

    const config = loadConfig();
    expect(config.upstreamBaseUrl).toBe("https://api.openai.com/v1");
    expect(config.apiKey).toBe("");
    expect(config.enableApiKeyPassthrough).toBe(true);
    expect(config.port).toBe(8082);
    expect(config.enableThinking).toBe(true);
    expect(config.defaultModel).toBe("gpt-4o");

    // Restore
    for (const k of keys) {
      if (orig[k] !== undefined) process.env[k] = orig[k];
    }
  });

  it("reads from environment variables", () => {
    process.env.UPSTREAM_BASE_URL = "https://custom.api/v1";
    process.env.API_KEY = "sk-test";
    process.env.PORT = "9090";
    process.env.DEFAULT_MODEL = "claude-3";

    const config = loadConfig();
    expect(config.upstreamBaseUrl).toBe("https://custom.api/v1");
    expect(config.apiKey).toBe("sk-test");
    expect(config.port).toBe(9090);
    expect(config.defaultModel).toBe("claude-3");

    // Clean up
    delete process.env.UPSTREAM_BASE_URL;
    delete process.env.API_KEY;
    delete process.env.PORT;
    delete process.env.DEFAULT_MODEL;
  });
});
