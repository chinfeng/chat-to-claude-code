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
  idleTimeout: 0, // Disable idle timeout to allow long-running requests
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

    // Add CORS headers to all responses
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
