/** Proxy-side execution of Anthropic server tools (web_search, web_fetch). */

import { randomUUID } from "crypto";
import type { ServerToolConfig } from "./config.js";
import type { ServerToolLogEntry } from "../core/dump.js";

const MAX_RESPONSE_BODY_LOG = 10000;

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
      const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json`;
      const headers: Record<string, string> = {
        "Accept": "application/json",
      };
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }
      const res = await fetch(url, { headers });
      const resBody = await res.text().catch(() => "");
      const resHeaders = extractResponseHeaders(res);
      if (!res.ok) {
        console.warn(`SearXNG search API returned ${res.status}: ${resBody}`);
        onLog?.({ tool: "web_search", timestamp: new Date().toISOString(), input: query, engine: "searxng", requestUrl: url, requestHeaders: headers, status: res.status, responseHeaders: resHeaders, responseBody: truncate(resBody), error: `HTTP ${res.status}: ${resBody.slice(0, 500)}`, resultCount: 0, durationMs: Date.now() - startMs });
        return [];
      }
      let data: Record<string, unknown>;
      try { data = JSON.parse(resBody); } catch { onLog?.({ tool: "web_search", timestamp: new Date().toISOString(), input: query, engine: "searxng", requestUrl: url, requestHeaders: headers, status: res.status, responseHeaders: resHeaders, responseBody: truncate(resBody), error: "Invalid JSON response", resultCount: 0, durationMs: Date.now() - startMs }); return []; }
      const raw = data["results"];
      if (!Array.isArray(raw)) {
        onLog?.({ tool: "web_search", timestamp: new Date().toISOString(), input: query, engine: "searxng", requestUrl: url, requestHeaders: headers, status: res.status, responseHeaders: resHeaders, responseBody: truncate(resBody), resultCount: 0, durationMs: Date.now() - startMs, error: "Response 'results' field is not an array" });
        return [];
      }
      results = raw;
      onLog?.({ tool: "web_search", timestamp: new Date().toISOString(), input: query, engine: "searxng", requestUrl: url, requestHeaders: headers, status: res.status, responseHeaders: resHeaders, responseBody: truncate(resBody), resultCount: raw.length, durationMs: Date.now() - startMs });
    } else {
      if (!apiKey) {
        onLog?.({ tool: "web_search", timestamp: new Date().toISOString(), input: query, engine: "brave", skipped: true, skipReason: "no API key configured" });
        return [];
      }
      const url = `${baseUrl}/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`;
      const headers: Record<string, string> = {
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      };
      const res = await fetch(url, { headers });
      const resBody = await res.text().catch(() => "");
      const resHeaders = extractResponseHeaders(res);
      if (!res.ok) {
        console.warn(`Brave search API returned ${res.status}: ${resBody}`);
        onLog?.({ tool: "web_search", timestamp: new Date().toISOString(), input: query, engine: "brave", requestUrl: url, requestHeaders: headers, status: res.status, responseHeaders: resHeaders, responseBody: truncate(resBody), error: `HTTP ${res.status}: ${resBody.slice(0, 500)}`, resultCount: 0, durationMs: Date.now() - startMs });
        return [];
      }
      let data: Record<string, unknown>;
      try { data = JSON.parse(resBody); } catch { onLog?.({ tool: "web_search", timestamp: new Date().toISOString(), input: query, engine: "brave", requestUrl: url, requestHeaders: headers, status: res.status, responseHeaders: resHeaders, responseBody: truncate(resBody), error: "Invalid JSON response", resultCount: 0, durationMs: Date.now() - startMs }); return []; }
      const web = data["web"] as Record<string, unknown> | undefined;
      const raw = web?.["results"];
      if (!Array.isArray(raw)) {
        onLog?.({ tool: "web_search", timestamp: new Date().toISOString(), input: query, engine: "brave", requestUrl: url, requestHeaders: headers, status: res.status, responseHeaders: resHeaders, responseBody: truncate(resBody), resultCount: 0, durationMs: Date.now() - startMs, error: "Response web.results field is not an array or missing" });
        return [];
      }
      results = raw;
      onLog?.({ tool: "web_search", timestamp: new Date().toISOString(), input: query, engine: "brave", requestUrl: url, requestHeaders: headers, status: res.status, responseHeaders: resHeaders, responseBody: truncate(resBody), resultCount: raw.length, durationMs: Date.now() - startMs });
    }

    const mapped = results.map((r: Record<string, unknown>) => ({
      url: String(r.url ?? ""),
      title: String(r.title ?? ""),
      snippet: r.description ? String(r.description) : undefined,
      page_age: r.page_age ? String(r.page_age) : undefined,
    }));

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

  const reqHeaders: Record<string, string> = {
    "User-Agent": "chat-to-claude-code/1.0 (proxy; +https://github.com/chinfeng/chat-to-claude-code)",
    "Accept": "text/html,application/json,text/plain,text/markdown",
  };

  // Check domain restrictions
  const parsed = parseDomain(url);
  if (!parsed) {
    onLog?.({ tool: "web_fetch", timestamp: new Date().toISOString(), input: url, requestUrl: url, requestHeaders: reqHeaders, status: 400, error: "Invalid URL", durationMs: Date.now() - startMs });
    return { content: "Invalid URL", url, status_code: 400 };
  }

  if (config.webFetchAllowedDomains.length) {
    const allowed = config.webFetchAllowedDomains.some((d) => domainMatches(d, parsed));
    if (!allowed) {
      onLog?.({ tool: "web_fetch", timestamp: new Date().toISOString(), input: url, requestUrl: url, requestHeaders: reqHeaders, status: 403, error: `Domain ${parsed} is not in the allowed list`, skipped: true, skipReason: `domain not allowed: ${parsed}`, durationMs: Date.now() - startMs });
      return { content: `Domain ${parsed} is not in the allowed list`, url, status_code: 403 };
    }
  }

  if (config.webFetchBlockedDomains.length) {
    const blocked = config.webFetchBlockedDomains.some((d) => domainMatches(d, parsed));
    if (blocked) {
      onLog?.({ tool: "web_fetch", timestamp: new Date().toISOString(), input: url, requestUrl: url, requestHeaders: reqHeaders, status: 403, error: `Domain ${parsed} is blocked`, skipped: true, skipReason: `domain blocked: ${parsed}`, durationMs: Date.now() - startMs });
      return { content: `Domain ${parsed} is blocked`, url, status_code: 403 };
    }
  }

  try {
    const res = await fetch(url, {
      headers: reqHeaders,
      redirect: "follow",
    });

    const resHeaders = extractResponseHeaders(res);
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

    onLog?.({ tool: "web_fetch", timestamp: new Date().toISOString(), input: url, requestUrl: url, requestHeaders: reqHeaders, status: res.status, responseHeaders: resHeaders, responseBody: truncate(body), durationMs: Date.now() - startMs });

    return {
      content,
      url: res.url || url,
      status_code: res.status,
      title: extractTitle(body, contentType),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    onLog?.({ tool: "web_fetch", timestamp: new Date().toISOString(), input: url, requestUrl: url, requestHeaders: reqHeaders, status: 502, error: `Fetch failed: ${msg}`, durationMs: Date.now() - startMs });
    return { content: `Fetch failed: ${msg}`, url, status_code: 502 };
  }
}

/** Extract response headers into a plain object for logging. */
function extractResponseHeaders(res: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

/** Truncate a string for safe logging. */
function truncate(s: string, maxLen = MAX_RESPONSE_BODY_LOG): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + `\n...[truncated, total ${s.length} bytes]`;
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
