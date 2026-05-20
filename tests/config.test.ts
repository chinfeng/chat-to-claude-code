import { describe, it, expect } from "bun:test";
import { loadConfig } from "../src/server/config.js";

describe("loadConfig", () => {
  it("loads default config values", () => {
    // Override argv to simulate no args
    const origArgv = Bun.argv;
    Bun.argv = ["bun", "run", "src/server/index.ts"];

    const config = loadConfig();
    expect(config.upstreamBaseUrl).toBe("https://api.openai.com/v1");
    expect(config.upstreamApiKey).toBe("");
    expect(config.authToken).toBe("");
    expect(config.port).toBe(8082);
    expect(config.enableThinking).toBe(true);
    expect(config.dumpDir).toBe("");

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
});
