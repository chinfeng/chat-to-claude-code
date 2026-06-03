# Claude SSE Protocol vs. Project Implementation Comparison

> This document compares the Anthropic Claude Messages API SSE streaming protocol specification against the actual implementation in the `chat-to-claude-code` proxy project, marking the support status of each protocol feature.

## 1. Top-Level SSE Event Types

| Protocol Event | Protocol Description | Project Implementation | Implementation Location | Notes |
|---|---|---|---|---|
| `message_start` | First event in stream; contains full Message object (content is empty array) | ✅ Implemented | `SSEBuilder.message_start()` | Missing `cache_creation_input_tokens`, `cache_read_input_tokens`, `server_tool_use` fields |
| `content_block_start` | Marks beginning of a content block | ✅ Implemented | `SSEBuilder.content_block_start()` | Supports 6 block types: text/thinking/tool_use/server_tool_use/web_search_tool_result/web_fetch_tool_result |
| `content_block_delta` | Incremental update to a content block | ✅ Implemented | `SSEBuilder.content_block_delta()` | Supports 3 delta types: text_delta/thinking_delta/input_json_delta |
| `content_block_stop` | Marks end of a content block | ✅ Implemented | `SSEBuilder.content_block_stop()` | — |
| `message_delta` | Message-level update (stop_reason + usage) | ✅ Implemented | `SSEBuilder.message_delta()` | `usage` field includes `input_tokens` and `output_tokens`; missing `cache_creation_input_tokens`, `cache_read_input_tokens`, `server_tool_use` |
| `message_stop` | Final event in stream | ✅ Implemented | `SSEBuilder.message_stop()` | — |
| `ping` | Keep-alive heartbeat event | ❌ Not Implemented | — | Protocol allows `ping` at any position; this project never emits it |
| `error` | Error event | ✅ Implemented | `SSEBuilder.emit_top_level_error()` | Only supports `api_error` type; does not support sub-types like `overloaded_error`, `rate_limit_error`, etc. |

## 2. Content Block Types (content_block in content_block_start)

| Block Type | Protocol Description | Project Implementation | Implementation Location | Notes |
|---|---|---|---|---|
| `text` | Text output | ✅ Implemented | `SSEBuilder.start_text_block()` | — |
| `thinking` | Extended thinking output | ✅ Implemented | `SSEBuilder.start_thinking_block()` | Generated via `ThinkTagParser` parsing `<think>` tags or OpenAI `reasoning_content` field |
| `redacted_thinking` | Redacted thinking content | ⚠️ Partial | converter.ts:166 | Only skipped during **request conversion** (`continue`); never generated in SSE output |
| `tool_use` | Tool invocation | ✅ Implemented | `SSEBuilder.start_tool_block()` | Full support for id/name/input streaming |
| `server_tool_use` | Server-side tool call (web_search/web_fetch) | ⚠️ Partial | `SSEBuilder.emit_server_tool_use()` | Construction method exists in code, but **not emitted in downstream stream** (see note below) |
| `web_search_tool_result` | Search tool result | ⚠️ Partial | `SSEBuilder.emit_web_search_tool_result()` | Construction method exists in code, but **not emitted in downstream stream** |
| `web_fetch_tool_result` | Fetch tool result | ⚠️ Partial | `SSEBuilder.emit_web_fetch_tool_result()` | Construction method exists in code, but **not emitted in downstream stream** |

> **Note on server_tool_use / web_search_tool_result / web_fetch_tool_result:**
> These three block types have complete construction methods in `SSEBuilder`, but in `handleServerToolRequest()` (routes.ts:960-965), the proxy chooses to emit tool results as **text content blocks** instead of `server_tool_use` events. This is because the Claude Code client, upon receiving `server_tool_use` events, contacts `claude.ai` for domain safety verification, which fails when `claude.ai` is unreachable.

## 3. Delta Sub-Types (delta in content_block_delta)

| Delta Type | Protocol Description | Project Implementation | Implementation Location | Notes |
|---|---|---|---|---|
| `text_delta` | Text increment | ✅ Implemented | `SSEBuilder.emit_text_delta()` | — |
| `thinking_delta` | Thinking increment | ✅ Implemented | `SSEBuilder.emit_thinking_delta()` | — |
| `input_json_delta` | Tool input JSON fragment | ✅ Implemented | `SSEBuilder.emit_tool_delta()` | — |
| `signature_delta` | Cryptographic signature fragment for thinking blocks | ❌ Not Implemented | — | Protocol requires streaming signatures within thinking blocks for multi-turn thinking continuity |
| `citations_delta` | Text citation (text blocks only) | ❌ Not Implemented | — | Supports 5 citation location types (see table below) |

## 4. citations_delta Citation Location Types

| Citation Type | Protocol Description | Project Implementation | Notes |
|---|---|---|---|
| `char_location` | Character position citation for plain text documents | ❌ Not Implemented | Contains `cited_text`, `document_index`, `document_title`, `start_char_index`, `end_char_index`, `file_id` |
| `page_location` | Page number citation for PDF documents | ❌ Not Implemented | Contains `cited_text`, `document_index`, `document_title`, `start_page_number`, `end_page_number`, `file_id` |
| `content_block_location` | Block position citation for content documents | ❌ Not Implemented | Contains `cited_text`, `document_index`, `document_title`, `start_block_index`, `end_block_index`, `file_id` |
| `web_search_result_location` | Web search result citation | ❌ Not Implemented | Contains `cited_text`, `url`, `title`, `encrypted_index` |
| `search_result_location` | Search result block position citation | ❌ Not Implemented | Contains `cited_text`, `source`, `title`, `start_block_index`, `end_block_index`, `search_result_index` |

## 5. message_start.message Field Comparison

| Field | Protocol Specification | Project Implementation | Notes |
|---|---|---|---|
| `id` | `msg_<...>` format | ✅ `msg_${randomUUID()}` | — |
| `type` | `"message"` | ✅ | — |
| `role` | `"assistant"` | ✅ | — |
| `content` | Empty array `[]` | ✅ | — |
| `model` | Model name used | ✅ | Passes through model from request |
| `stop_reason` | Initially `null` | ✅ | — |
| `stop_sequence` | Initially `null` | ✅ | — |
| `usage.input_tokens` | Input token count | ✅ | Estimated via `estimateInputTokens` |
| `usage.output_tokens` | Initially `1` | ✅ | — |
| `usage.cache_creation_input_tokens` | Cache creation token count | ❌ Not Implemented | Protocol default is `0` |
| `usage.cache_read_input_tokens` | Cache read token count | ❌ Not Implemented | Protocol default is `0` |
| `usage.server_tool_use` | Server tool usage statistics | ❌ Not Implemented | Contains `web_fetch_requests` and `web_search_requests` counts |

## 6. message_delta Field Comparison

| Field | Protocol Specification | Project Implementation | Notes |
|---|---|---|---|
| `delta.stop_reason` | Stop reason enum value | ✅ | Mapping: stop→end_turn, length→max_tokens, tool_calls→tool_use, content_filter→end_turn |
| `delta.stop_sequence` | Custom stop sequence that was hit | ✅ | Fixed as `null` |
| `delta.stop_details` | Refusal details (only for refusal) | ❌ Not Implemented | Contains `type`, `category` (cyber/bio), `explanation` |
| `delta.container` | Code execution container info | ❌ Not Implemented | Contains `id`, `expires_at` |
| `usage.output_tokens` | Output token count | ✅ | Obtained via estimation or upstream usage |
| `usage.input_tokens` | Input token count | ✅ | — |
| `usage.cache_creation_input_tokens` | Cache creation token count | ❌ Not Implemented | — |
| `usage.cache_read_input_tokens` | Cache read token count | ❌ Not Implemented | — |
| `usage.server_tool_use` | Server tool usage statistics | ❌ Not Implemented | — |

## 7. stop_reason Enum Value Comparison

| Protocol Value | Description | Project Mapping | Notes |
|---|---|---|---|
| `end_turn` | Natural end | ✅ | Mapped from OpenAI `stop` |
| `max_tokens` | Hit token limit | ✅ | Mapped from OpenAI `length` |
| `stop_sequence` | Hit custom stop sequence | ❌ Not Mapped | Project always sets stop_sequence=null |
| `tool_use` | Tool invocation | ✅ | Mapped from OpenAI `tool_calls` |
| `pause_turn` | Turn paused | ❌ Not Mapped | — |
| `refusal` | Model refused | ❌ Not Mapped | — |

## 8. Event Lifecycle & Ordering

| Protocol Rule | Description | Project Implementation | Notes |
|---|---|---|---|
| `message_start` is the first event | — | ✅ | — |
| `message_stop` is the last event | — | ✅ | — |
| Content block pattern: start → (0+ deltas) → stop | — | ✅ | — |
| Content block indices increment from 0 | — | ✅ | Managed via `ContentBlockManager.nextIndex` |
| `message_delta` after all content_block_stops | — | ✅ | — |
| `ping` can appear at any position | Typically after first content_block_start | ❌ | Project never emits ping |
| thinking block must precede text block | — | ✅ | Guaranteed via `ensure_thinking_block()`/`ensure_text_block()` generators |

## 9. Error Handling Comparison

| Protocol Behavior | Description | Project Implementation | Notes |
|---|---|---|---|
| Top-level `error` event | In-stream errors sent as SSE error event | ✅ | Format: `{type:"error", error:{type:"api_error", message:"..."}}` |
| Stream may close abruptly after error | content_block_stop may be missing | ⚠️ Partial | Exception handler calls `close_all_blocks()` for graceful closure, but some scenarios may not reach it |
| HTTP non-200 status errors | Protocol allows SSE-formatted error responses | ✅ | Non-200 responses return JSON-format errors |
| In-stream error object detection | Upstream HTTP 200 with error embedded in data | ✅ | Detects `chunk.error` object and throws `UpstreamStreamError` |
| Granular error types | overloaded_error/rate_limit_error/authentication_error/permission_error/not_found_error/invalid_request_error | ❌ | Project only uses `api_error` type |

## 10. SSE Transport Protocol Details

| Protocol Specification | Description | Project Implementation | Notes |
|---|---|---|---|
| SSE format `event: <type>\ndata: <json>\n\n` | Standard SSE format | ✅ | `formatSseEvent()` |
| Response header `Content-Type: text/event-stream` | — | ✅ | — |
| Response header `Cache-Control: no-cache` | — | ✅ | — |
| Response header `Connection: keep-alive` | — | ✅ | — |
| Response header `X-Accel-Buffering: no` | Disables Nginx buffering | ✅ | — |
| CRLF line ending support | Upstream may return `\r\n` | ✅ | Handled via `.trim()` in `iterUpstreamChunks` |
| Client disconnect detection | — | ✅ | Via `AbortSignal` + `ReadableStream.cancel()` |
| `[DONE]` marker handling | OpenAI format stream end marker | ✅ | Skipped in `parseSseLine` |

## 11. Special Streaming Mechanisms

| Mechanism | Description | Project Implementation | Notes |
|---|---|---|---|
| `<think>` tag parsing | Convert `<think>...</think>` in text to thinking blocks | ✅ | `ThinkTagParser` |
| OpenAI `reasoning_content` field | Convert OpenAI extended thinking field to thinking blocks | ✅ | stream.ts:119-123 |
| Heuristic tool detection | Detect `●` pattern tool calls from text stream | ✅ | `HeuristicToolParser` |
| GLM-5.1 incomplete tool_calls handling | Tool calls missing id and function.name | ✅ | `inferToolNameByIndex()` + orphan state downgrade |
| Text-embedded tool call detection | `<tool_use>` tags, WebSearch/WebFetch patterns | ✅ | `detectServerToolInText()` |
| Server tool agentic loop | Proxy-side execution of web_search/web_fetch with loop | ✅ | `handleServerToolRequest()`, max 5 iterations |
| Task tool `run_in_background` normalization | Force set to `false` | ✅ | `normalizeTaskRunInBackground()` |
| Orphaned tool state downgrade | Unresolvable tool calls downgraded to `end_turn` | ✅ | stream.ts:270 |

## 12. Project-Specific Extensions

| Feature | Description | In Protocol? |
|---|---|---|
| ThinkTagParser | Parse `<think>` tags and convert to thinking blocks | ❌ Proxy-specific |
| HeuristicToolParser | Heuristically detect tool call patterns in text | ❌ Proxy-specific |
| GLM-5.1 compatibility handling | Handle tool_calls missing id/name | ❌ Proxy-specific |
| Text-embedded tool call fallback | Support 4 formats of text-embedded tool call detection | ❌ Proxy-specific |
| Server tool result downgrade to text | Avoid Claude Code domain safety verification issue | ❌ Proxy-specific |
| Dump logging | Full request/response logging | ❌ Proxy-specific |
