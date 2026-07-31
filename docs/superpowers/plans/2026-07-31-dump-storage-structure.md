# Dump Storage Structure Optimization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Categorize dump directories by termination reason (completed / failed / client-aborted / upstream-aborted) with in-progress temp storage.

**Architecture:** Session auto-tracks `TerminationReason` from `writeUpstreamResponse()` / `writeDownstreamResponse()` calls. `finish()` uses the tracked reason to move the temp dir from `in-progress/` into the appropriate subdirectory. Call sites unchanged except one success path that needs an explicit termination.

**Tech Stack:** TypeScript (Bun runtime), Node.js `fs` module

## Global Constraints

- File naming convention `<uuid>__START_<time>__END_<time>` preserved
- Existing tests pass without modification (they use `dumpDir: ""` = disabled)
- `TerminationReason` type and `DumpTermination` interface unchanged

---

### Task 1: Add termination tracking and subdirectory routing to `dump.ts`

**Files:**
- Modify: `src/core/dump.ts`

**Interfaces:**
- Consumes: (nothing new from other tasks)
- Produces: `DumpSession` unchanged externally; internally tracks termination reason and routes to subdirectory on `finish()`

---

- [ ] **Step 1: Add `_terminationReason` variable and capture it from writes**

In `createDumpSession()`, after the existing `let finished = false;` line, add a variable to track the termination reason. Then, inside `writeUpstreamResponse` and `writeDownstreamResponse`, capture `meta.termination?.reason` if present.

**File: `src/core/dump.ts`**, after line 146 (`let finished = false;`):

```ts
  let _terminationReason: TerminationReason | undefined;
```

Inside `writeUpstreamResponse` (currently line 187), add after `try {`:

```ts
      if (meta.termination?.reason) _terminationReason = meta.termination.reason;
```

Same inside `writeDownstreamResponse` (currently line 189), add after `try {`:

```ts
      if (meta.termination?.reason) _terminationReason = meta.termination.reason;
```

---

- [ ] **Step 2: Add `getTargetSubdir` helper function**

Add this function before `noopSession` (before line 83):

```ts
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
```

---

- [ ] **Step 3: Change temp directory to `in-progress/` subdirectory**

Change the `tmpDir` construction on line 143 from:

```ts
  const tmpDir = `${dumpDir}/${id}`;
```

To:

```ts
  const tmpDir = `${dumpDir}/in-progress/${id}`;
```

---

- [ ] **Step 4: Update `finish()` to route to the correct subdirectory**

Replace the `finish()` function body (lines 198-209) with:

```ts
    finish() {
      if (finished) return;
      finished = true;
      // Write server-tools.log if any entries were collected
      if (serverToolLogs.length > 0) {
        try { writeFileSync(`${tmpDir}/server-tools.log`, serverToolLogs.join("\n")); } catch {}
      }
      const endTime = new Date();
      const finalName = `${id}__START_${formatTime(startTime)}__END_${formatTime(endTime)}`;
      const targetSubdir = getTargetSubdir(_terminationReason);
      const targetDir = `${dumpDir}/${targetSubdir}`;
      try { mkdirSync(targetDir, { recursive: true }); } catch {}
      try { renameSync(tmpDir, `${targetDir}/${finalName}`); } catch {}
    },
```

---

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors

---

- [ ] **Step 6: Commit**

```bash
git add src/core/dump.ts
git commit -m "feat(dump): categorize dumps by termination reason into subdirectories"
```

---

### Task 2: Fix agentic loop success path to emit completed termination

**Files:**
- Modify: `src/server/routes.ts:1154-1164`

**Interfaces:**
- Consumes: `DumpSession` (unchanged interface)
- Produces: Success path now correctly tagged as `completed` instead of falling through to `failed` default

---

- [ ] **Step 1: Add termination to upstream response write in agentic loop success path**

In `handleServerToolRequest`, find the success-path writes around lines 1155-1164. Add `termination: { reason: "completed" }` to both writes:

Current code:
```ts
                dump.writeUpstreamResponse({
                    headers: upstreamHeaders,
                    status: finalRes.status,
                    body: finalRawChunks.join(""),
                });
                dump.writeDownstreamResponse({
                    headers: downstreamHeaders,
                    status: 200,
                    body: downstreamChunks.join(""),
                });
```

Change to:
```ts
                dump.writeUpstreamResponse({
                    headers: upstreamHeaders,
                    status: finalRes.status,
                    body: finalRawChunks.join(""),
                    termination: { reason: "completed" },
                });
                dump.writeDownstreamResponse({
                    headers: downstreamHeaders,
                    status: 200,
                    body: downstreamChunks.join(""),
                    termination: { reason: "completed" },
                });
```

---

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors

---

- [ ] **Step 3: Commit**

```bash
git add src/server/routes.ts
git commit -m "fix(dump): tag agentic loop success path as completed"
```

---

### Task 3: Run existing tests and verify

**Files:**
- (No file changes — verification only)

---

- [ ] **Step 1: Run the full test suite**

Run: `bun test`
Expected: all tests pass

---

- [ ] **Step 2: Manual smoke test (optional)**

Start the server with `--dump /tmp/test-dump` and send a simple request:

```bash
bun run src/server/index.ts --dump ./test-dumps --upstream-api-key <key> &
```

After requests with different outcomes, verify directory structure:

```
test-dumps/
  in-progress/       (may be empty after server stops)
  completed/
  failed/
  client-aborted/
  upstream-aborted/
```
