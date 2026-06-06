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
      const budget =
        this.states[i].totalBudget === 0
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
    const totalWeight = this.states.reduce(
      (sum, s) => sum + s.effectiveWeight,
      0,
    );
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
