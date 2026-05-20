import { describe, it, expect } from "bun:test";
import { estimateTokens, estimateInputTokens } from "../src/core/tokens.js";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estimates tokens from char length", () => {
    expect(estimateTokens("hello")).toBe(2); // ceil(5/4)
    expect(estimateTokens("abcdefgh")).toBe(2); // ceil(8/4)
    expect(estimateTokens("a")).toBe(1);
  });
});

describe("estimateInputTokens", () => {
  it("estimates tokens for string content", () => {
    const messages = [{ role: "user", content: "Hello world" }];
    const tokens = estimateInputTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  it("estimates tokens for content blocks", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello world from blocks" }],
      },
    ];
    const tokens = estimateInputTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  it("returns at least 1 token", () => {
    const tokens = estimateInputTokens([]);
    expect(tokens).toBeGreaterThanOrEqual(1);
  });
});
