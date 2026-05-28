/** CLI-argument-based server configuration. */

export interface ModelOverride {
  pattern: string;
  extra: Record<string, unknown>;
}

export type WebSearchEngine = "brave" | "searxng";

export interface ServerToolConfig {
  webSearch: boolean;
  webFetch: boolean;
  webSearchEngine: WebSearchEngine;
  webSearchApiKey: string;
  webSearchBaseUrl: string;
  webFetchAllowedDomains: string[];
  webFetchBlockedDomains: string[];
  webFetchMaxContentTokens: number;
}

export interface ServerConfig {
  upstreamBaseUrl: string;
  upstreamApiKey: string;
  authToken: string;
  port: number;
  enableThinking: boolean;
  dumpDir: string;
  modelOverrides: ModelOverride[];
  serverTools: ServerToolConfig;
}

/** Minimal glob matching: supports `*` (any segment chars) and `?` (single char). */
export function globMatch(pattern: string, text: string): boolean {
  const re = new RegExp(
    "^" +
    pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".") +
    "$",
  );
  return re.test(text);
}

/** Select model-specific extra params by matching the model name against glob patterns.
 * First matching pattern wins; returns `{}` if nothing matches. */
export function resolveModelExtra(
  model: string,
  overrides: ModelOverride[] | undefined,
): Record<string, unknown> {
  if (!overrides) return {};
  for (const entry of overrides) {
    if (globMatch(entry.pattern, model)) return entry.extra;
  }
  return {};
}

/** Deep merge `source` into `target`. Arrays are replaced, not concatenated. */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = result[key];
    if (
      sv !== null &&
      typeof sv === "object" &&
      !Array.isArray(sv) &&
      tv !== null &&
      typeof tv === "object" &&
      !Array.isArray(tv)
    ) {
      result[key] = deepMerge(
        tv as Record<string, unknown>,
        sv as Record<string, unknown>,
      );
    } else {
      result[key] = sv;
    }
  }
  return result;
}

function parseArgs(): ServerConfig {
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

  const getBool = (name: string, fallback: boolean): boolean => {
    const flag = `--${name}`;
    if (args.includes(flag)) return true;
    const noFlag = `--no-${name}`;
    if (args.includes(noFlag)) return false;
    const eqFlag = `--${name}=`;
    const eqArg = args.find((a) => a.startsWith(eqFlag));
    if (eqArg) return eqArg.slice(eqFlag.length) !== "false";
    return fallback;
  };

  const getMultiArg = (name: string): string[] => {
    const flag = `--${name}`;
    const eqPrefix = `${flag}=`;
    const results: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === flag && i + 1 < args.length) {
        results.push(args[i + 1]);
      } else if (args[i].startsWith(eqPrefix)) {
        results.push(args[i].slice(eqPrefix.length));
      }
    }
    return results;
  };

  const modelOverrides: ModelOverride[] = [];
  for (const raw of getMultiArg("upstream-extra-params")) {
    const eqIdx = raw.indexOf("=");
    if (eqIdx === -1) {
      console.warn(`Skipping invalid --upstream-extra-params (missing '='): ${raw}`);
      continue;
    }
    const pattern = raw.slice(0, eqIdx).trim();
    const jsonStr = raw.slice(eqIdx + 1).trim();
    let extra: Record<string, unknown>;
    try {
      extra = JSON.parse(jsonStr);
    } catch {
      console.warn(`Skipping --upstream-extra-params with invalid JSON for pattern "${pattern}"`);
      continue;
    }
    if (typeof extra !== "object" || extra === null || Array.isArray(extra)) {
      console.warn(`Skipping --upstream-extra-params: JSON value for "${pattern}" must be an object`);
      continue;
    }
    modelOverrides.push({ pattern, extra });
  }

  const serverTools: ServerToolConfig = {
    webSearch: getBool("enable-web-search", false),
    webFetch: getBool("enable-web-fetch", false),
    webSearchEngine: (getArg("web-search-engine", "brave") as WebSearchEngine),
    webSearchApiKey: getArg("web-search-api-key", ""),
    webSearchBaseUrl: getArg("web-search-base-url", "https://api.search.brave.com"),
    webFetchAllowedDomains: getMultiArg("web-fetch-allowed-domain"),
    webFetchBlockedDomains: getMultiArg("web-fetch-blocked-domain"),
    webFetchMaxContentTokens: parseInt(getArg("web-fetch-max-content-tokens", "5000"), 10),
  };

  return {
    upstreamBaseUrl: getArg("upstream-base-url", "https://api.openai.com/v1"),
    upstreamApiKey: getArg("upstream-api-key", ""),
    authToken: getArg("auth-token", ""),
    port: parseInt(getArg("port", "8082"), 10),
    enableThinking: getBool("enable-thinking", true),
    dumpDir: getArg("dump", ""),
    modelOverrides,
    serverTools,
  };
}

export const loadConfig = parseArgs;
