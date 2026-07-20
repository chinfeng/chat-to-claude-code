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

/** Deep merge `source` into `target`. Arrays are replaced, not concatenated.
 *
 * Meta-operation keys (prefixed with `$`) are handled specially:
 * - `$delete: string[]` — remove properties at the given dot-notation paths
 *   (relative to the current merge level) after merging.
 * - `$default: Record<string, unknown>` — set values only for paths that are
 *   missing (`undefined`) in the target; existing values are left untouched.
 *
 * Processing order: regular merge → $default → $delete */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  // --- separate meta keys from regular data keys ---
  const deletePaths: string[] = [];
  const defaults: Record<string, unknown> = {};
  const sourceData: Record<string, unknown> = {};

  for (const key of Object.keys(source)) {
    if (key === "$delete") {
      const val = source[key];
      if (Array.isArray(val)) {
        for (const item of val) {
          if (typeof item === "string") deletePaths.push(item);
        }
      }
    } else if (key === "$default") {
      const val = source[key];
      if (val !== null && typeof val === "object" && !Array.isArray(val)) {
        Object.assign(defaults, val as Record<string, unknown>);
      }
    } else {
      sourceData[key] = source[key];
    }
  }

  // --- step 1: regular deep merge (sourceData only, no meta keys) ---
  const result = { ...target };
  for (const key of Object.keys(sourceData)) {
    const sv = sourceData[key];
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

  // --- step 2: $default — only set paths that don't exist yet ---
  for (const [path, value] of Object.entries(defaults)) {
    if (pathGet(result, path) === undefined) {
      pathSet(result, path, value);
    }
  }

  // --- step 3: $delete — remove specified paths ---
  for (const path of deletePaths) {
    pathDelete(result, path);
  }

  return result;
}

// ---- dot-notation path helpers (operate on plain objects only) ----

/** Read a value at a dot-notation path. Returns `undefined` when any segment
 * is missing or the path traverses through a non-object. */
function pathGet(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split(".");
  let cur: unknown = obj;
  for (const key of keys) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Set a value at a dot-notation path, creating intermediate objects as
 * needed. Existing non-object values along the path are overwritten with an
 * empty object so the path can be completed. */
function pathSet(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const keys = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    const next = cur[k];
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      cur[k] = {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
}

/** Delete the value at a dot-notation path. Silently no-ops if any segment
 * along the path is missing or is not a plain object. */
function pathDelete(obj: Record<string, unknown>, path: string): void {
  const keys = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const next = cur[keys[i]];
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      return;
    }
    cur = next as Record<string, unknown>;
  }
  delete cur[keys[keys.length - 1]];
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
