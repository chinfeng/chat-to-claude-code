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
    throw new Error(
      `Failed to read route config file: ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `Invalid JSON in route config file: ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const config = parsed as RouteConfigFile;
  const validation = validateRouteConfig(config);
  if (!validation.valid) {
    throw new Error(`Invalid route config: ${validation.errors.join("; ")}`);
  }

  return normalizeRouteConfig(config);
}
