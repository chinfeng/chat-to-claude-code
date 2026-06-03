# SSE Protocol Unimplemented Features TODO List

> This document lists features from the Claude Messages API SSE streaming protocol that are not yet implemented in this project, categorized by priority and implementation difficulty.

## Priority Labels

- 🔴 **P0 — Critical**: Affects core feature compatibility; clients may error or behave incorrectly
- 🟠 **P1 — Important**: Affects advanced features or correctness in specific scenarios
- 🟡 **P2 — Moderate**: Feature gap that doesn't affect primary use cases
- ⚪ **P3 — Low**: Nice-to-have features for future iteration

---

## 🔴 P0 — Critical

### TODO-1: Implement `signature_delta` Events

**Protocol Requirement:** Thinking content blocks must stream cryptographic signature fragments (`signature_delta`). Signatures are required for multi-turn thinking continuity — clients must pass back the `ThinkingBlock` (containing both `thinking` and `signature`) in subsequent turns to maintain thinking context.

**Current Status:** Not implemented. Thinking blocks only emit `thinking_delta`, no signatures.

**Impact:** In multi-turn conversations using extended thinking, clients like Claude Code cannot properly pass back thinking context, causing subsequent turns to lose thinking continuity or restart from scratch.

**Implementation Approach:**
1. Add `signature_delta` delta type support in `SSEBuilder.content_block_delta()`
2. In `streamOpenAIChatToAnthropicSse()`, generate signatures after `thinking_delta` events (or at block end) within thinking blocks
3. Signature generation: use HMAC-SHA256 on thinking content, or generate placeholder signatures (need to verify whether clients validate signature format)
4. Insert signature before `stop_thinking_block()` in `close_content_blocks()`

**Related Files:** `src/sse/builder.ts`, `src/transport/stream.ts`

---

### TODO-2: Implement `redacted_thinking` Content Block SSE Output

**Protocol Requirement:** When thinking content is redacted (e.g., `display: "omitted"`), a `redacted_thinking` block should be output. This block contains complete data in `content_block_start` (no delta events needed) and is immediately followed by `content_block_stop`.

**Current Status:** Only skipped during request conversion (converter.ts:166); never generated in SSE downstream output.

**Impact:** If the upstream API returns a response containing `redacted_thinking`, the proxy cannot properly forward it, causing clients to lose thinking context markers.

**Implementation Approach:**
1. In `streamOpenAIChatToAnthropicSse()`, detect whether upstream returns `redacted_thinking` related data
2. If upstream model returns redacted thinking content (opaque data), emit via `SSEBuilder.content_block_start("redacted_thinking", { data: "..." })` + `content_block_stop()`
3. In request conversion (converter.ts), preserve `redacted_thinking` blocks for multi-turn passback

**Related Files:** `src/sse/builder.ts`, `src/transport/stream.ts`, `src/conversion/converter.ts`

---

### TODO-3: Implement `ping` Heartbeat Event

**Protocol Requirement:** Send `ping` events at any position in the stream (typically after the first `content_block_start`) to keep the connection alive.

**Current Status:** Not implemented. Ping events are never emitted.

**Impact:** Under high-latency networks or proxy servers (e.g., Nginx, Cloudflare), prolonged periods without data transmission may cause connection timeout. This is especially problematic during extended thinking phases (which can last tens of seconds), where clients or intermediate proxies may close the connection due to timeout.

**Implementation Approach:**
1. In `streamOpenAIChatToAnthropicSse()`, emit a `ping` after `message_start` and before the first `content_block_delta`
2. Optional: Add a timer that automatically sends ping when there's no output for an extended period (needs handling in ReadableStream's start/pull logic)
3. SSE format: `event: ping\ndata: {"type":"ping"}\n\n`

**Related Files:** `src/transport/stream.ts`, `src/server/routes.ts`

---

## 🟠 P1 — Important

### TODO-4: Implement `citations_delta` Events

**Protocol Requirement:** In text content blocks, stream citation information via `citations_delta` events. Supports 5 citation location types: `char_location`, `page_location`, `content_block_location`, `web_search_result_location`, `search_result_location`.

**Current Status:** Not implemented.

**Impact:** When upstream model returns text with citations (e.g., from file retrieval or web search results), citation information is lost. Clients cannot display citation sources.

**Implementation Approach:**
1. Add `citations_delta` delta type support in `SSEBuilder.content_block_delta()`
2. Extract citation information from upstream responses (depends on whether upstream API returns citation data)
3. For web_search scenarios, generate `web_search_result_location` type citations from search results in the agentic loop
4. Citation events can be interspersed between `text_delta` events

**Related Files:** `src/sse/builder.ts`, `src/transport/stream.ts`, `src/server/routes.ts`

---

### TODO-5: Implement Granular `error` Event Types

**Protocol Requirement:** The `error` event's `error.type` field should distinguish multiple error types: `api_error`, `overloaded_error`, `rate_limit_error`, `authentication_error`, `permission_error`, `not_found_error`, `invalid_request_error`.

**Current Status:** All errors use the `api_error` type.

**Impact:** Clients cannot perform differentiated error handling (e.g., exponential backoff for `rate_limit_error`, brief wait for `overloaded_error`).

**Implementation Approach:**
1. Extend `makeAnthropicError` in `src/core/errors.ts` or add new error constructors
2. Map error types based on upstream HTTP status codes:
   - 429 → `rate_limit_error`
   - 529 → `overloaded_error`
   - 401 → `authentication_error`
   - 403 → `permission_error`
   - 404 → `not_found_error`
   - 400 → `invalid_request_error`
   - 500+ → `api_error`
3. Use granular types in error handling paths in `routes.ts`

**Related Files:** `src/core/errors.ts`, `src/server/routes.ts`, `src/transport/stream.ts`

---

### TODO-6: Implement Missing `usage` Fields in `message_delta`

**Protocol Requirement:** The `message_delta` `usage` object should include `cache_creation_input_tokens`, `cache_read_input_tokens`, and `server_tool_use` (containing `web_fetch_requests`, `web_search_requests`).

**Current Status:** `usage` only has `input_tokens` and `output_tokens`.

**Impact:** Clients cannot obtain cache hit rates and server tool usage statistics, affecting cost analysis and billing calculations.

**Implementation Approach:**
1. Add missing fields in `SSEBuilder.message_start()` and `message_delta()` (initialize to 0)
2. For `server_tool_use`, accumulate `web_search`/`web_fetch` call counts in the agentic loop
3. For cache tokens, since the proxy doesn't directly access upstream cache metadata, set to 0 or extract from upstream response headers

**Related Files:** `src/sse/builder.ts`

---

### TODO-7: Implement Complete `stop_reason` Enum Value Mapping

**Protocol Requirement:** `stop_reason` should support `end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn`, `refusal`.

**Current Status:** Only `end_turn`, `max_tokens`, and `tool_use` are mapped.

**Impact:** When upstream returns `stop_sequence`, `pause_turn`, or `refusal` as stop reasons, they are defaulted to `end_turn`, preventing clients from distinguishing different stop scenarios.

**Implementation Approach:**
1. Extend `STOP_REASON_MAP`:
   ```typescript
   const STOP_REASON_MAP: Record<string, string> = {
     stop: "end_turn",
     length: "max_tokens",
     tool_calls: "tool_use",
     content_filter: "refusal",  // Fix mapping
   };
   ```
2. Add detection for `stop_sequence` (if request contains `stop_sequences` and one was hit)
3. Add support for `pause_turn` (depends on whether upstream model returns this value)

**Related Files:** `src/sse/builder.ts`

---

### TODO-8: Implement `stop_details` Field (Refusal Scenarios)

**Protocol Requirement:** When `stop_reason` is `refusal`, the `delta` should include `stop_details` field containing `type` (fixed `"refusal"`), `category` (`"cyber"` or `"bio"`), and `explanation` (human-readable explanation).

**Current Status:** Not implemented.

**Impact:** In safety refusal scenarios, clients cannot obtain refusal reasons and category information.

**Implementation Approach:**
1. Add optional `stop_details` parameter to `SSEBuilder.message_delta()`
2. When `content_filter` type stop reason is detected, construct `stop_details` object
3. Extract refusal reason from upstream response (if available)

**Related Files:** `src/sse/builder.ts`, `src/transport/stream.ts`

---

## 🟡 P2 — Moderate

### TODO-9: Implement `container` Field (Code Execution Tool)

**Protocol Requirement:** When using code execution tools, `message_delta` `delta` should include `container` field containing `id` (container identifier) and `expires_at` (expiration time).

**Current Status:** Not implemented.

**Impact:** If clients use code execution tools, they cannot obtain container information.

**Implementation Approach:**
1. Add optional `container` parameter to `SSEBuilder.message_delta()`
2. When code execution related tool calls are detected, construct container info
3. Since this project is a proxy, container info should be passed through from upstream responses

**Related Files:** `src/sse/builder.ts`

---

### TODO-10: Implement Missing `usage` Fields in `message_start`

**Protocol Requirement:** `message_start.message.usage` should include `cache_creation_input_tokens`, `cache_read_input_tokens`, and `server_tool_use`.

**Current Status:** `usage` only has `input_tokens` and `output_tokens`.

**Impact:** Similar to TODO-6 but affects the stream's initial event. Clients should receive the complete usage structure at stream start.

**Implementation Approach:**
1. Add fields in `SSEBuilder.message_start()`:
   ```typescript
   usage: {
     input_tokens: safeInput,
     output_tokens: 1,
     cache_creation_input_tokens: 0,
     cache_read_input_tokens: 0,
     server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
   }
   ```

**Related Files:** `src/sse/builder.ts`

---

### TODO-11: Native SSE Output for Server Tool Events

**Protocol Requirement:** Server tools (web_search/web_fetch) should be output natively in SSE streams via `server_tool_use` + `web_search_tool_result`/`web_fetch_tool_result` content blocks.

**Current Status:** `SSEBuilder` has construction methods, but at runtime tool results are downgraded to text content blocks (to work around Claude Code domain safety verification issues).

**Impact:** Non-standard output format. Native format may be more appropriate when Claude Code can access `claude.ai` or when using other clients.

**Implementation Approach:**
1. Add configuration option (e.g., `--emit-native-server-tool-events`) allowing users to choose whether to emit native server_tool_use events
2. Default behavior remains the current text-downgrade approach
3. When native mode is enabled, use existing `emit_server_tool_use()` / `emit_web_search_tool_result()` / `emit_web_fetch_tool_result()` methods

**Related Files:** `src/server/routes.ts`, `src/server/config.ts`

---

### TODO-12: Improve Stream Closure Behavior After Errors

**Protocol Requirement:** After in-stream errors, `message_stop` may not be sent, and open content blocks may be missing `content_block_stop`. Clients should gracefully handle partial content.

**Current Status:** Exception handler calls `close_all_blocks()` for graceful closure, but in extreme scenarios (e.g., sudden network disconnection) it may not have time to execute.

**Implementation Approach:**
1. Ensure cleanup of all open blocks in `ReadableStream`'s `cancel()` callback
2. Add detection and logging for unclosed blocks in `finalizeDump()`
3. Consider adding timeout mechanism in error scenarios to ensure `close_all_blocks()` has a chance to execute

**Related Files:** `src/server/routes.ts`, `src/transport/stream.ts`

---

## ⚪ P3 — Low

### TODO-13: Implement Periodic `ping` Heartbeat Mechanism

**Protocol Note:** `ping` events can appear at any position in the stream. It's recommended to send them periodically during thinking phases (long periods without output).

**Current Status:** Related to TODO-3, but this item refers to a more advanced periodic heartbeat mechanism.

**Implementation Approach:**
1. Start a `setInterval` timer in `ReadableStream.start()`
2. Check every N seconds (e.g., 15 seconds) whether there has been content output
3. If no output for an extended period, enqueue a `ping` event
4. Clean up timer when stream ends

**Related Files:** `src/server/routes.ts`

---

### TODO-14: Support Prompt Caching Metrics Passthrough in Streaming

**Protocol Note:** When using prompt caching, responses should include `cache_creation_input_tokens` and `cache_read_input_tokens`.

**Current Status:** Not implemented. Cannot obtain upstream cache hit metrics.

**Implementation Approach:**
1. Extract cache-related metrics from upstream response headers (e.g., `anthropic-cache-creation-input-tokens` and similar custom headers)
2. Pass these values through in `message_start` and `message_delta`
3. Need to confirm the specific response header format of the upstream API

**Related Files:** `src/server/routes.ts`, `src/sse/builder.ts`

---

## Implementation Priority Summary

| Priority | TODO Item | Core Value |
|---|---|---|
| 🔴 P0 | TODO-1: `signature_delta` | Multi-turn thinking continuity |
| 🔴 P0 | TODO-2: `redacted_thinking` SSE output | Redacted thinking compatibility |
| 🔴 P0 | TODO-3: `ping` heartbeat | Connection keep-alive |
| 🟠 P1 | TODO-4: `citations_delta` | Citation features |
| 🟠 P1 | TODO-5: Granular error types | Client differentiated error handling |
| 🟠 P1 | TODO-6: `message_delta` usage extension | Cost analysis |
| 🟠 P1 | TODO-7: Complete stop_reason mapping | Stop reason accuracy |
| 🟠 P1 | TODO-8: `stop_details` | Safety refusal information |
| 🟡 P2 | TODO-9: `container` field | Code execution tool |
| 🟡 P2 | TODO-10: `message_start` usage extension | Structural completeness |
| 🟡 P2 | TODO-11: Native server_tool_use output | Format standardization |
| 🟡 P2 | TODO-12: Improved post-error stream closure | Robustness |
| ⚪ P3 | TODO-13: Periodic ping heartbeat | Long connection stability |
| ⚪ P3 | TODO-14: Prompt caching metrics passthrough | Cache monitoring |
