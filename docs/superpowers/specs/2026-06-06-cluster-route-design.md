---
name: cluster-route-design
description: Design spec for cluster/route feature — multi-upstream with routing algorithms
---

# Cluster Route Feature Design

## Overview

Add a route mode to chat-to-claude-code that supports multiple upstream endpoints with configurable routing algorithms. The existing single-upstream mode is internally refactored as a special case of the route mode (round-robin with 1 upstream), ensuring a single code path for request handling.

## Configuration

### JSON Config File (`--route-config <path>`)

New CLI argument `--route-config` accepts a path to a JSON configuration file. When present, route mode is activated; otherwise, the existing single-upstream CLI argument mode is used (backward compatible). The two modes are mutually exclusive.

### Config File Schema

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
        "claude-sonnet-4": "deepseek-v4-pro"
      },
      "modelOverrides": [
        { "pattern": "deepseek*", "extra": { "reasoning_effort": "high" } }
      ]
    }
  ],
  "serverTools": {
    "webSearch": false,
    "webFetch": false,
    "webSearchEngine": "brave",
    "webSearchApiKey": "",
    "webSearchBaseUrl": "https://api.search.brave.com",
    "webFetchAllowedDomains": [],
    "webFetchBlockedDomains": [],
    "webFetchMaxContentTokens": 5000
  }
}
```

### Field Descriptions

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `port` | no | 8082 | HTTP listen port |
| `authToken` | no | "" | Global downstream auth token; empty = no auth |
| `enableThinking` | no | true | Convert reasoning to thinking blocks |
| `dumpDir` | no | "" | Request dump directory |
| `algorithm` | no | "round-robin" | Routing algorithm: `round-robin`, `token-budget`, `weighted` |
| `upstreams` | yes | - | Array of upstream configs; must have ≥1 entry |
| `upstreams[].name` | yes | - | Unique upstream identifier for logging |
| `upstreams[].baseUrl` | yes | - | Upstream OpenAI Chat Completions endpoint URL |
| `upstreams[].apiKey` | yes | - | Upstream API key (required in route mode) |
| `upstreams[].weight` | no | 1 | Weight for `weighted` algorithm |
| `upstreams[].tokenBudget` | no | 0 | Token budget cap for `token-budget` algorithm; 0 = unlimited |
| `upstreams[].aliases` | no | {} | Model name alias mapping: requested model → actual model sent upstream |
| `upstreams[].modelOverrides` | no | [] | Same as `--upstream-extra-params`, per-upstream |
| `serverTools` | no | (defaults) | Server tool configuration (same as CLI args) |

### Auth

- Route mode: **no passthrough**. Every upstream must have `apiKey` configured. Downstream `authToken` is optional (global, not per-upstream).
- Single mode: existing behavior unchanged (passthrough when both upstream key and auth token are unset).

## Routing Algorithms

### 1. Round-Robin (`round-robin`)

- Maintains a global incrementing counter.
- Each request: `selected = upstreams[counter % upstreams.length]`, counter++.
- Weight, tokenBudget fields are ignored.

### 2. Token Budget (`token-budget`)

- Each request: selects the upstream with the highest `remainingBudget`.
- After response completes, deducts `usage.completion_tokens` from `remainingBudget`.
- If upstream doesn't return `usage`, estimate output tokens via char/4 heuristic.
- If all upstreams have `remainingBudget == 0`, falls back to round-robin (no request rejection).
- `tokenBudget: 0` or unset means unlimited — that upstream is always preferred until others catch up.

### 3. Weighted (`weighted`)

- Uses **Weighted Round Robin** (smooth WRR) algorithm:
  - Each upstream has `currentWeight` and `effectiveWeight` (initialized to configured weight).
  - Per selection: `currentWeight += effectiveWeight` for all; pick highest `currentWeight`; winner's `currentWeight -= totalWeight`.
  - Guarantees long-run request ratio strictly equals weight ratio.
- Default weight is 1; unset = equal weight for all.

### Route Log

After each routing decision, one log line is emitted:

```
[route] algorithm=round-robin selected=nim | nim:5 openrouter:3
[route] algorithm=token-budget selected=openrouter | nim:45000/100000 openrouter:48000/50000
[route] algorithm=weighted selected=openrouter | nim:2/1 openrouter:4/2
```

- **round-robin**: per-upstream cumulative request count
- **token-budget**: per-upstream `remaining/total` budget
- **weighted**: per-upstream `cumulative_requests/weight`

## Alias Mechanism

1. Request arrives, `requestData.model` is parsed (e.g. `"claude-sonnet-4"`).
2. Router selects an upstream (e.g. `nim`).
3. Check selected upstream's `aliases`: if model matches an alias key, replace with alias value (e.g. `"deepseek-v4-pro"`).
4. Replaced model is used in the upstream request body.
5. **Downstream response model field retains the original value** — no reverse alias.
6. Alias does **not** affect routing selection — routing uses the original model.

## Unified Request Handling

### Internal Config Structure

```typescript
interface ResolvedConfig {
  mode: "single" | "route";
  authToken: string;
  port: number;
  enableThinking: boolean;
  dumpDir: string;
  serverTools: ServerToolConfig;
  // single mode
  upstream?: { baseUrl: string; apiKey: string; modelOverrides: ModelOverride[] };
  // route mode
  route?: { algorithm: RouteAlgorithm; upstreams: UpstreamConfig[] };
}
```

### SelectedUpstream View

```typescript
interface SelectedUpstream {
  baseUrl: string;
  apiKey: string;
  modelOverrides: ModelOverride[];
  aliases: Record<string, string>;
  name: string;
}
```

Single mode auto-constructs a `SelectedUpstream` with `aliases: {}` and `name: "default"`.

### Unified Handler

`handleMessages` delegates to `handleMessagesWithUpstream(request, resolvedConfig, selectedUpstream, routeLog?)` which contains all the actual request logic. Single mode passes `routeLog=undefined` (no route logging).

### Passthrough Compatibility

- Single mode passthrough logic preserved unchanged.
- Route mode has no passthrough — apiKey is always from the selected upstream's config.

## Branch & Commit Strategy

- Branch from `feature/route` (create from `master` if not exists).
- Small incremental commits:
  1. Add route config types and JSON loader
  2. Add `--route-config` CLI argument and config resolution
  3. Implement router (3 algorithms + route log)
  4. Refactor `handleMessages` to use `handleMessagesWithUpstream`
  5. Add alias mechanism
  6. Add route-specific tests
  7. Update README documentation

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/server/route_config.ts` | Create | JSON config types, loader, validation |
| `src/server/router.ts` | Create | Router class with 3 algorithms + state + logging |
| `src/server/config.ts` | Modify | Add `--route-config` arg, `ResolvedConfig` type, resolution logic |
| `src/server/routes.ts` | Modify | Refactor to `handleMessagesWithUpstream`, add alias, add token-budget deduction |
| `src/server/index.ts` | Modify | Support route mode startup display |
| `tests/route_config.test.ts` | Create | Config loading & validation tests |
| `tests/router.test.ts` | Create | Algorithm & route log tests |
| `tests/routes.test.ts` | Modify | Add route mode route handling tests |
| `README.md` | Modify | Add route mode documentation |
| `README-zh.md` | Modify | Add route mode documentation (Chinese) |
