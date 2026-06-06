# Cluster Route Feature 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 chat-to-claude-code 中增加 route 模式，支持多上游 + 路由算法选择，原有单上游模式内部重构为 route 的特例。

**架构：** 新增 `--route-config <path>` 参数加载 JSON 配置文件，内部统一为 `ResolvedConfig`。新增 `Router` 类实现三种算法（轮询、Token 预算、权重）。重构 `handleMessages` 为 `handleMessagesWithUpstream`，single 模式自动构造 `SelectedUpstream` 共享同一套请求处理代码。

**技术栈：** TypeScript / Bun / 零外部依赖

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/server/route_config.ts` | 创建 | JSON 配置文件类型定义、加载、校验 |
| `src/server/router.ts` | 创建 | Router 类：三种算法 + 状态管理 + 路由日志 |
| `src/server/config.ts` | 修改 | 新增 `--route-config` 参数、`ResolvedConfig` 类型、配置解析逻辑 |
| `src/server/routes.ts` | 修改 | 重构为 `handleMessagesWithUpstream`，增加 alias 替换，token-budget 扣减 |
| `src/server/index.ts` | 修改 | 支持 route 模式启动显示 |
| `tests/route_config.test.ts` | 创建 | JSON 配置加载与校验测试 |
| `tests/router.test.ts` | 创建 | 三种算法 + 路由日志测试 |
| `tests/routes.test.ts` | 修改 | 增加 route 模式测试用例 |
| `README.md` | 修改 | 增加 route 模式文档 |
| `README-zh.md` | 修改 | 增加 route 模式中文文档 |

---

## 任务 1：创建 feature/route 分支

- [ ] **步骤 1：从 master 创建分支**
  ```bash
  git checkout -b feature/route master
  ```

- [ ] **步骤 2：确认分支**
  ```bash
  git branch --show-current
  ```
  预期输出：`feature/route`

---

## 任务 2：路由配置类型与 JSON 加载器

**文件：**
- 创建：`src/server/route_config.ts`
- 测试：`tests/route_config.test.ts`

- [ ] **步骤 1：编写 route_config 失败测试**

  创建 `tests/route_config.test.ts`：

  ```typescript
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

    it("fills default values for missing optional fields", () => {
      const config: RouteConfigFile = {
        upstreams: [
          { name: "nim", baseUrl: "https://api.nvidia.com/v1", apiKey: "nvapi-xxx" },
        ],
        algorithm: "round-robin",
      };
      const result = validateRouteConfig(config);
      expect(result.valid).toBe(true);
      const u = config.upstreams[0];
      // defaults applied in normalizeRouteConfig, not validateRouteConfig
    });
  });

  describe("loadRouteConfig", () => {
    it("throws on missing file", () => {
      expect(() => loadRouteConfig("/nonexistent/path.json")).toThrow();
    });

    it("throws on invalid JSON", () => {
      // Use a temp file with invalid JSON
      const tmpFile = `/tmp/test-route-config-${Date.now()}.json`;
      Bun.write(tmpFile, "not json");
      try {
        expect(() => loadRouteConfig(tmpFile)).toThrow();
      } finally {
        Bun.file(tmpFile).unlink?.() || undefined;
      }
    });

    it("throws on validation failure", () => {
      const tmpFile = `/tmp/test-route-config-${Date.now()}.json`;
      Bun.write(tmpFile, JSON.stringify({ upstreams: [], algorithm: "round-robin" }));
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
      Bun.write(tmpFile, JSON.stringify(raw));
      try {
        const config = loadRouteConfig(tmpFile);
        expect(config.upstreams.length).toBe(1);
        expect(config.upstreams[0].name).toBe("nim");
        expect(config.upstreams[0].weight).toBe(1); // default
        expect(config.upstreams[0].tokenBudget).toBe(0); // default
        expect(config.upstreams[0].aliases).toEqual({}); // default
        expect(config.upstreams[0].modelOverrides).toEqual([]); // default
        expect(config.port).toBe(8082); // default
        expect(config.algorithm).toBe("round-robin");
      } finally {
        try { require("fs").unlinkSync(tmpFile); } catch {}
      }
    });
  });
  ```

- [ ] **步骤 2：运行测试验证失败**

  ```bash
  bun test tests/route_config.test.ts
  ```
  预期：FAIL，报错模块不存在

- [ ] **步骤 3：实现 route_config.ts**

  创建 `src/server/route_config.ts`：

  ```typescript
  /** Route mode configuration: JSON file types, loader, and validation. */

  import { readFileSync } from "node:fs";
  import type { ModelOverride, ServerToolConfig } from "./config.js";

  export type RouteAlgorithm = "round-robin" | "token-budget" | "weighted";

  export interface UpstreamConfig {
    name: string;
    baseUrl: string;
    apiKey: string;
    weight: number;
    tokenBudget: number;
    aliases: Record<string, string>;
    modelOverrides: ModelOverride[];
  }

  export interface RouteConfigFile {
    port?: number;
    authToken?: string;
    enableThinking?: boolean;
    dumpDir?: string;
    algorithm?: RouteAlgorithm;
    upstreams: Partial<UpstreamConfig>[];
    serverTools?: Partial<ServerToolConfig>;
  }

  export interface NormalizedRouteConfig {
    port: number;
    authToken: string;
    enableThinking: boolean;
    dumpDir: string;
    algorithm: RouteAlgorithm;
    upstreams: UpstreamConfig[];
    serverTools: ServerToolConfig;
  }

  export interface ValidationResult {
    valid: boolean;
    errors: string[];
  }

  /** Validate a route config (raw, before normalization). Checks required fields and constraints. */
  export function validateRouteConfig(config: RouteConfigFile): ValidationResult {
    const errors: string[] = [];

    if (!config.upstreams || !Array.isArray(config.upstreams) || config.upstreams.length === 0) {
      errors.push("upstreams must be a non-empty array");
    } else {
      const names = new Set<string>();
      for (let i = 0; i < config.upstreams.length; i++) {
        const u = config.upstreams[i];
        const prefix = `upstreams[${i}]`;
        if (!u.name || typeof u.name !== "string" || !u.name.trim()) {
          errors.push(`${prefix}.name is required and must be a non-empty string`);
        }
        if (!u.baseUrl || typeof u.baseUrl !== "string" || !u.baseUrl.trim()) {
          errors.push(`${prefix}.baseUrl is required and must be a non-empty string`);
        }
        if (!u.apiKey || typeof u.apiKey !== "string" || !u.apiKey.trim()) {
          errors.push(`${prefix}.apiKey is required and must be a non-empty string`);
        }
        if (u.name) {
          if (names.has(u.name)) {
            errors.push(`${prefix}.name "${u.name}" is a duplicate`);
          }
          names.add(u.name);
        }
      }
    }

    const validAlgorithms: RouteAlgorithm[] = ["round-robin", "token-budget", "weighted"];
    if (config.algorithm && !validAlgorithms.includes(config.algorithm)) {
      errors.push(`algorithm must be one of: ${validAlgorithms.join(", ")}, got "${config.algorithm}"`);
    }

    return { valid: errors.length === 0, errors };
  }

  /** Normalize a route config: fill defaults for all optional fields. */
  export function normalizeRouteConfig(config: RouteConfigFile): NormalizedRouteConfig {
    const defaultServerTools: ServerToolConfig = {
      webSearch: false,
      webFetch: false,
      webSearchEngine: "brave",
      webSearchApiKey: "",
      webSearchBaseUrl: "https://api.search.brave.com",
      webFetchAllowedDomains: [],
      webFetchBlockedDomains: [],
      webFetchMaxContentTokens: 5000,
    };

    return {
      port: config.port ?? 8082,
      authToken: config.authToken ?? "",
      enableThinking: config.enableThinking ?? true,
      dumpDir: config.dumpDir ?? "",
      algorithm: config.algorithm ?? "round-robin",
      upstreams: config.upstreams.map((u) => ({
        name: u.name ?? "",
        baseUrl: u.baseUrl ?? "",
        apiKey: u.apiKey ?? "",
        weight: u.weight ?? 1,
        tokenBudget: u.tokenBudget ?? 0,
        aliases: u.aliases ?? {},
        modelOverrides: u.modelOverrides ?? [],
      })),
      serverTools: config.serverTools
        ? { ...defaultServerTools, ...config.serverTools }
        : defaultServerTools,
    };
  }

  /** Load a route config JSON file, validate, and normalize it. Throws on error. */
  export function loadRouteConfig(path: string): NormalizedRouteConfig {
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch (e) {
      throw new Error(`Failed to read route config file: ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Invalid JSON in route config file: ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }

    const config = parsed as RouteConfigFile;
    const validation = validateRouteConfig(config);
    if (!validation.valid) {
      throw new Error(`Invalid route config: ${validation.errors.join("; ")}`);
    }

    return normalizeRouteConfig(config);
  }
  ```

- [ ] **步骤 4：运行测试验证通过**

  ```bash
  bun test tests/route_config.test.ts
  ```
  预期：全部 PASS

- [ ] **步骤 5：Commit**

  ```bash
  git add src/server/route_config.ts tests/route_config.test.ts
  git commit -m "feat: add route config types, loader, and validation"
  ```

---

## 任务 3：Router 类 — 三种路由算法 + 路由日志

**文件：**
- 创建：`src/server/router.ts`
- 测试：`tests/router.test.ts`

- [ ] **步骤 1：编写 Router 失败测试**

  创建 `tests/router.test.ts`：

  ```typescript
  import { describe, it, expect } from "bun:test";
  import { Router, type UpstreamConfig, type RouteAlgorithm } from "../src/server/router.js";

  const upstreams: UpstreamConfig[] = [
    { name: "a", baseUrl: "https://a.com/v1", apiKey: "key-a", weight: 1, tokenBudget: 1000, aliases: {}, modelOverrides: [] },
    { name: "b", baseUrl: "https://b.com/v1", apiKey: "key-b", weight: 2, tokenBudget: 500, aliases: {}, modelOverrides: [] },
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
        { name: "unlimited", baseUrl: "https://u.com/v1", apiKey: "key-u", weight: 1, tokenBudget: 0, aliases: {}, modelOverrides: [] },
        { name: "limited", baseUrl: "https://l.com/v1", apiKey: "key-l", weight: 1, tokenBudget: 100, aliases: {}, modelOverrides: [] },
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
        { name: "x", baseUrl: "https://x.com/v1", apiKey: "key-x", weight: 1, tokenBudget: 0, aliases: {}, modelOverrides: [] },
        { name: "y", baseUrl: "https://y.com/v1", apiKey: "key-y", weight: 1, tokenBudget: 0, aliases: {}, modelOverrides: [] },
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
  ```

- [ ] **步骤 2：运行测试验证失败**

  ```bash
  bun test tests/router.test.ts
  ```
  预期：FAIL，模块不存在

- [ ] **步骤 3：实现 Router**

  创建 `src/server/router.ts`：

  ```typescript
  /** Router: selects an upstream based on the configured algorithm. */

  export type RouteAlgorithm = "round-robin" | "token-budget" | "weighted";

  export interface UpstreamConfig {
    name: string;
    baseUrl: string;
    apiKey: string;
    weight: number;
    tokenBudget: number;
    aliases: Record<string, string>;
    modelOverrides: import("./config.js").ModelOverride[];
  }

  interface UpstreamState {
    name: string;
    // round-robin + token-budget fallback
    requestCount: number;
    // token-budget
    remainingBudget: number;
    totalBudget: number;
    // weighted (smooth WRR)
    currentWeight: number;
    effectiveWeight: number;
    weightedRequestCount: number;
  }

  export class Router {
    private readonly algorithm: RouteAlgorithm;
    private readonly upstreams: UpstreamConfig[];
    private readonly states: UpstreamState[];
    private rrCounter = 0; // round-robin counter (also used for token-budget fallback)

    constructor(algorithm: RouteAlgorithm, upstreams: UpstreamConfig[]) {
      this.algorithm = algorithm;
      this.upstreams = [...upstreams];
      this.states = upstreams.map((u) => ({
        name: u.name,
        requestCount: 0,
        remainingBudget: u.tokenBudget,
        totalBudget: u.tokenBudget,
        currentWeight: 0,
        effectiveWeight: u.weight || 1,
        weightedRequestCount: 0,
      }));
    }

    /** Select an upstream based on the routing algorithm. */
    select(): UpstreamConfig {
      let selected: UpstreamConfig;
      switch (this.algorithm) {
        case "round-robin":
          selected = this.selectRoundRobin();
          break;
        case "token-budget":
          selected = this.selectTokenBudget();
          break;
        case "weighted":
          selected = this.selectWeighted();
          break;
        default:
          selected = this.selectRoundRobin();
      }
      // Track request count for all algorithms
      const state = this.states.find((s) => s.name === selected.name);
      if (state) {
        state.requestCount++;
        state.weightedRequestCount++;
      }
      return selected;
    }

    /** Deduct tokens from an upstream's remaining budget (token-budget algorithm). */
    deduct(upstreamName: string, tokens: number): void {
      const state = this.states.find((s) => s.name === upstreamName);
      if (!state) return;
      // tokenBudget=0 means unlimited — don't track
      if (state.totalBudget === 0) return;
      state.remainingBudget = Math.max(0, state.remainingBudget - tokens);
    }

    /** Format a route log line for the given selected upstream. */
    formatLog(selectedName: string): string {
      const parts = this.states.map((s) => {
        switch (this.algorithm) {
          case "round-robin":
            return `${s.name}:${s.requestCount}`;
          case "token-budget":
            return `${s.name}:${s.remainingBudget}/${s.totalBudget}`;
          case "weighted":
            return `${s.name}:${s.weightedRequestCount}/${s.effectiveWeight}`;
          default:
            return `${s.name}:${s.requestCount}`;
        }
      });
      return `[route] algorithm=${this.algorithm} selected=${selectedName} | ${parts.join(" ")}`;
    }

    private selectRoundRobin(): UpstreamConfig {
      const idx = this.rrCounter % this.upstreams.length;
      this.rrCounter++;
      return this.upstreams[idx];
    }

    private selectTokenBudget(): UpstreamConfig {
      // Find the upstream with the highest remaining budget.
      // tokenBudget=0 means unlimited (treated as Infinity).
      let maxBudget = -1;
      let selectedIdx = 0;
      for (let i = 0; i < this.states.length; i++) {
        const budget = this.states[i].totalBudget === 0
          ? Infinity
          : this.states[i].remainingBudget;
        if (budget > maxBudget) {
          maxBudget = budget;
          selectedIdx = i;
        }
      }

      // If all upstreams have remainingBudget === 0 (and none are unlimited),
      // fall back to round-robin.
      if (maxBudget === 0) {
        return this.selectRoundRobin();
      }

      return this.upstreams[selectedIdx];
    }

    private selectWeighted(): UpstreamConfig {
      // Smooth Weighted Round Robin (WRR)
      const totalWeight = this.states.reduce((sum, s) => sum + s.effectiveWeight, 0);
      let bestIdx = 0;
      let bestWeight = -Infinity;

      for (let i = 0; i < this.states.length; i++) {
        this.states[i].currentWeight += this.states[i].effectiveWeight;
        if (this.states[i].currentWeight > bestWeight) {
          bestWeight = this.states[i].currentWeight;
          bestIdx = i;
        }
      }

      this.states[bestIdx].currentWeight -= totalWeight;
      return this.upstreams[bestIdx];
    }
  }
  ```

- [ ] **步骤 4：运行测试验证通过**

  ```bash
  bun test tests/router.test.ts
  ```
  预期：全部 PASS

- [ ] **步骤 5：Commit**

  ```bash
  git add src/server/router.ts tests/router.test.ts
  git commit -m "feat: add Router class with round-robin, token-budget, and weighted algorithms"
  ```

---

## 任务 4：扩展 config.ts — 支持 `--route-config` 和 `ResolvedConfig`

**文件：**
- 修改：`src/server/config.ts`
- 修改：`tests/config.test.ts`

- [ ] **步骤 1：编写 ResolvedConfig 相关失败测试**

  在 `tests/config.test.ts` 末尾追加：

  ```typescript
  import type { ResolvedConfig } from "../src/server/config.js";

  describe("resolveConfig", () => {
    it("resolves single mode when no --route-config", () => {
      const origArgv = Bun.argv;
      Bun.argv = ["bun", "run", "src/server/index.ts", "--upstream-api-key", "sk-test"];
      const resolved = resolveConfig();
      expect(resolved.mode).toBe("single");
      expect(resolved.upstream?.apiKey).toBe("sk-test");
      expect(resolved.route).toBeUndefined();
      Bun.argv = origArgv;
    });

    it("resolves route mode when --route-config is provided", () => {
      const tmpFile = `/tmp/test-route-resolve-${Date.now()}.json`;
      const raw = {
        algorithm: "round-robin",
        upstreams: [{ name: "nim", baseUrl: "https://api.nvidia.com/v1", apiKey: "nvapi-xxx" }],
      };
      Bun.write(tmpFile, JSON.stringify(raw));
      const origArgv = Bun.argv;
      Bun.argv = ["bun", "run", "src/server/index.ts", "--route-config", tmpFile];
      const resolved = resolveConfig();
      expect(resolved.mode).toBe("route");
      expect(resolved.route).toBeDefined();
      expect(resolved.route!.algorithm).toBe("round-robin");
      expect(resolved.route!.upstreams.length).toBe(1);
      expect(resolved.route!.upstreams[0].name).toBe("nim");
      expect(resolved.upstream).toBeUndefined();
      Bun.argv = origArgv;
      try { require("fs").unlinkSync(tmpFile); } catch {}
    });

    it("throws when both --route-config and --upstream-api-key are provided", () => {
      const tmpFile = `/tmp/test-route-conflict-${Date.now()}.json`;
      const raw = {
        algorithm: "round-robin",
        upstreams: [{ name: "nim", baseUrl: "https://api.nvidia.com/v1", apiKey: "nvapi-xxx" }],
      };
      Bun.write(tmpFile, JSON.stringify(raw));
      const origArgv = Bun.argv;
      Bun.argv = ["bun", "run", "src/server/index.ts", "--route-config", tmpFile, "--upstream-api-key", "sk-test"];
      expect(() => resolveConfig()).toThrow();
      Bun.argv = origArgv;
      try { require("fs").unlinkSync(tmpFile); } catch {}
    });

    it("single mode config has all fields from original ServerConfig", () => {
      const origArgv = Bun.argv;
      Bun.argv = ["bun", "run", "src/server/index.ts", "--upstream-api-key", "sk-test", "--port", "9090"];
      const resolved = resolveConfig();
      expect(resolved.mode).toBe("single");
      expect(resolved.port).toBe(9090);
      expect(resolved.authToken).toBe("");
      expect(resolved.enableThinking).toBe(true);
      expect(resolved.dumpDir).toBe("");
      expect(resolved.serverTools).toBeDefined();
      Bun.argv = origArgv;
    });
  });
  ```

  同时在文件顶部 import 中添加 `resolveConfig`：
  ```typescript
  import { loadConfig, globMatch, resolveModelExtra, deepMerge, resolveConfig } from "../src/server/config.js";
  ```

- [ ] **步骤 2：运行测试验证失败**

  ```bash
  bun test tests/config.test.ts
  ```
  预期：FAIL，`resolveConfig` 不存在

- [ ] **步骤 3：修改 config.ts 添加 ResolvedConfig 和 resolveConfig**

  在 `src/server/config.ts` 中：

  1. 在文件顶部添加 import：
  ```typescript
  import { loadRouteConfig, validateRouteConfig, normalizeRouteConfig, type NormalizedRouteConfig, type UpstreamConfig, type RouteAlgorithm } from "./route_config.js";
  ```

  2. 在 `ServerConfig` 接口后添加新类型：
  ```typescript
  export interface ResolvedConfig {
    mode: "single" | "route";
    authToken: string;
    port: number;
    enableThinking: boolean;
    dumpDir: string;
    serverTools: ServerToolConfig;
    upstream?: {
      baseUrl: string;
      apiKey: string;
      modelOverrides: ModelOverride[];
    };
    route?: {
      algorithm: RouteAlgorithm;
      upstreams: UpstreamConfig[];
    };
  }
  ```

  3. 在 `parseArgs` 函数的 `getArg` 定义之后添加对 `--route-config` 的读取：
  在 `parseArgs` 函数体开头添加：
  ```typescript
  const routeConfigPath = getArg("route-config", "");
  ```

  4. 在文件末尾 `export const loadConfig = parseArgs;` 之后添加：
  ```typescript
  /** Resolve the full configuration: either single mode (CLI args) or route mode (JSON config). */
  export function resolveConfig(): ResolvedConfig {
    const args = Bun.argv;
    const getArg = (name: string, fallback: string): string => {
      const flag = `--${name}`;
      const idx = args.indexOf(flag);
      if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
      const eqFlag = `${flag}=`;
      const eqArg = args.find((a) => a.startsWith(eqFlag));
      if (eqArg) return eqArg.slice(eqFlag.length);
      return fallback;
    };

    const routeConfigPath = getArg("route-config", "");

    if (routeConfigPath) {
      // Route mode — check mutual exclusivity with single-upstream CLI args
      const hasUpstreamKey = getArg("upstream-api-key", "") !== "";
      const hasUpstreamUrl = getArg("upstream-base-url", "https://api.openai.com/v1") !== "https://api.openai.com/v1";
      if (hasUpstreamKey || hasUpstreamUrl) {
        throw new Error("--route-config is mutually exclusive with --upstream-base-url and --upstream-api-key");
      }

      const routeConfig = loadRouteConfig(routeConfigPath);
      return {
        mode: "route",
        authToken: routeConfig.authToken,
        port: routeConfig.port,
        enableThinking: routeConfig.enableThinking,
        dumpDir: routeConfig.dumpDir,
        serverTools: routeConfig.serverTools,
        route: {
          algorithm: routeConfig.algorithm,
          upstreams: routeConfig.upstreams,
        },
      };
    }

    // Single mode — use existing CLI arg parsing
    const singleConfig = parseArgs();
    return {
      mode: "single",
      authToken: singleConfig.authToken,
      port: singleConfig.port,
      enableThinking: singleConfig.enableThinking,
      dumpDir: singleConfig.dumpDir,
      serverTools: singleConfig.serverTools,
      upstream: {
        baseUrl: singleConfig.upstreamBaseUrl,
        apiKey: singleConfig.upstreamApiKey,
        modelOverrides: singleConfig.modelOverrides,
      },
    };
  }
  ```

  5. 导出 `ResolvedConfig` 类型和 `resolveConfig` 函数。

- [ ] **步骤 4：运行测试验证通过**

  ```bash
  bun test tests/config.test.ts
  ```
  预期：全部 PASS（包括新增的 resolveConfig 测试）

- [ ] **步骤 5：运行全部已有测试确认无回归**

  ```bash
  bun test
  ```
  预期：全部 PASS

- [ ] **步骤 6：Commit**

  ```bash
  git add src/server/config.ts tests/config.test.ts
  git commit -m "feat: add --route-config CLI arg, ResolvedConfig type, and resolveConfig()"
  ```

---

## 任务 5：重构 routes.ts — 统一为 handleMessagesWithUpstream

**文件：**
- 修改：`src/server/routes.ts`

这是最大的改造任务。核心变化：将 `handleMessages` 中的实际请求逻辑提取为 `handleMessagesWithUpstream`，增加 alias 替换和 token-budget 扣减。

- [ ] **步骤 1：添加 SelectedUpstream 接口和 alias 函数**

  在 `src/server/routes.ts` 中，在 `isServerToolCall` 函数之后添加：

  ```typescript
  import type { UpstreamConfig } from "./route_config.js";
  import { Router, type RouteAlgorithm } from "./router.js";

  /** A resolved upstream view used by the unified request handler. */
  export interface SelectedUpstream {
    baseUrl: string;
    apiKey: string;
    modelOverrides: import("./config.js").ModelOverride[];
    aliases: Record<string, string>;
    name: string;
  }

  /** Apply alias mapping: if the requested model matches an alias, return the alias target. */
  export function applyAlias(model: string, aliases: Record<string, string>): string {
    return aliases[model] ?? model;
  }
  ```

- [ ] **步骤 2：修改 buildUpstreamRequest 签名以接受 SelectedUpstream**

  将现有 `buildUpstreamRequest` 函数签名从：
  ```typescript
  function buildUpstreamRequest(requestData: RequestData, apiKey: string, config: ServerConfig): { request: Request; requestBody: string; requestHeaders: Record<string, string> }
  ```
  改为：
  ```typescript
  function buildUpstreamRequest(requestData: RequestData, apiKey: string, upstreamBaseUrl: string, modelOverrides: ModelOverride[]): { request: Request; requestBody: string; requestHeaders: Record<string, string> }
  ```

  函数体中将 `config.upstreamBaseUrl` 改为 `upstreamBaseUrl`，将 `config.modelOverrides` 改为 `modelOverrides`：
  ```typescript
  function buildUpstreamRequest(
    requestData: RequestData,
    apiKey: string,
    upstreamBaseUrl: string,
    modelOverrides: ModelOverride[],
  ): { request: Request; requestBody: string; requestHeaders: Record<string, string> } {
    let body = buildBaseRequestBody(requestData, 4096, ReasoningReplayMode.THINK_TAGS);
    const url = `${upstreamBaseUrl.replace(/\/+$/, "")}/chat/completions`;
    body.stream = true;

    const extra = resolveModelExtra(requestData.model, modelOverrides);
    if (Object.keys(extra).length) {
      body = deepMerge(body, extra);
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    };
    const requestBody = JSON.stringify(body, null, 2);

    const request = new Request(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    return { request, requestBody, requestHeaders: headers };
  }
  ```

- [ ] **步骤 3：同样修改 buildUpstreamRequestBodyOnly 签名**

  从：
  ```typescript
  function buildUpstreamRequestBodyOnly(requestData: RequestData, apiKey: string, config: ServerConfig): { requestBody: string; requestHeaders: Record<string, string> }
  ```
  改为：
  ```typescript
  function buildUpstreamRequestBodyOnly(
    requestData: RequestData,
    apiKey: string,
    upstreamBaseUrl: string,
    modelOverrides: ModelOverride[],
  ): { requestBody: string; requestHeaders: Record<string, string> } {
    let body = buildBaseRequestBody(requestData, 4096, ReasoningReplayMode.THINK_TAGS);
    body.stream = true;

    const extra = resolveModelExtra(requestData.model, modelOverrides);
    if (Object.keys(extra).length) {
      body = deepMerge(body, extra);
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    };

    return { requestBody: JSON.stringify(body), requestHeaders: headers };
  }
  ```

- [ ] **步骤 4：重构 handleMessages 为 handleMessagesWithUpstream**

  将现有 `handleMessages` 函数签名改为：
  ```typescript
  export async function handleMessages(
    request: Request,
    config: import("./config.js").ResolvedConfig,
  ): Promise<Response>
  ```

  函数体核心逻辑：在解析请求后，根据 `config.mode` 决定路由，然后调用 `handleMessagesWithUpstream`。

  完整重写 `handleMessages`：

  ```typescript
  export async function handleMessages(
    request: Request,
    config: import("./config.js").ResolvedConfig,
    router?: Router,
  ): Promise<Response> {
    const dump = createDumpSession(config.dumpDir);
    const requestStartMs = Date.now();
    const requestDatetime = new Date().toISOString();

    // Validate downstream auth token
    if (config.authToken) {
      const clientKey = request.headers.get("x-api-key") || request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
      if (clientKey !== config.authToken) {
        const err = authenticationError("Invalid auth token. Provide correct x-api-key header.");
        dump.finish();
        return Response.json(err.json, { status: err.status });
      }
    }

    // Resolve upstream based on mode
    let selectedUpstream: SelectedUpstream;
    let routeLog: string | undefined;
    let originalModel: string | undefined;

    if (config.mode === "route") {
      if (!router) {
        throw new Error("Router is required in route mode");
      }
      const selected = router.select();
      routeLog = router.formatLog(selected.name);
      console.log(routeLog);
      selectedUpstream = {
        baseUrl: selected.baseUrl,
        apiKey: selected.apiKey,
        modelOverrides: selected.modelOverrides,
        aliases: selected.aliases,
        name: selected.name,
      };
    } else {
      // Single mode
      const singleUpstream = config.upstream!;
      // Passthrough: if no upstream key and no auth token, use client's key
      const isPassthrough = !singleUpstream.apiKey && !config.authToken;
      const clientKey = request.headers.get("x-api-key") || request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
      const resolvedApiKey = isPassthrough && clientKey ? clientKey : singleUpstream.apiKey;

      if (!resolvedApiKey) {
        const err = authenticationError("No API key provided. Set --upstream-api-key or enable passthrough mode (no upstream key and no auth token).");
        dump.finish();
        return Response.json(err.json, { status: err.status });
      }

      selectedUpstream = {
        baseUrl: singleUpstream.baseUrl,
        apiKey: resolvedApiKey,
        modelOverrides: singleUpstream.modelOverrides,
        aliases: {},
        name: "default",
      };
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      const err = invalidRequestError("Invalid JSON in request body.");
      dump.finish();
      return Response.json(err.json, { status: err.status });
    }

    const requestHeaders = extractRequestHeaders(request);
    dump.writeDownstreamRequest({
      headers: requestHeaders,
      datetime: requestDatetime,
      body: JSON.stringify(body, null, 2),
    });

    const parsed = parseMessagesBody(body);
    if ("error" in parsed && parsed.error) {
      dump.finish();
      return Response.json(parsed.error.json, { status: parsed.error.status });
    }

    const requestData = parsed.data;

    // Apply alias: replace model if alias mapping exists for selected upstream
    originalModel = requestData.model;
    requestData.model = applyAlias(requestData.model, selectedUpstream.aliases);

    const inputTokens = estimateInputTokens(requestData.messages);

    // Server tool agentic loop check
    const requestServerTools = extractServerToolsFromRequest(requestData);
    const serverToolsEnabled = config.serverTools.webSearch || config.serverTools.webFetch;

    if (serverToolsEnabled && requestServerTools.length > 0) {
      return await handleServerToolRequest(
        requestData, selectedUpstream, config, dump, requestStartMs,
        requestHeaders, requestDatetime, request.signal, inputTokens,
        originalModel, router, routeLog,
      );
    }

    // --- Standard streaming flow ---
    const abortSignal = request.signal;
    const { request: upstreamReq, requestBody: upstreamRequestBody, requestHeaders: upstreamReqHeaders } =
      buildUpstreamRequest(requestData, selectedUpstream.apiKey, selectedUpstream.baseUrl, selectedUpstream.modelOverrides);

    dump.writeUpstreamRequest({
      headers: upstreamReqHeaders,
      datetime: new Date().toISOString(),
      body: upstreamRequestBody,
    });

    let upstreamRes: Response;
    let ttfb: number | undefined;
    try {
      upstreamRes = await fetch(upstreamReq, { signal: abortSignal });
      ttfb = Date.now() - requestStartMs;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isAbort = abortSignal?.aborted || (e instanceof DOMException && e.name === "AbortError");
      const disconnectTime = new Date().toISOString();
      const termination: DumpTermination = isAbort
        ? { reason: "client_abort", disconnectTime }
        : { reason: "upstream_timeout", disconnectTime };
      dump.writeUpstreamResponse({ headers: {}, status: 0, body: "", termination });
      dump.writeDownstreamResponse({
        headers: {},
        status: isAbort ? 499 : 502,
        body: JSON.stringify(isAbort
          ? upstreamError(`Client disconnected before upstream responded: ${msg}`, 499).json
          : upstreamError(`Failed to connect to upstream: ${msg}`, 502).json),
        termination,
      });
      const err = isAbort
        ? upstreamError(`Client disconnected before upstream responded: ${msg}`, 499)
        : upstreamError(`Failed to connect to upstream: ${msg}`, 502);
      dump.finish();
      return Response.json(err.json, { status: err.status });
    }

    const upstreamHeaders = extractResponseHeaders(upstreamRes);
    const upstreamStatus = upstreamRes.status;

    if (!upstreamRes.ok) {
      const errBody = await upstreamRes.text().catch(() => "");
      const termination: DumpTermination = { reason: "upstream_error", disconnectTime: new Date().toISOString() };
      dump.writeUpstreamResponse({ headers: upstreamHeaders, status: upstreamStatus, body: errBody, termination });
      const mappedStatus = upstreamRes.status >= 500 ? 502 : upstreamRes.status;
      const err = upstreamError(`Upstream returned ${upstreamRes.status}: ${errBody.slice(0, 500)}`, mappedStatus);
      dump.writeDownstreamResponse({ headers: {}, status: mappedStatus, body: JSON.stringify(err.json), termination });
      if (ttfb !== undefined) dump.setTiming({ ttfb, totalTime: Date.now() - requestStartMs });
      dump.finish();
      return Response.json(err.json, { status: err.status });
    }

    const upstreamBody = upstreamRes.body;
    if (!upstreamBody) {
      const termination: DumpTermination = { reason: "upstream_error", disconnectTime: new Date().toISOString() };
      dump.writeUpstreamResponse({ headers: upstreamHeaders, status: upstreamStatus, body: "", termination });
      const err = serverError("Upstream returned empty body.");
      dump.writeDownstreamResponse({ headers: {}, status: 500, body: JSON.stringify(err.json), termination });
      if (ttfb !== undefined) dump.setTiming({ ttfb, totalTime: Date.now() - requestStartMs });
      dump.finish();
      return Response.json(err.json, { status: err.status });
    }

    const reader = upstreamBody.getReader();
    const rawUpstreamChunks: string[] = [];
    const chunks = iterUpstreamChunks(reader, rawUpstreamChunks);
    const sseEvents = streamOpenAIChatToAnthropicSse(
      chunks as AsyncIterable<import("../transport/stream.js").StreamChunk>,
      requestData,
      inputTokens,
      config.enableThinking,
      config.serverTools,
      dump,
    );

    const downstreamChunks: string[] = [];
    let downstreamAborted = false;
    let dumpFinished = false;
    let terminationReason: TerminationReason = "completed";
    let completionTokens = 0;

    function finalizeDump(): void {
      if (dumpFinished) return;
      dumpFinished = true;
      const disconnectTime = terminationReason !== "completed" ? new Date().toISOString() : undefined;
      const termination: DumpTermination = { reason: terminationReason, disconnectTime };
      dump.writeUpstreamResponse({ headers: upstreamHeaders, status: upstreamStatus, body: rawUpstreamChunks.join(""), termination });
      dump.writeDownstreamResponse({ headers: downstreamHeaders, status: 200, body: downstreamChunks.join(""), termination });
      if (ttfb !== undefined) dump.setTiming({ ttfb, totalTime: Date.now() - requestStartMs });
      dump.finish();

      // Token-budget deduction after response completes
      if (router && config.mode === "route") {
        if (completionTokens > 0) {
          router.deduct(selectedUpstream.name, completionTokens);
        }
      }
    }

    const downstreamHeaders: Record<string, string> = {
      "Content-Type": "text/event-stream",
      ...ANTHROPIC_SSE_RESPONSE_HEADERS,
    };

    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        (async () => {
          try {
            try {
              for await (const event of sseEvents) {
                if (downstreamAborted) break;
                downstreamChunks.push(event as string);
                controller.enqueue(encoder.encode(event));
                // Track completion tokens from usage info in SSE events
                // (We track this from the raw upstream chunks instead — see below)
              }
            } catch (e) {
              if (!downstreamAborted) {
                terminationReason = "upstream_abort";
                const msg = e instanceof Error ? e.message : String(e);
                const errLine = `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: msg } })}\n\n`;
                downstreamChunks.push(errLine);
                try { controller.enqueue(encoder.encode(errLine)); } catch { /* stream already closed */ }
              }
            }
          } finally {
            // Extract completion tokens from raw upstream chunks for token-budget deduction
            completionTokens = extractCompletionTokensFromRawChunks(rawUpstreamChunks);
            finalizeDump();
            try { controller.close(); } catch { /* already closed by cancel */ }
          }
        })();
      },
      cancel() {
        downstreamAborted = true;
        terminationReason = "client_abort";
        finalizeDump();
        reader.cancel().catch(() => {});
      },
    });

    return new Response(readable, { status: 200, headers: downstreamHeaders });
  }
  ```

- [ ] **步骤 5：添加 extractCompletionTokensFromRawChunks 辅助函数**

  在 `routes.ts` 的 `handleMessages` 之前添加：

  ```typescript
  /** Extract completion_tokens from raw upstream SSE chunks for token-budget deduction. */
  function extractCompletionTokensFromRawChunks(rawChunks: string[]): number {
    let totalCompletion = 0;
    for (const chunk of rawChunks) {
      const lines = chunk.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6).trim();
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed?.usage?.completion_tokens && typeof parsed.usage.completion_tokens === "number") {
            totalCompletion = parsed.usage.completion_tokens;
          }
        } catch {
          // skip unparseable lines
        }
      }
    }
    return totalCompletion;
  }
  ```

- [ ] **步骤 6：修改 handleServerToolRequest 签名**

  将 `handleServerToolRequest` 的参数从 `apiKey: string, config: ServerConfig` 改为 `selectedUpstream: SelectedUpstream, config: ResolvedConfig`，并在函数体中用 `selectedUpstream.baseUrl`、`selectedUpstream.apiKey`、`selectedUpstream.modelOverrides` 替换原来的 `config.upstreamBaseUrl`、`apiKey`、`config.modelOverrides`。

  签名变为：
  ```typescript
  async function handleServerToolRequest(
    requestData: RequestData,
    selectedUpstream: SelectedUpstream,
    config: import("./config.js").ResolvedConfig,
    dump: ReturnType<typeof createDumpSession>,
    requestStartMs: number,
    requestHeaders: Record<string, string>,
    requestDatetime: string,
    abortSignal: AbortSignal,
    inputTokens: number,
    originalModel: string,
    router?: Router,
    routeLog?: string,
  ): Promise<Response>
  ```

  在函数体中：
  - `buildUpstreamRequestBodyOnly` 调用改为 `buildUpstreamRequestBodyOnly(requestData, selectedUpstream.apiKey, selectedUpstream.baseUrl, selectedUpstream.modelOverrides)`
  - `upstreamUrl` 改为 `${selectedUpstream.baseUrl.replace(/\/+$/, "")}/chat/completions`
  - `upstreamHeadersObj` 中 `Authorization` 改为 `Bearer ${selectedUpstream.apiKey}`

- [ ] **步骤 7：修改 routeRequest 签名**

  ```typescript
  export async function routeRequest(request: Request, config: import("./config.js").ResolvedConfig, router?: Router): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ status: "ok" });
    }

    if (url.pathname === "/v1/messages" && request.method === "POST") {
      return handleMessages(request, config, router);
    }

    return Response.json({ type: "error", error: { type: "not_found_error", message: `No route for ${request.method} ${url.pathname}` } }, { status: 404 });
  }
  ```

- [ ] **步骤 8：删除旧的 isPassthroughMode 和 resolveApiKey 函数**

  从 `routes.ts` 中删除以下两个函数（逻辑已内联到 `handleMessages` 中）：
  - `isPassthroughMode(config: ServerConfig): boolean`
  - `resolveApiKey(request: Request, config: ServerConfig): string | null`

- [ ] **步骤 9：更新 import**

  确保 `routes.ts` 顶部 import 包含：
  ```typescript
  import type { ResolvedConfig } from "./config.js";
  import type { UpstreamConfig } from "./route_config.js";
  import { Router, type RouteAlgorithm } from "./router.js";
  ```
  移除 `import type { ServerConfig, ServerToolConfig } from "./config.js";` 中的 `ServerConfig`（不再使用），保留 `ServerToolConfig`。

- [ ] **步骤 10：运行全部测试**

  ```bash
  bun test
  ```
  预期：需要更新 `tests/routes.test.ts` 中的 `ServerConfig` 为 `ResolvedConfig`（下一个任务处理）

- [ ] **步骤 11：暂时修复 routes.test.ts 使测试通过**

  更新 `tests/routes.test.ts` 中的 `TEST_CONFIG` 为 `ResolvedConfig` 格式：

  ```typescript
  import type { ResolvedConfig } from "../src/server/config.js";

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
  ```

  更新所有测试用例中使用 `ServerConfig` 的地方为 `ResolvedConfig` 格式。

- [ ] **步骤 12：运行全部测试确认通过**

  ```bash
  bun test
  ```
  预期：全部 PASS

- [ ] **步骤 13：Commit**

  ```bash
  git add src/server/routes.ts tests/routes.test.ts
  git commit -m "refactor: unify handleMessages to use SelectedUpstream, add alias and token-budget deduction"
  ```

---

## 任务 6：更新 index.ts — 支持 route 模式启动

**文件：**
- 修改：`src/server/index.ts`

- [ ] **步骤 1：修改 index.ts 使用 ResolvedConfig 和 Router**

  重写 `src/server/index.ts`：

  ```typescript
  /** Bun.serve() entry point for chat-to-claude-code. */

  import { resolveConfig, type ResolvedConfig } from "./config.js";
  import { routeRequest } from "./routes.js";
  import { Router } from "./router.js";

  const config = resolveConfig();

  // Create router for route mode
  let router: Router | undefined;
  if (config.mode === "route" && config.route) {
    router = new Router(config.route.algorithm, config.route.upstreams);
  }

  const server = Bun.serve({
    port: config.port,
    idleTimeout: 0,
    async fetch(request: Request): Promise<Response> {
      // CORS preflight
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, anthropic-version",
            "Access-Control-Max-Age": "86400",
          },
        });
      }

      const response = await routeRequest(request, config, router);
      response.headers.set("Access-Control-Allow-Origin", "*");
      return response;
    },
  });

  // Startup display
  console.log(`chat-to-claude-code listening on http://localhost:${server.port}`);
  console.log(`  Mode: ${config.mode}`);

  if (config.mode === "single" && config.upstream) {
    console.log(`  Upstream: ${config.upstream.baseUrl}`);
    console.log(`  Upstream API key: ${config.upstream.apiKey ? "configured" : "not set"}`);
    const passthrough = !config.upstream.apiKey && !config.authToken;
    console.log(`  Passthrough mode: ${passthrough}`);
  } else if (config.mode === "route" && config.route) {
    console.log(`  Algorithm: ${config.route.algorithm}`);
    console.log(`  Upstreams:`);
    for (const u of config.route.upstreams) {
      const parts = [`name=${u.name}`, `url=${u.baseUrl}`, `key=${u.apiKey ? "configured" : "not set"}`];
      if (config.route.algorithm === "weighted" || u.weight !== 1) {
        parts.push(`weight=${u.weight}`);
      }
      if (config.route.algorithm === "token-budget" && u.tokenBudget > 0) {
        parts.push(`budget=${u.tokenBudget}`);
      }
      const aliasCount = Object.keys(u.aliases).length;
      if (aliasCount > 0) {
        parts.push(`aliases=${aliasCount}`);
      }
      console.log(`    ${parts.join(", ")}`);
    }
  }

  console.log(`  Auth token: ${config.authToken ? "configured" : "not set"}`);
  console.log(`  Thinking: ${config.enableThinking}`);
  console.log(`  Dump: ${config.dumpDir || "disabled"}`);
  if (config.mode === "single" && config.upstream?.modelOverrides.length) {
    console.log(`  Model overrides:`);
    for (const entry of config.upstream.modelOverrides) {
      console.log(`    ${entry.pattern} -> ${JSON.stringify(entry.extra)}`);
    }
  }
  console.log(`  Web Search: ${config.serverTools.webSearch}`);
  console.log(`  Web Fetch: ${config.serverTools.webFetch}`);
  if (config.serverTools.webSearch) {
    console.log(`    Search engine: ${config.serverTools.webSearchEngine}`);
    console.log(`    Search base URL: ${config.serverTools.webSearchBaseUrl}`);
    console.log(`    Search API key: ${config.serverTools.webSearchApiKey ? "configured" : "not set"}`);
  }
  if (config.serverTools.webFetch) {
    if (config.serverTools.webFetchAllowedDomains.length) {
      console.log(`    Allowed domains: ${config.serverTools.webFetchAllowedDomains.join(", ")}`);
    }
    if (config.serverTools.webFetchBlockedDomains.length) {
      console.log(`    Blocked domains: ${config.serverTools.webFetchBlockedDomains.join(", ")}`);
    }
    console.log(`    Max content tokens: ${config.serverTools.webFetchMaxContentTokens}`);
  }
  ```

- [ ] **步骤 2：运行全部测试确认无回归**

  ```bash
  bun test
  ```
  预期：全部 PASS

- [ ] **步骤 3：Commit**

  ```bash
  git add src/server/index.ts
  git commit -m "feat: update server entry to support route mode with Router instance"
  ```

---

## 任务 7：Route 模式集成测试

**文件：**
- 修改：`tests/routes.test.ts`

- [ ] **步骤 1：添加 route 模式测试用例**

  在 `tests/routes.test.ts` 末尾追加：

  ```typescript
  import type { UpstreamConfig } from "../src/server/route_config.js";
  import { Router } from "../src/server/router.js";
  import { applyAlias } from "../src/server/routes.js";

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
  ```

  同时更新顶部 import：
  ```typescript
  import { routeRequest, applyAlias } from "../src/server/routes.js";
  import type { ResolvedConfig } from "../src/server/config.js";
  ```

- [ ] **步骤 2：运行测试验证通过**

  ```bash
  bun test tests/routes.test.ts
  ```
  预期：全部 PASS

- [ ] **步骤 3：运行全部测试确认无回归**

  ```bash
  bun test
  ```
  预期：全部 PASS

- [ ] **步骤 4：Commit**

  ```bash
  git add tests/routes.test.ts
  git commit -m "test: add route mode integration tests and applyAlias tests"
  ```

---

## 任务 8：更新 README 文档

**文件：**
- 修改：`README.md`
- 修改：`README-zh.md`

- [ ] **步骤 1：在 README.md 的 CLI Arguments Reference 之前添加 Route Mode 章节**

  在 `### Passthrough Mode` 之前添加：

  ````markdown
  ### Route Mode (Multi-Upstream)

  Use `--route-config <path>` to activate route mode with a JSON configuration file. This enables multiple upstream endpoints with a configurable routing algorithm. When `--route-config` is set, `--upstream-base-url` and `--upstream-api-key` are not allowed (mutually exclusive).

  #### Configuration File

  ```json
  {
    "port": 8082,
    "authToken": "my-secret",
    "enableThinking": true,
    "dumpDir": "",
    "algorithm": "round-robin",
    "upstreams": [
      {
        "name": "nim",
        "baseUrl": "https://integrate.api.nvidia.com/v1",
        "apiKey": "nvapi-xxxx",
        "weight": 1,
        "tokenBudget": 100000,
        "aliases": {
          "claude-sonnet-4": "deepseek-v4-pro",
          "claude-opus-4": "deepseek-v4-pro"
        },
        "modelOverrides": [
          { "pattern": "deepseek*", "extra": { "reasoning_effort": "high" } }
        ]
      },
      {
        "name": "openrouter",
        "baseUrl": "https://openrouter.ai/api/v1",
        "apiKey": "sk-or-xxxx",
        "weight": 2,
        "tokenBudget": 50000,
        "aliases": {},
        "modelOverrides": []
      }
    ],
    "serverTools": {
      "webSearch": false,
      "webFetch": false
    }
  }
  ```

  #### Routing Algorithms

  | Algorithm | Description |
  |-----------|-------------|
  | `round-robin` | Cycles through upstreams in order (default) |
  | `token-budget` | Selects the upstream with the highest remaining token budget |
  | `weighted` | Weighted round-robin; distributes requests by weight ratio |

  **Token Budget:** Each upstream can set `tokenBudget` (default: 0 = unlimited). After each request completes, the response's `usage.completion_tokens` is deducted from the upstream's remaining budget. When all upstreams are depleted, falls back to round-robin.

  **Weighted:** Uses smooth Weighted Round Robin. With weights `[1, 2]`, the request pattern is `b → a → b` (1:2 ratio).

  **Route Logging:** Each request logs the routing decision:
  ```
  [route] algorithm=round-robin selected=nim | nim:5 openrouter:3
  [route] algorithm=token-budget selected=openrouter | nim:45000/100000 openrouter:48000/50000
  [route] algorithm=weighted selected=openrouter | nim:2/1 openrouter:4/2
  ```

  #### Model Aliases

  Each upstream can define `aliases` — a mapping from the model name in the request to the actual model name sent upstream. This lets clients use familiar model names (e.g. `claude-sonnet-4`) while the proxy sends the upstream-specific model name (e.g. `deepseek-v4-pro`).

  ```json
  {
    "name": "nim",
    "aliases": {
      "claude-sonnet-4": "deepseek-v4-pro"
    }
  }
  ```

  When a request with `model: "claude-sonnet-4"` is routed to the `nim` upstream, the proxy sends `model: "deepseek-v4-pro"` to the upstream. The downstream response retains the original model name.

  #### Route Mode Notes

  - **No passthrough:** Every upstream must have `apiKey` configured. There is no passthrough mode in route mode.
  - **Downstream auth:** `authToken` is global (not per-upstream). When set, all clients must provide a matching key.
  - **Per-upstream model overrides:** Each upstream can have its own `modelOverrides` (same format as `--upstream-extra-params`).
  ````

- [ ] **步骤 2：在 CLI Arguments Reference 表格中添加 `--route-config` 行**

  在表格中添加：

  | Argument | Default | Description |
  |----------|---------|-------------|
  | `--route-config` | — | Path to JSON route configuration file; activates route mode (mutually exclusive with `--upstream-base-url`/`--upstream-api-key`) |

- [ ] **步骤 3：同步更新 README-zh.md**

  在 `README-zh.md` 中添加相同的 Route Mode 章节的中文版本。

- [ ] **步骤 4：Commit**

  ```bash
  git add README.md README-zh.md
  git commit -m "docs: add route mode documentation with algorithms, aliases, and config format"
  ```

---

## 任务 9：最终验证

- [ ] **步骤 1：运行全部测试**

  ```bash
  bun test
  ```
  预期：全部 PASS

- [ ] **步骤 2：TypeScript 类型检查**

  ```bash
  bunx tsc --noEmit
  ```
  预期：无错误

- [ ] **步骤 3：手动验证 single 模式向后兼容**

  ```bash
  bun run src/server/index.ts --upstream-base-url http://localhost:11434/v1 --port 8082 &
  # Wait for startup, check output shows "Mode: single"
  curl http://localhost:8082/health
  # Expect: {"status":"ok"}
  kill %1
  ```

- [ ] **步骤 4：手动验证 route 模式启动**

  创建临时配置文件：
  ```bash
  cat > /tmp/test-route.json << 'EOF'
  {
    "algorithm": "round-robin",
    "upstreams": [
      { "name": "ollama", "baseUrl": "http://localhost:11434/v1", "apiKey": "dummy" }
    ]
  }
  EOF
  bun run src/server/index.ts --route-config /tmp/test-route.json --port 8083 &
  # Check output shows "Mode: route" and "Algorithm: round-robin"
  curl http://localhost:8083/health
  # Expect: {"status":"ok"}
  kill %1
  ```

- [ ] **步骤 5：Final commit**

  如果有任何修复：
  ```bash
  git add -A
  git commit -m "fix: final adjustments for route mode integration"
  ```

  如果一切正常，跳过此步。
