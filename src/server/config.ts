/** Environment-variable-based server configuration. */

export interface ServerConfig {
  upstreamBaseUrl: string;
  apiKey: string;
  enableApiKeyPassthrough: boolean;
  port: number;
  enableThinking: boolean;
  defaultModel: string;
}

export function loadConfig(): ServerConfig {
  return {
    upstreamBaseUrl: process.env.UPSTREAM_BASE_URL || "https://api.openai.com/v1",
    apiKey: process.env.API_KEY || "",
    enableApiKeyPassthrough: process.env.ENABLE_API_KEY_PASSTHROUGH !== "false",
    port: parseInt(process.env.PORT || "8082", 10),
    enableThinking: process.env.ENABLE_THINKING !== "false",
    defaultModel: process.env.DEFAULT_MODEL || "gpt-4o",
  };
}
