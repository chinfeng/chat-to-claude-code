/** Bun.serve() entry point for free-claude-code. */

import { loadConfig } from "./config.js";
import { routeRequest } from "./routes.js";

const config = loadConfig();

const server = Bun.serve({
  port: config.port,
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

console.log(`free-claude-code (Bun) listening on http://localhost:${server.port}`);
console.log(`  Upstream: ${config.upstreamBaseUrl}`);
console.log(`  API key passthrough: ${config.enableApiKeyPassthrough}`);
console.log(`  Thinking: ${config.enableThinking}`);
