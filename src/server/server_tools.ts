/** Proxy-side execution of Anthropic server tools (web_search, web_fetch). */

import { randomUUID } from "crypto";
import type { ServerToolConfig } from "./config.js";
import type { ServerToolLogEntry } from "../core/dump.js";

export type ServerToolLogFn = (entry: ServerToolLogEntry) => void;

export interface WebSearchResult {
  url: string;
  title: string;
  snippet?: string;
  page_age?: string;
}

export interface WebFetchResult {
  content: string;
  url: string;
  status_code: number;
  title?: string;
}

/** Check if a request's server_tools includes web_search. */
export function requestHasWebSearch(serverTools: Record<string, unknown>[] | null | undefined): boolean {
  if (!serverTools) return false;
  return serverTools.some((t) => {
    const type = t.type as string;
    return type === "web_search" || type?.startsWith("web_search_");
  });
}

/** Check if a request's server_tools includes web_fetch. */
export function requestHasWebFetch(serverTools: Record<string, unknown>[] | null | undefined): boolean {
  if (!serverTools) return false;
  return serverTools.some((t) => {
    const type = t.type as string;
    return type === "web_fetch" || type?.startsWith("web_fetch_");
  });
}

/** Check if the upstream model response contains a server_tool_use for web_search/web_fetch. */
export function isServerToolUseCall(name: string): name is "web_search" | "web_fetch" {
  return name === "web_search" || name === "web_fetch";
}

/** Execute a web search using Brave Search API or SearXNG. */
export async function executeWebSearch(
  query: string,
  config: ServerToolConfig,
  onLog?: ServerToolLogFn,
): Promise<WebSearchResult[]> {
  const baseUrl = config.webSearchBaseUrl.replace(/\/+$/, "");
  const apiKey = config.webSearchApiKey;
  const engine = config.webSearchEngine;

  if (!query.trim()) {
    onLog?.({ tool: "web_search", timestamp: new Date().toISOString(), input: query, engine, skipped: true, skipReason: "empty query" });
    return [];
  }

  const startMs = Date.now();

  try {
    let results: Array<Record<string, unknown>>;

    if (engine === "searxng") {
      // SearXNG: GET /search?q=...&format=json
      const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json`;
      const headers: Record<string, string> = {
        "Accept": "application/json",
      };
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }
      onLog?.({ tool: "web_search", timestamp: new Date().toISOString(), input: query, engine: "searxng" });
      const res = await fetch(url, { headers });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        console.warn(`SearXNG search API returned ${res.status}: ${errBody}`);
        onLog?.({ tool: "web_search", timestamp: new Date().toISOString(), input: query, engine: "searxng", status: res.status, error: `HTTP ${res.status}: ${errBody.slice(0, 500)}`, resultCount: 0, durationMs: Date.now() - startMs });
        return [];
      }
      const data = (await res.json()) as Record<string, unknown>;
      const raw = data["results"];
      if (!Array.isArray(raw)) {
        onLog?.({ tool: "web_search", timestamp: new Date().toISOString(), input: query, engine: "searxng", status: res.status, resultCount: 0, durationMs: Date.now() - startMs, error: "Response 'results' field is not an array" });
        return [];
      }
      results = raw;
    } else {
      // Brave Search: GET /res/v1/web/search?q=...&count=10
      if (!apiKey) {
        onLog?.({ tool: "web_search", timestamp: new Date().toISOString(), input: query, engine: "brave", skipped: true, skipReason: "no API key configured" });
        return [];
      }
      const url = `${baseUrl}/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`;
      onLog?.({ tool: "web_search", timestamp: new Date().toISOString(), input: query, engine: "brave" });
      const res = await fetch(url, {
        headers: {
          "Accept": "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": apiKey,
        },
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        console.warn(`Brave search API returned ${res.status}: ${errBody}`);
        onLog?.({ tool: "web_search", timestamp: new Date().toISOString(), input: query, engine: "brave", status: res.status, error: `HTTP ${res.status}: ${errBody.slice(0, 500)}`, resultCount: 0, durationMs: Date.now() - startMs });
        return [];
      }
      const data = (await res.json()) as Record<string, unknown>;
      const web = data["web"] as Record<string, unknown> | undefined;
      const raw = web?.["results"];
      if (!Array.isArray(raw)) {
        onLog?.({ tool: "web_search", timestamp: new Date().toISOString(), input: query, engine: "brave", status: res.status, resultCount: 0, durationMs: Date.now() - startMs, error: "Response web.results field is not an array or missing" });
        return [];
      }
      results = raw;
    }

    const mapped = results.map((r: Record<string, unknown>) => ({
      url: String(r.url ?? ""),
      title: String(r.title ?? ""),
      snippet: r.description ? String(r.description) : undefined,
      page_age: r.page_age ? String(r.page_age) : undefined,
    }));

    onLog?.({ tool: "web_search", timestamp: new Date().toISOString(), input: query, engine, resultCount: mapped.length, durationMs: Date.now() - startMs });
    return mapped;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`Web search failed: ${msg}`);
    onLog?.({ tool: "web_search", timestamp: new Date().toISOString(), input: query, engine, error: msg, resultCount: 0, durationMs: Date.now() - startMs });
    return [];
  }
}

/** Execute a web fetch (HTTP GET) for a URL. */
export async function executeWebFetch(
  url: string,
  config: ServerToolConfig,
  onLog?: ServerToolLogFn,
): Promise<WebFetchResult> {
  const startMs = Date.now();

  // Check domain restrictions
  const parsed = parseDomain(url);
  if (!parsed) {
    onLog?.({ tool: "web_fetch", timestamp: new Date().toISOString(), input: url, status: 400, error: "Invalid URL", durationMs: Date.now() - startMs });
    return { content: "Invalid URL", url, status_code: 400 };
  }

  if (config.webFetchAllowedDomains.length) {
    const allowed = config.webFetchAllowedDomains.some((d) => domainMatches(d, parsed));
    if (!allowed) {
      onLog?.({ tool: "web_fetch", timestamp: new Date().toISOString(), input: url, status: 403, error: `Domain ${parsed} is not in the allowed list`, skipped: true, skipReason: `domain not allowed: ${parsed}`, durationMs: Date.now() - startMs });
      return { content: `Domain ${parsed} is not in the allowed list`, url, status_code: 403 };
    }
  }

  if (config.webFetchBlockedDomains.length) {
    const blocked = config.webFetchBlockedDomains.some((d) => domainMatches(d, parsed));
    if (blocked) {
      onLog?.({ tool: "web_fetch", timestamp: new Date().toISOString(), input: url, status: 403, error: `Domain ${parsed} is blocked`, skipped: true, skipReason: `domain blocked: ${parsed}`, durationMs: Date.now() - startMs });
      return { content: `Domain ${parsed} is blocked`, url, status_code: 403 };
    }
  }

  onLog?.({ tool: "web_fetch", timestamp: new Date().toISOString(), input: url });

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "chat-to-claude-code/1.0 (proxy; +https://github.com/chinfeng/chat-to-claude-code)",
        "Accept": "text/html,application/json,text/plain,text/markdown",
      },
      redirect: "follow",
    });

    const contentType = res.headers.get("content-type") || "";
    const body = await res.text();

    // For HTML, strip tags to get plain text (simple approach)
    let content = body;
    if (contentType.includes("text/html")) {
      content = htmlToPlainText(body);
    }

    // Truncate to approximate token limit (chars / 4)
    const maxChars = config.webFetchMaxContentTokens * 4;
    if (content.length > maxChars) {
      content = content.slice(0, maxChars) + "\n\n[Content truncated]";
    }

    onLog?.({ tool: "web_fetch", timestamp: new Date().toISOString(), input: url, status: res.status, durationMs: Date.now() - startMs });

    return {
      content,
      url: res.url || url,
      status_code: res.status,
      title: extractTitle(body, contentType),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    onLog?.({ tool: "web_fetch", timestamp: new Date().toISOString(), input: url, status: 502, error: `Fetch failed: ${msg}`, durationMs: Date.now() - startMs });
    return { content: `Fetch failed: ${msg}`, url, status_code: 502 };
  }
}

/** Parse domain from a URL. */
function parseDomain(url: string): string | null {
  try {
    const u = new URL(url);
    return u.hostname;
  } catch {
    return null;
  }
}

/** Check if a domain matches a pattern (supports wildcards). */
function domainMatches(pattern: string, domain: string): boolean {
  if (pattern === domain) return true;
  // Support *.example.com pattern
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    return domain === suffix || domain.endsWith("." + suffix);
  }
  return false;
}

/** Crude HTML-to-plain-text conversion for fetch results. */
function htmlToPlainText(html: string): string {
  let text = html;
  // Remove scripts and styles
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  // Convert block elements to newlines
  text = text.replace(/<\/?(p|div|br|h[1-6]|li|tr|td|th)[^>]*>/gi, "\n");
  // Remove all remaining tags
  text = text.replace(/<[^>]+>/g, "");
  // Decode common HTML entities
  text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return text;
}

/** Extract title from HTML or markdown content. */
function extractTitle(body: string, contentType: string): string | undefined {
  if (contentType.includes("text/html")) {
    const match = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (match) {
      return match[1].replace(/<[^>]+>/g, "").trim();
    }
  }
  if (contentType.includes("text/markdown")) {
    const match = body.match(/^#\s+(.+)$/m);
    if (match) return match[1].trim();
  }
  return undefined;
}

/** Format web search results into Anthropic web_search_tool_result content blocks. */
export function formatWebSearchResultContent(
  results: WebSearchResult[],
): Record<string, unknown>[] {
  return results.map((r) => ({
    type: "web_search_result",
    url: r.url,
    title: r.title,
    ...(r.snippet ? { snippet: r.snippet } : {}),
    ...(r.page_age ? { page_age: r.page_age } : {}),
  }));
}

/** Format web fetch result into Anthropic web_fetch_tool_result content blocks. */
export function formatWebFetchResultContent(
  result: WebFetchResult,
): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  if (result.title) {
    blocks.push({ type: "text", text: `Title: ${result.title}` });
  }
  blocks.push({ type: "text", text: `URL: ${result.url}` });
  if (result.status_code >= 400) {
    blocks.push({ type: "text", text: `Status: ${result.status_code}` });
  }
  blocks.push({ type: "text", text: result.content });
  return blocks;
}

/** Detect web_search or web_fetch tool calls in upstream text output. */
export function detectServerToolInText(
  text: string,
): { type: "web_search" | "web_fetch"; input: Record<string, unknown> } | null {
  // Match patterns like: WebSearch {"query": "..."} or WebFetch {"url": "..."}
  const searchMatch = text.match(/\bWebSearch\s*\{[^}]*"query"\s*:\s*"[^"]*"[^}]*\}/i);
  if (searchMatch) {
    try {
      const jsonStr = searchMatch[0].replace(/^\s*WebSearch\s*/i, "");
      const input = JSON.parse(jsonStr);
      if (input.query) return { type: "web_search", input };
    } catch {}
  }

  const fetchMatch = text.match(/\bWebFetch\s*\{[^}]*"url"\s*:\s*"[^"]*"[^}]*\}/i);
  if (fetchMatch) {
    try {
      const jsonStr = fetchMatch[0].replace(/^\s*WebFetch\s*/i, "");
      const input = JSON.parse(jsonStr);
      if (input.url) return { type: "web_fetch", input };
    } catch {}
  }

  return null;
}
