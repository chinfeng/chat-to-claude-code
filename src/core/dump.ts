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

export interface DumpSession {
  writeRequest(meta: DumpRequestMeta): void;
  writeUpstreamResponse(meta: DumpUpstreamResponseMeta): void;
  writeDownstreamResponse(meta: DumpDownstreamResponseMeta): void;
  setTiming(timing: DumpTiming): void;
  finish(): void;
}

const noopSession: DumpSession = {
  writeRequest() {},
  writeUpstreamResponse() {},
  writeDownstreamResponse() {},
  setTiming() {},
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
  const tmpDir = `${dumpDir}/${id}`;
  const startTime = new Date();
  let finished = false;
  let timing: DumpTiming | undefined;

  try { mkdirSync(dumpDir, { recursive: true }); } catch {}
  try { mkdirSync(tmpDir, { recursive: true }); } catch {}

  return {
    writeRequest(meta: DumpRequestMeta) {
      try { writeFileSync(`${tmpDir}/request.log`, formatRequestLog(meta)); } catch {}
    },
    writeUpstreamResponse(meta: DumpUpstreamResponseMeta) {
      try { writeFileSync(`${tmpDir}/upstream-response.log`, formatResponseLog(meta)); } catch {}
    },
    writeDownstreamResponse(meta: DumpDownstreamResponseMeta) {
      try { writeFileSync(`${tmpDir}/downstream-response.log`, formatResponseLog(meta, timing)); } catch {}
    },
    setTiming(t: DumpTiming) {
      timing = t;
    },
    finish() {
      if (finished) return;
      finished = true;
      const endTime = new Date();
      const finalName = `${id}__START_${formatTime(startTime)}__END_${formatTime(endTime)}`;
      try { renameSync(tmpDir, `${dumpDir}/${finalName}`); } catch {}
    },
  };
}
