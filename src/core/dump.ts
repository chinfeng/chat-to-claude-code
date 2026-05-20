/** Request/response dump logger for debugging. */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";

let seq = 0;

export interface DumpSession {
  writeRequest(details: string): void;
  writeResponse(details: string): void;
  finish(): void;
}

const noopSession: DumpSession = {
  writeRequest() {},
  writeResponse() {},
  finish() {},
};

function formatTime(d: Date): string {
  return d.toISOString().replace(/[:.]/g, "-");
}

/** Create a dump session for a single request/response cycle. */
export function createDumpSession(dumpDir: string): DumpSession {
  if (!dumpDir) return noopSession;

  const n = ++seq;
  const tmpDir = `${dumpDir}/${n}`;
  const startTime = new Date();
  let finished = false;

  try { mkdirSync(dumpDir, { recursive: true }); } catch {}
  try { mkdirSync(tmpDir, { recursive: true }); } catch {}

  return {
    writeRequest(details: string) {
      try { writeFileSync(`${tmpDir}/request.log`, details); } catch {}
    },
    writeResponse(details: string) {
      try { writeFileSync(`${tmpDir}/response.log`, details); } catch {}
    },
    finish() {
      if (finished) return;
      finished = true;
      const endTime = new Date();
      const finalName = `${n}-${formatTime(startTime)}-${formatTime(endTime)}`;
      try { renameSync(tmpDir, `${dumpDir}/${finalName}`); } catch {}
    },
  };
}
