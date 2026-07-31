/** Request/response dump logger for debugging. */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { randomUUIDv7 } from "bun";

export interface DumpRequestMeta {
  headers: Record<string, string>;
  datetime: string;
  body: string;
}

export type TerminationReason =
  | "completed"
  | "client_abort"
  | "upstream_timeout"
  | "upstream_error"
  | "upstream_abort";

export interface DumpTermination {
  reason: TerminationReason;
  disconnectTime?: string;
}

export interface DumpUpstreamResponseMeta {
  headers: Record<string, string>;
  status: number;
  body: string;
  termination?: DumpTermination;
}

export interface DumpDownstreamResponseMeta {
  headers: Record<string, string>;
  status: number;
  body: string;
  termination?: DumpTermination;
}

export interface DumpTiming {
  /** Time from request start to first byte of upstream response (ms). */
  ttfb: number;
  /** Total time from request start to response finish (ms). */
  totalTime: number;
}

export interface ServerToolLogEntry {
  tool: "web_search" | "web_fetch" | "agentic_loop";
  timestamp: string;
  /** For web_search: the query string. For web_fetch: the target URL. */
  input: string;
  /** Search engine used (web_search only). */
  engine?: string;
  /** The full URL sent in the HTTP request. */
  requestUrl?: string;
  /** Headers sent with the HTTP request. */
  requestHeaders?: Record<string, string>;
  /** HTTP status code from the upstream API (web_search) or target site (web_fetch). */
  status?: number;
  /** Headers received in the HTTP response. */
  responseHeaders?: Record<string, string>;
  /** Body received in the HTTP response (truncated if too long). */
  responseBody?: string;
  /** Number of results returned (web_search only). */
  resultCount?: number;
  /** Whether the call was skipped (e.g. missing API key, empty query). */
  skipped?: boolean;
  skipReason?: string;
  /** Error message if the call failed. */
  error?: string;
  /** Duration in milliseconds. */
  durationMs?: number;
}

export interface DumpSession {
  writeDownstreamRequest(meta: DumpRequestMeta): void;
  writeUpstreamRequest(meta: DumpRequestMeta): void;
  writeUpstreamResponse(meta: DumpUpstreamResponseMeta): void;
  writeDownstreamResponse(meta: DumpDownstreamResponseMeta): void;
  setTiming(timing: DumpTiming): void;
  logServerTool(entry: ServerToolLogEntry): void;
  /** Record the TRUE upstream outcome to the dump. Called by the stream layer
   *  when it detects the upstream aborted even though it completed the
   *  downstream turn gracefully (hadContent swallow path). No-op once the
   *  session has finished, so a later cancel()/finish() cannot overwrite it. */
  recordUpstreamTermination(reason: TerminationReason, disconnectTime?: string): void;
  /** The recorded upstream outcome, if the stream layer reported one. */
  getUpstreamTermination(): DumpTermination | undefined;
  finish(): void;
}

function getTargetSubdir(reason: TerminationReason | undefined): string {
  switch (reason) {
    case "completed":       return "completed";
    case "client_abort":    return "client-aborted";
    case "upstream_abort":  return "upstream-aborted";
    case "upstream_timeout":
    case "upstream_error":
    default:                return "failed";
  }
}

/** Decide the dump bucket's root-cause termination. The reasons we track come
 *  from two places: the route's downstream outcome (`tracked` — what happened
 *  to the downstream turn) and the stream layer's separate report of what the
 *  UPSTREAM did (`upstream`, recorded via recordUpstreamTermination). They
 *  describe different halves of the same request and can disagree:
 *
 *   - Case B (upstream aborts after content): the stream layer completes the
 *     downstream turn gracefully (partial preserved + notice + message_stop),
 *     so `tracked` = "completed"; but the upstream never sent finish_reason /
 *     [DONE], so the stream layer recorded `upstream` = upstream_abort. The
 *     root cause is the upstream abort → the bucket must reflect `upstream`.
 *   - client disconnect (downstream cancels mid-stream): `tracked` =
 *     "client_abort"; the stream-layer read teardown that follows may look
 *     like an upstream abort, but the CLIENT initiated it → client_abort must
 *     win over any upstream report.
 *
 *  Precedence: a downstream-initiated client disconnect beats everything;
 *  then the upstream's own recorded outcome; then the tracked downstream
 *  outcome. */
function pickTerminationReason(
  tracked: TerminationReason | undefined,
  upstream: DumpTermination | undefined,
): TerminationReason | undefined {
  if (tracked === "client_abort") return "client_abort";
  if (upstream?.reason) return upstream.reason;
  return tracked;
}

const noopSession: DumpSession = {
  writeDownstreamRequest() {},
  writeUpstreamRequest() {},
  writeUpstreamResponse() {},
  writeDownstreamResponse() {},
  setTiming() {},
  logServerTool() {},
  recordUpstreamTermination() {},
  getUpstreamTermination() { return undefined; },
  finish() {},
};

function formatTime(d: Date): string {
  return d.toISOString().replace(/[:.]/g, "-");
}

function formatHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

function formatSection(label: string, content: string): string {
  return `[${label}]\n${content}\n\n`;
}

function formatRequestLog(meta: DumpRequestMeta): string {
  let out = "";
  out += formatSection("Request DateTime", meta.datetime);
  out += formatSection("Request Headers", formatHeaders(meta.headers));
  out += formatSection("Request Body", meta.body);
  return out;
}

function formatTermination(t: DumpTermination): string {
  let out = `Reason: ${t.reason}`;
  if (t.disconnectTime) out += `\nDisconnectTime: ${t.disconnectTime}`;
  return out;
}

function formatResponseLog(
  meta: DumpUpstreamResponseMeta | DumpDownstreamResponseMeta,
  timing?: DumpTiming,
): string {
  let out = "";
  out += formatSection("Response Status", String(meta.status));
  out += formatSection("Response Headers", formatHeaders(meta.headers));
  out += formatSection("Response Body", meta.body);
  if (meta.termination) {
    out += formatSection("Termination", formatTermination(meta.termination));
  }
  if (timing) {
    out += formatSection("Timing", `TTFB: ${timing.ttfb}ms\nTotal: ${timing.totalTime}ms`);
  }
  return out;
}

/** Create a dump session for a single request/response cycle. */
export function createDumpSession(dumpDir: string): DumpSession {
  if (!dumpDir) return noopSession;

  const id = randomUUIDv7();
  const tmpDir = `${dumpDir}/in-progress/${id}`;
  const startTime = new Date();
  let finished = false;
  let _terminationReason: TerminationReason | undefined;
  let _upstreamTermination: DumpTermination | undefined;
  let timing: DumpTiming | undefined;

  try { mkdirSync(dumpDir, { recursive: true }); } catch {}
  try { mkdirSync(tmpDir, { recursive: true }); } catch {}

  const serverToolLogs: string[] = [];

  function formatServerToolEntry(entry: ServerToolLogEntry): string {
    let out = "";
    out += formatSection("Tool", entry.tool);
    out += formatSection("Timestamp", entry.timestamp);
    out += formatSection("Input", entry.input);
    if (entry.engine) out += formatSection("Engine", entry.engine);
    if (entry.requestUrl) out += formatSection("Request URL", entry.requestUrl);
    if (entry.requestHeaders && Object.keys(entry.requestHeaders).length > 0) {
      out += formatSection("Request Headers", formatHeaders(entry.requestHeaders));
    }
    if (entry.status !== undefined) out += formatSection("Status", String(entry.status));
    if (entry.responseHeaders && Object.keys(entry.responseHeaders).length > 0) {
      out += formatSection("Response Headers", formatHeaders(entry.responseHeaders));
    }
    if (entry.responseBody) out += formatSection("Response Body", entry.responseBody);
    if (entry.resultCount !== undefined) out += formatSection("Result Count", String(entry.resultCount));
    if (entry.skipped) {
      out += formatSection("Skipped", "true");
      if (entry.skipReason) out += formatSection("Skip Reason", entry.skipReason);
    }
    if (entry.error) out += formatSection("Error", entry.error);
    if (entry.durationMs !== undefined) out += formatSection("Duration", `${entry.durationMs}ms`);
    out += "---\n";
    return out;
  }

  return {
    writeDownstreamRequest(meta: DumpRequestMeta) {
      try { writeFileSync(`${tmpDir}/downstream-request.log`, formatRequestLog(meta)); } catch {}
    },
    writeUpstreamRequest(meta: DumpRequestMeta) {
      try { writeFileSync(`${tmpDir}/upstream-request.log`, formatRequestLog(meta)); } catch {}
    },
    writeUpstreamResponse(meta: DumpUpstreamResponseMeta) {
      if (meta.termination?.reason) _terminationReason = meta.termination.reason;
      try { writeFileSync(`${tmpDir}/upstream-response.log`, formatResponseLog(meta)); } catch {}
    },
    writeDownstreamResponse(meta: DumpDownstreamResponseMeta) {
      if (meta.termination?.reason) _terminationReason = meta.termination.reason;
      try { writeFileSync(`${tmpDir}/downstream-response.log`, formatResponseLog(meta, timing)); } catch {}
    },
    setTiming(t: DumpTiming) {
      timing = t;
    },
    logServerTool(entry: ServerToolLogEntry) {
      serverToolLogs.push(formatServerToolEntry(entry));
    },
    recordUpstreamTermination(reason: TerminationReason, disconnectTime?: string) {
      // No-op once the session has finished — a later cancel()/finish() must
      // not be able to retroactively relabel the upstream outcome with the
      // downstream teardown state.
      if (finished) return;
      _upstreamTermination = { reason, disconnectTime };
    },
    getUpstreamTermination() {
      return _upstreamTermination;
    },
    finish() {
      if (finished) return;
      finished = true;
      // Write server-tools.log if any entries were collected
      if (serverToolLogs.length > 0) {
        try { writeFileSync(`${tmpDir}/server-tools.log`, serverToolLogs.join("\n")); } catch {}
      }
      const endTime = new Date();
      const finalName = `${id}__START_${formatTime(startTime)}__END_${formatTime(endTime)}`;
      // The bucket reflects the ROOT CAUSE, which can differ from the tracked
      // downstream outcome (e.g. an upstream abort the stream layer swallowed
      // to complete the downstream turn gracefully). See pickTerminationReason.
      const targetSubdir = getTargetSubdir(pickTerminationReason(_terminationReason, _upstreamTermination));
      const targetDir = `${dumpDir}/${targetSubdir}`;
      try { mkdirSync(targetDir, { recursive: true }); } catch {}
      try { renameSync(tmpDir, `${targetDir}/${finalName}`); } catch {}
    },
  };
}
