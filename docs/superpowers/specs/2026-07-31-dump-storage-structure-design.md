# Dump Storage Structure Optimization

**Date:** 2026-07-31
**Status:** approved

## Goal

Categorize dump directories by request completion status instead of storing
everything in a flat directory.

## Current State

All dumps live under `<dumpDir>/<uuid>__START_<time>__END_<time>/`.
There is no way to distinguish a successful request from a failed one
without opening each dump and reading the termination reason.

## Target State

Dumps are organized into subdirectories based on status:

| Status | Directory | When |
|---|---|---|
| In progress | `dump/in-progress/` | Temp dir while request is active |
| Completed | `dump/completed/` | Normal completion |
| Failed | `dump/failed/` | Upstream error, upstream timeout, or early exit before response |
| Client aborted | `dump/client-aborted/` | Downstream client disconnected mid-stream |
| Upstream aborted | `dump/upstream-aborted/` | Upstream SSE stream terminated mid-generation |

The file naming convention (`<uuid>__START_<time>__END_<time>`) remains unchanged.

## Design

### Approach: Auto-track termination from response writes

The `DumpSession` internally tracks the termination reason from
`writeUpstreamResponse()` and `writeDownstreamResponse()` calls. When
`finish()` is called, it reads the tracked reason to determine the target
subdirectory. Zero changes needed at call sites.

### Changes to `src/core/dump.ts`

1. Add `_terminationReason: TerminationReason | undefined` to the session closure
2. `writeUpstreamResponse()` and `writeDownstreamResponse()` auto-capture
   `meta.termination?.reason` (later write wins)
3. Temp directory: `<dumpDir>/in-progress/<uuid>/` (was `<dumpDir>/<uuid>/`)
4. New helper `getTargetSubdir(reason)`:
   - `undefined` → `"failed"` (early exit before any response written)
   - `"completed"` → `"completed"`
   - `"upstream_timeout"` / `"upstream_error"` → `"failed"`
   - `"client_abort"` → `"client-aborted"`
   - `"upstream_abort"` → `"upstream-aborted"`
5. `finish()` reads the tracked reason, determines the target subdirectory,
   ensures it exists, then renames the temp dir to
   `<dumpDir>/<subdir>/<uuid>__START_<time>__END_<time>/`

### Changes to `src/server/routes.ts`

Minimal — the agentic loop success path (`handleServerToolRequest`) writes
upstream and downstream responses without a `termination` field. Add
`termination: { reason: "completed" }` to those writes so the session
correctly categorizes them as completed rather than falling through to
the `failed` default.

All other paths already write termination before `finish()`, so no changes
needed.

### Unchanged files

- `src/transport/stream.ts` — no dump directory logic
- `src/server/config.ts` — `dumpDir` config unchanged
- `src/sse/builder.ts` — no changes
- All test files — existing tests use `dumpDir: ""` (disabled)
