/** Bun.serve() entry point for chat-to-claude-code. */

import { loadConfig } from "./config.js";
import { routeRequest } from "./routes.js";

const config = loadConfig();

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

    const response = await routeRequest(request, config);

    // Add CORS headers to all responses
    response.headers.set("Access-Control-Allow-Origin", "*");
    return response;
  },
});

const passthrough = !config.upstreamApiKey && !config.authToken;
console.log(`chat-to-claude-code listening on http://localhost:${server.port}`);
console.log(`  Upstream: ${config.upstreamBaseUrl}`);
console.log(`  Upstream API key: ${config.upstreamApiKey ? "configured" : "not set"}`);
console.log(`  Auth token: ${config.authToken ? "configured" : "not set"}`);
console.log(`  Passthrough mode: ${passthrough}`);
console.log(`  Thinking: ${config.enableThinking}`);
console.log(`  Dump: ${config.dumpDir || "disabled"}`);
if (config.modelOverrides.length) {
  console.log(`  Model overrides:`);
  for (const entry of config.modelOverrides) {
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
