# Claude SSE 协议特性与本项目实现对照表

> 本文档对照 Anthropic Claude Messages API 的 SSE 流式协议规范与 `chat-to-claude-code` 代理项目的实际实现，标注每个协议特性的支持状态。

## 1. 顶层 SSE 事件类型

| 协议事件 | 协议说明 | 本项目实现 | 实现位置 | 备注 |
|---|---|---|---|---|
| `message_start` | 流的起始事件，包含完整 Message 对象（content 为空数组） | ✅ 已实现 | `SSEBuilder.message_start()` | 缺少 `cache_creation_input_tokens`、`cache_read_input_tokens`、`server_tool_use` 字段 |
| `content_block_start` | 标记内容块开始 | ✅ 已实现 | `SSEBuilder.content_block_start()` | 支持 text/thinking/tool_use/server_tool_use/web_search_tool_result/web_fetch_tool_result 6 种块类型 |
| `content_block_delta` | 内容块增量更新 | ✅ 已实现 | `SSEBuilder.content_block_delta()` | 支持 text_delta/thinking_delta/input_json_delta 3 种 delta 类型 |
| `content_block_stop` | 标记内容块结束 | ✅ 已实现 | `SSEBuilder.content_block_stop()` | — |
| `message_delta` | 消息级别更新（stop_reason + usage） | ✅ 已实现 | `SSEBuilder.message_delta()` | `usage` 字段包含 `input_tokens` 和 `output_tokens`；缺少 `cache_creation_input_tokens`、`cache_read_input_tokens`、`server_tool_use` |
| `message_stop` | 流的终止事件 | ✅ 已实现 | `SSEBuilder.message_stop()` | — |
| `ping` | 保活心跳事件 | ❌ 未实现 | — | 协议允许在任意位置发送 `ping`，本项目从未发出 |
| `error` | 错误事件 | ✅ 已实现 | `SSEBuilder.emit_top_level_error()` | 仅支持 `api_error` 类型；不支持 `overloaded_error`、`rate_limit_error` 等细分类型 |

## 2. 内容块类型（content_block_start 中的 content_block）

| 块类型 | 协议说明 | 本项目实现 | 实现位置 | 备注 |
|---|---|---|---|---|
| `text` | 文本输出 | ✅ 已实现 | `SSEBuilder.start_text_block()` | — |
| `thinking` | 扩展思考输出 | ✅ 已实现 | `SSEBuilder.start_thinking_block()` | 通过 `ThinkTagParser` 解析 `<think>` 标签 或 OpenAI `reasoning_content` 字段生成 |
| `redacted_thinking` | 被编辑的思考内容 | ⚠️ 部分实现 | converter.ts:166 | 仅在**请求转换**时跳过（`continue`）；从未在 SSE 输出中生成此类事件 |
| `tool_use` | 工具调用 | ✅ 已实现 | `SSEBuilder.start_tool_block()` | 完整支持 id/name/input 流式输出 |
| `server_tool_use` | 服务端工具调用（web_search/web_fetch） | ⚠️ 部分实现 | `SSEBuilder.emit_server_tool_use()` | 代码中已实现构造方法，但**实际下行流中不发出**（见下文说明） |
| `web_search_tool_result` | 搜索工具结果 | ⚠️ 部分实现 | `SSEBuilder.emit_web_search_tool_result()` | 代码中已实现构造方法，但**实际下行流中不发出** |
| `web_fetch_tool_result` | 抓取工具结果 | ⚠️ 部分实现 | `SSEBuilder.emit_web_fetch_tool_result()` | 代码中已实现构造方法，但**实际下行流中不发出** |

> **关于 server_tool_use / web_search_tool_result / web_fetch_tool_result 的说明：**
> 这三个块类型在 `SSEBuilder` 中有完整的构造方法，但在 `handleServerToolRequest()`（routes.ts:960-965）中，代理选择将工具结果作为**文本内容块**发出，而不是发出 `server_tool_use` 事件。原因是 Claude Code 客户端收到 `server_tool_use` 事件后会联系 `claude.ai` 进行域名安全验证，而 `claude.ai` 不可达时会导致失败。

## 3. Delta 子类型（content_block_delta 中的 delta）

| Delta 类型 | 协议说明 | 本项目实现 | 实现位置 | 备注 |
|---|---|---|---|---|
| `text_delta` | 文本增量 | ✅ 已实现 | `SSEBuilder.emit_text_delta()` | — |
| `thinking_delta` | 思考增量 | ✅ 已实现 | `SSEBuilder.emit_thinking_delta()` | — |
| `input_json_delta` | 工具输入 JSON 片段 | ✅ 已实现 | `SSEBuilder.emit_tool_delta()` | — |
| `signature_delta` | 思考块的加密签名片段 | ❌ 未实现 | — | 协议要求在 thinking 块中流式输出签名以保证多轮对话的思考连续性 |
| `citations_delta` | 文本引用（仅用于 text 块） | ❌ 未实现 | — | 支持 5 种引用位置类型（见下表） |

## 4. citations_delta 引用位置类型

| 引用类型 | 协议说明 | 本项目实现 | 备注 |
|---|---|---|---|
| `char_location` | 纯文本文档的字符位置引用 | ❌ 未实现 | 包含 `cited_text`、`document_index`、`document_title`、`start_char_index`、`end_char_index`、`file_id` |
| `page_location` | PDF 文档的页码位置引用 | ❌ 未实现 | 包含 `cited_text`、`document_index`、`document_title`、`start_page_number`、`end_page_number`、`file_id` |
| `content_block_location` | 内容文档的块位置引用 | ❌ 未实现 | 包含 `cited_text`、`document_index`、`document_title`、`start_block_index`、`end_block_index`、`file_id` |
| `web_search_result_location` | 搜索结果引用 | ❌ 未实现 | 包含 `cited_text`、`url`、`title`、`encrypted_index` |
| `search_result_location` | 搜索结果块位置引用 | ❌ 未实现 | 包含 `cited_text`、`source`、`title`、`start_block_index`、`end_block_index`、`search_result_index` |

## 5. message_start.message 字段对照

| 字段 | 协议规范 | 本项目实现 | 备注 |
|---|---|---|---|
| `id` | `msg_<...>` 格式 | ✅ `msg_${randomUUID()}` | — |
| `type` | `"message"` | ✅ | — |
| `role` | `"assistant"` | ✅ | — |
| `content` | 空数组 `[]` | ✅ | — |
| `model` | 使用的模型名 | ✅ | 直接透传请求中的 model |
| `stop_reason` | 初始为 `null` | ✅ | — |
| `stop_sequence` | 初始为 `null` | ✅ | — |
| `usage.input_tokens` | 输入 token 数 | ✅ | 通过 `estimateInputTokens` 估算 |
| `usage.output_tokens` | 初始为 `1` | ✅ | — |
| `usage.cache_creation_input_tokens` | 缓存创建 token 数 | ❌ 未实现 | 协议默认值为 `0` |
| `usage.cache_read_input_tokens` | 缓存读取 token 数 | ❌ 未实现 | 协议默认值为 `0` |
| `usage.server_tool_use` | 服务端工具使用统计 | ❌ 未实现 | 包含 `web_fetch_requests` 和 `web_search_requests` 计数 |

## 6. message_delta 字段对照

| 字段 | 协议规范 | 本项目实现 | 备注 |
|---|---|---|---|
| `delta.stop_reason` | 停止原因枚举值 | ✅ | 支持映射：stop→end_turn, length→max_tokens, tool_calls→tool_use, content_filter→end_turn |
| `delta.stop_sequence` | 命中的自定义停止序列 | ✅ | 固定为 `null` |
| `delta.stop_details` | 拒绝详情（仅 refusal 时） | ❌ 未实现 | 包含 `type`、`category`（cyber/bio）、`explanation` |
| `delta.container` | 代码执行容器信息 | ❌ 未实现 | 包含 `id`、`expires_at` |
| `usage.output_tokens` | 输出 token 数 | ✅ | 通过估算或上游 usage 获取 |
| `usage.input_tokens` | 输入 token 数 | ✅ | — |
| `usage.cache_creation_input_tokens` | 缓存创建 token 数 | ❌ 未实现 | — |
| `usage.cache_read_input_tokens` | 缓存读取 token 数 | ❌ 未实现 | — |
| `usage.server_tool_use` | 服务端工具使用统计 | ❌ 未实现 | — |

## 7. stop_reason 枚举值对照

| 协议值 | 说明 | 本项目映射 | 备注 |
|---|---|---|---|
| `end_turn` | 自然结束 | ✅ | 从 OpenAI `stop` 映射 |
| `max_tokens` | 达到 token 上限 | ✅ | 从 OpenAI `length` 映射 |
| `stop_sequence` | 命中自定义停止序列 | ❌ 未映射 | 本项目固定 stop_sequence=null |
| `tool_use` | 工具调用 | ✅ | 从 OpenAI `tool_calls` 映射 |
| `pause_turn` | 轮次暂停 | ❌ 未映射 | — |
| `refusal` | 模型拒绝 | ❌ 未映射 | — |

## 8. 事件生命周期与顺序

| 协议规则 | 说明 | 本项目实现 | 备注 |
|---|---|---|---|
| `message_start` 为首个事件 | — | ✅ | — |
| `message_stop` 为末尾事件 | — | ✅ | — |
| 内容块模式：start → (0+ delta) → stop | — | ✅ | — |
| 内容块索引递增从 0 开始 | — | ✅ | 通过 `ContentBlockManager.nextIndex` 管理 |
| `message_delta` 在所有 content_block_stop 之后 | — | ✅ | — |
| `ping` 可出现在任意位置 | 通常在首个 content_block_start 后 | ❌ | 本项目从不发出 ping |
| thinking 块必须在 text 块之前 | — | ✅ | 通过 `ensure_thinking_block()`/`ensure_text_block()` 生成器保证顺序 |

## 9. 错误处理对照

| 协议行为 | 说明 | 本项目实现 | 备注 |
|---|---|---|---|
| 顶层 `error` 事件 | 流内错误通过 SSE error 事件发出 | ✅ | 格式为 `{type:"error", error:{type:"api_error", message:"..."}}` |
| 错误后流可能突然关闭 | content_block_stop 可能缺失 | ⚠️ 部分 | 异常捕获时会调用 `close_all_blocks()` 尝试优雅关闭，但某些场景可能来不及 |
| HTTP 非 200 状态码错误 | 协议允许 SSE 格式的错误响应 | ✅ | 非 200 响应返回 JSON 格式错误 |
| 流内错误对象检测 | 上游 HTTP 200 但 data 中嵌入错误 | ✅ | 检测 `chunk.error` 对象并抛出 `UpstreamStreamError` |
| 细分错误类型 | overloaded_error/rate_limit_error/authentication_error/permission_error/not_found_error/invalid_request_error | ❌ | 本项目仅使用 `api_error` 类型 |

## 10. SSE 传输协议细节

| 协议规范 | 说明 | 本项目实现 | 备注 |
|---|---|---|---|
| SSE 格式 `event: <type>\ndata: <json>\n\n` | 标准 SSE 格式 | ✅ | `formatSseEvent()` |
| 响应头 `Content-Type: text/event-stream` | — | ✅ | — |
| 响应头 `Cache-Control: no-cache` | — | ✅ | — |
| 响应头 `Connection: keep-alive` | — | ✅ | — |
| 响应头 `X-Accel-Buffering: no` | 禁止 Nginx 缓冲 | ✅ | — |
| 支持 CRLF 行尾 | 上游可能返回 `\r\n` | ✅ | `iterUpstreamChunks` 中 `.trim()` 处理 |
| 客户端断连检测 | — | ✅ | 通过 `AbortSignal` + `ReadableStream.cancel()` |
| `[DONE]` 标记处理 | OpenAI 格式流结束标记 | ✅ | `parseSseLine` 中跳过 |

## 11. 特殊流式处理机制

| 机制 | 说明 | 本项目实现 | 备注 |
|---|---|---|---|
| `<think>` 标签解析 | 将文本中的 `<think>...</think>` 转为 thinking 块 | ✅ | `ThinkTagParser` |
| OpenAI `reasoning_content` 字段 | 将 OpenAI 扩展思考字段转为 thinking 块 | ✅ | stream.ts:119-123 |
| 启发式工具检测 | 从文本流中检测 `●` 模式的工具调用 | ✅ | `HeuristicToolParser` |
| GLM-5.1 不完整 tool_calls 处理 | 工具调用缺少 id 和 function.name | ✅ | `inferToolNameByIndex()` + 孤立状态降级 |
| 文本嵌入工具调用检测 | `<tool_use>` 标签、WebSearch/WebFetch 模式 | ✅ | `detectServerToolInText()` |
| 服务端工具 Agentic Loop | 代理端执行 web_search/web_fetch 并循环请求 | ✅ | `handleServerToolRequest()`，最多 5 轮迭代 |
| Task 工具 `run_in_background` 归一化 | 强制设为 `false` | ✅ | `normalizeTaskRunInBackground()` |
| Orphaned tool 状态降级 | 无法解析的工具调用降级为 `end_turn` | ✅ | stream.ts:270 |

## 12. 本项目独有的扩展功能

| 功能 | 说明 | 协议中是否有 |
|---|---|---|
| ThinkTagParser | 解析 `<think>` 标签转换为 thinking 块 | ❌ 代理特有，协议无此概念 |
| HeuristicToolParser | 启发式检测文本中的工具调用模式 | ❌ 代理特有 |
| GLM-5.1 兼容处理 | 处理缺少 id/name 的 tool_calls | ❌ 代理特有 |
| 文本嵌入工具调用 fallback | 支持 4 种格式的文本内工具调用检测 | ❌ 代理特有 |
| Server tool 结果降级为文本 | 避免 Claude Code 域名安全验证问题 | ❌ 代理特有 |
| Dump 日志记录 | 完整的请求/响应日志 | ❌ 代理特有 |
