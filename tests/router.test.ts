import { describe, it, expect } from "bun:test";
import { Router, type UpstreamConfig, type RouteAlgorithm } from "../src/server/router.js";

const upstreams: UpstreamConfig[] = [
  {
    name: "a",
    baseUrl: "https://a.com/v1",
    apiKey: "key-a",
    weight: 1,
    tokenBudget: 1000,
    aliases: {},
    modelOverrides: [],
  },
  {
    name: "b",
    baseUrl: "https://b.com/v1",
    apiKey: "key-b",
    weight: 2,
    tokenBudget: 500,
    aliases: {},
    modelOverrides: [],
  },
];

describe("Router - round-robin", () => {
  it("cycles through upstreams in order", () => {
    const router = new Router("round-robin", upstreams);
    expect(router.select().name).toBe("a");
    expect(router.select().name).toBe("b");
    expect(router.select().name).toBe("a");
    expect(router.select().name).toBe("b");
  });

  it("formats round-robin log correctly", () => {
    const router = new Router("round-robin", upstreams);
    router.select();
    router.select();
    router.select();
    const log = router.formatLog("a");
    expect(log).toContain("algorithm=round-robin");
    expect(log).toContain("selected=a");
    expect(log).toContain("a:2");
    expect(log).toContain("b:1");
  });

  it("works with single upstream", () => {
    const single = [upstreams[0]];
    const router = new Router("round-robin", single);
    expect(router.select().name).toBe("a");
    expect(router.select().name).toBe("a");
  });
});

describe("Router - token-budget", () => {
  it("selects upstream with highest remaining budget", () => {
    const router = new Router("token-budget", upstreams);
    // a: 1000, b: 500 -> selects a
    expect(router.select().name).toBe("a");
    // Deduct from a: a:500, b:500 -> tie, picks first
    router.deduct("a", 500);
    expect(router.select().name).toBe("a");
    // Deduct more from a: a:0, b:500 -> selects b
    router.deduct("a", 500);
    expect(router.select().name).toBe("b");
  });

  it("falls back to round-robin when all budgets are zero", () => {
    const router = new Router("token-budget", upstreams);
    router.deduct("a", 1000);
    router.deduct("b", 500);
    // All budgets depleted — should fall back to round-robin, not reject
    const selected = router.select();
    expect(selected).toBeDefined();
    // Round-robin fallback: first call selects index 0
    expect(selected.name).toBe("a");
    expect(router.select().name).toBe("b");
  });

  it("treats zero configured budget as unlimited (always preferred)", () => {
    const unlimitedUpstreams: UpstreamConfig[] = [
      {
        name: "unlimited",
        baseUrl: "https://u.com/v1",
        apiKey: "key-u",
        weight: 1,
        tokenBudget: 0,
        aliases: {},
        modelOverrides: [],
      },
      {
        name: "limited",
        baseUrl: "https://l.com/v1",
        apiKey: "key-l",
        weight: 1,
        tokenBudget: 100,
        aliases: {},
        modelOverrides: [],
      },
    ];
    const router = new Router("token-budget", unlimitedUpstreams);
    // unlimited (budget=0, meaning infinite) should always be selected
    expect(router.select().name).toBe("unlimited");
    // deducting from unlimited has no effect (budget 0 means no tracking)
    router.deduct("unlimited", 999999);
    expect(router.select().name).toBe("unlimited");
  });

  it("formats token-budget log correctly", () => {
    const router = new Router("token-budget", upstreams);
    router.select();
    router.deduct("a", 200);
    const log = router.formatLog("a");
    expect(log).toContain("algorithm=token-budget");
    expect(log).toContain("selected=a");
    expect(log).toContain("a:800/1000");
    expect(log).toContain("b:500/500");
  });
});

describe("Router - weighted", () => {
  it("distributes requests by weight ratio", () => {
    const router = new Router("weighted", upstreams);
    // a:weight=1, b:weight=2 -> ratio should be 1:2
    const counts: Record<string, number> = { a: 0, b: 0 };
    for (let i = 0; i < 3; i++) {
      counts[router.select().name]++;
    }
    // Over 3 requests with weights 1:2, should be a:1, b:2
    expect(counts.a).toBe(1);
    expect(counts.b).toBe(2);
  });

  it("handles equal weights as round-robin", () => {
    const equalUpstreams: UpstreamConfig[] = [
      {
        name: "x",
        baseUrl: "https://x.com/v1",
        apiKey: "key-x",
        weight: 1,
        tokenBudget: 0,
        aliases: {},
        modelOverrides: [],
      },
      {
        name: "y",
        baseUrl: "https://y.com/v1",
        apiKey: "key-y",
        weight: 1,
        tokenBudget: 0,
        aliases: {},
        modelOverrides: [],
      },
    ];
    const router = new Router("weighted", equalUpstreams);
    expect(router.select().name).toBe("x");
    expect(router.select().name).toBe("y");
  });

  it("formats weighted log correctly", () => {
    const router = new Router("weighted", upstreams);
    router.select(); // b (weight 2)
    const log = router.formatLog("b");
    expect(log).toContain("algorithm=weighted");
    expect(log).toContain("selected=b");
    expect(log).toContain("b:1/2");
  });
});

describe("Router - deduct", () => {
  it("ignores deduction for unknown upstream name", () => {
    const router = new Router("round-robin", upstreams);
    expect(() => router.deduct("unknown", 100)).not.toThrow();
  });
});
