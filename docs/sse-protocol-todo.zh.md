# SSE 协议未实现特性 TODO 清单

> 本文档列出 Claude Messages API SSE 流式协议中尚未在本项目中实现的特性，按优先级和实现难度分级。

## 优先级说明

- 🔴 **P0 — 关键**：影响核心功能兼容性，客户端可能因此报错或行为异常
- 🟠 **P1 — 重要**：影响部分高级功能或特定场景下的正确性
- 🟡 **P2 — 一般**：功能缺失但不影响主要使用场景
- ⚪ **P3 — 低**：锦上添花的功能，可后续迭代

---

## 🔴 P0 — 关键

### TODO-1: 实现 `signature_delta` 事件

**协议要求：** thinking 内容块中需要流式输出加密签名片段（`signature_delta`），签名用于保证多轮对话中思考内容的连续性。客户端必须将 `ThinkingBlock`（包含 `thinking` + `signature`）回传才能在后续轮次中继续使用思考上下文。

**当前状态：** 完全未实现。thinking 块仅输出 `thinking_delta`，无签名。

**影响：** 使用扩展思考（extended thinking）的多轮对话中，Claude Code 等客户端可能无法正确回传 thinking 上下文，导致后续轮次思考断裂或重新开始。

**实现思路：**
1. 在 `SSEBuilder.content_block_delta()` 中添加 `signature_delta` delta 类型支持
2. 在 `streamOpenAIChatToAnthropicSse()` 的 thinking 块处理逻辑中，在 `thinking_delta` 之后（或结束时）生成签名
3. 签名生成方式：可使用 HMAC-SHA256 对 thinking 内容签名，或生成占位签名（需确认客户端是否验证签名格式）
4. 在 `close_content_blocks()` 的 `stop_thinking_block()` 前插入签名

**相关文件：** `src/sse/builder.ts`, `src/transport/stream.ts`

---

### TODO-2: 实现 `redacted_thinking` 内容块的 SSE 输出

**协议要求：** 当思考内容被编辑（如 `display: "omitted"`）时，应输出 `redacted_thinking` 块。该块在 `content_block_start` 中即包含完整数据，无需 delta 事件，随后立即 `content_block_stop`。

**当前状态：** 仅在请求转换（converter.ts:166）时跳过 `redacted_thinking` 块；从未在 SSE 下行流中生成。

**影响：** 如果上游 API 返回包含 `redacted_thinking` 的响应，代理将无法正确转发，导致客户端丢失思考上下文标记。

**实现思路：**
1. 在 `streamOpenAIChatToAnthropicSse()` 中检测上游是否返回 `redacted_thinking` 相关数据
2. 如果上游模型返回被编辑的思考内容（opaque data），通过 `SSEBuilder.content_block_start("redacted_thinking", { data: "..." })` + `content_block_stop()` 发出
3. 在请求转换（converter.ts）中，保留 `redacted_thinking` 块以便多轮对话回传

**相关文件：** `src/sse/builder.ts`, `src/transport/stream.ts`, `src/conversion/converter.ts`

---

### TODO-3: 实现 `ping` 心跳事件

**协议要求：** 在流的任意位置（通常在首个 `content_block_start` 之后）发送 `ping` 事件以保持连接活跃。

**当前状态：** 完全未实现。从不发出 ping 事件。

**影响：** 在高延迟网络或代理服务器（如 Nginx、Cloudflare）下，长时间无数据传输可能导致连接超时断开。特别是当上游模型思考时间较长时（thinking 阶段可能持续数十秒），客户端或中间代理可能因超时而关闭连接。

**实现思路：**
1. 在 `streamOpenAIChatToAnthropicSse()` 中，在 `message_start` 之后、首个 `content_block_delta` 之前，发出一次 `ping`
2. 可选：添加定时器，在长时间无输出时自动发送 ping（需在 ReadableStream 的 start/pull 逻辑中处理）
3. SSE 格式：`event: ping\ndata: {"type":"ping"}\n\n`

**相关文件：** `src/transport/stream.ts`, `src/server/routes.ts`

---

## 🟠 P1 — 重要

### TODO-4: 实现 `citations_delta` 事件

**协议要求：** 在 text 内容块中，通过 `citations_delta` 事件流式输出引用信息。支持 5 种引用位置类型：`char_location`、`page_location`、`content_block_location`、`web_search_result_location`、`search_result_location`。

**当前状态：** 完全未实现。

**影响：** 当上游模型返回带引用的文本时（如使用文件检索或网页搜索结果），引用信息将丢失。客户端无法显示引用来源。

**实现思路：**
1. 在 `SSEBuilder.content_block_delta()` 中添加 `citations_delta` delta 类型支持
2. 需要从上游响应中提取引用信息（取决于上游 API 是否返回引用数据）
3. 对于 web_search 场景，可在 agentic loop 中根据搜索结果生成 `web_search_result_location` 类型的引用
4. 引用事件可穿插在 `text_delta` 之间

**相关文件：** `src/sse/builder.ts`, `src/transport/stream.ts`, `src/server/routes.ts`

---

### TODO-5: 细分 `error` 事件类型

**协议要求：** `error` 事件的 `error.type` 字段应区分多种错误类型：`api_error`、`overloaded_error`、`rate_limit_error`、`authentication_error`、`permission_error`、`not_found_error`、`invalid_request_error`。

**当前状态：** 所有错误均使用 `api_error` 类型。

**影响：** 客户端无法根据错误类型执行差异化处理（如对 `rate_limit_error` 实施指数退避重试，对 `overloaded_error` 短暂等待后重试）。

**实现思路：**
1. 在 `src/core/errors.ts` 中扩展 `makeAnthropicError` 或添加新的错误构造函数
2. 根据上游 HTTP 状态码映射错误类型：
   - 429 → `rate_limit_error`
   - 529 → `overloaded_error`
   - 401 → `authentication_error`
   - 403 → `permission_error`
   - 404 → `not_found_error`
   - 400 → `invalid_request_error`
   - 500+ → `api_error`
3. 在 `routes.ts` 的错误处理路径中使用细分类型

**相关文件：** `src/core/errors.ts`, `src/server/routes.ts`, `src/transport/stream.ts`

---

### TODO-6: 实现 `message_delta` 中缺失的 usage 字段

**协议要求：** `message_delta` 的 `usage` 对象应包含 `cache_creation_input_tokens`、`cache_read_input_tokens` 和 `server_tool_use`（含 `web_fetch_requests`、`web_search_requests`）。

**当前状态：** `usage` 仅有 `input_tokens` 和 `output_tokens`。

**影响：** 客户端无法获取缓存命中率和服务端工具使用统计，影响成本分析和计费计算。

**实现思路：**
1. 在 `SSEBuilder.message_start()` 和 `message_delta()` 中添加缺失字段（初始值设为 0）
2. 对于 `server_tool_use`，可在 agentic loop 中累计 `web_search`/`web_fetch` 调用次数
3. 对于缓存 token，由于代理不直接访问上游的缓存元数据，可暂设为 0 或从上游响应头中提取

**相关文件：** `src/sse/builder.ts`

---

### TODO-7: 实现 `stop_reason` 完整枚举值映射

**协议要求：** `stop_reason` 应支持 `end_turn`、`max_tokens`、`stop_sequence`、`tool_use`、`pause_turn`、`refusal`。

**当前状态：** 仅映射了 `end_turn`、`max_tokens`、`tool_use`。

**影响：** 当上游返回 `stop_sequence`、`pause_turn` 或 `refusal` 停止原因时，将被默认映射为 `end_turn`，客户端无法区分不同的停止场景。

**实现思路：**
1. 扩展 `STOP_REASON_MAP`：
   ```typescript
   const STOP_REASON_MAP: Record<string, string> = {
     stop: "end_turn",
     length: "max_tokens",
     tool_calls: "tool_use",
     content_filter: "refusal",  // 修正映射
   };
   ```
2. 添加对 `stop_sequence` 的检测（如果请求中包含 `stop_sequences` 且命中）
3. 添加对 `pause_turn` 的支持（取决于上游模型是否返回此值）

**相关文件：** `src/sse/builder.ts`

---

### TODO-8: 实现 `stop_details` 字段（refusal 场景）

**协议要求：** 当 `stop_reason` 为 `refusal` 时，`delta` 中应包含 `stop_details` 字段，含 `type`（固定 `"refusal"`）、`category`（`"cyber"` 或 `"bio"`）、`explanation`（人类可读说明）。

**当前状态：** 未实现。

**影响：** 安全拒绝场景下客户端无法获取拒绝原因和类别信息。

**实现思路：**
1. 在 `SSEBuilder.message_delta()` 中添加可选的 `stop_details` 参数
2. 当检测到 `content_filter` 类型停止原因时，构造 `stop_details` 对象
3. 从上游响应中提取拒绝原因（如果上游提供）

**相关文件：** `src/sse/builder.ts`, `src/transport/stream.ts`

---

## 🟡 P2 — 一般

### TODO-9: 实现 `container` 字段（代码执行工具）

**协议要求：** 当使用代码执行工具（code execution tool）时，`message_delta` 的 `delta` 中应包含 `container` 字段，含 `id`（容器标识）和 `expires_at`（过期时间）。

**当前状态：** 未实现。

**影响：** 如果客户端使用代码执行工具，将无法获取容器信息。

**实现思路：**
1. 在 `SSEBuilder.message_delta()` 中添加可选的 `container` 参数
2. 当检测到代码执行相关工具调用时，构造容器信息
3. 由于本项目是代理，容器信息应从上游响应中透传

**相关文件：** `src/sse/builder.ts`

---

### TODO-10: 实现 `message_start` 中缺失的 usage 字段

**协议要求：** `message_start.message.usage` 应包含 `cache_creation_input_tokens`、`cache_read_input_tokens` 和 `server_tool_use`。

**当前状态：** `usage` 仅有 `input_tokens` 和 `output_tokens`。

**影响：** 与 TODO-6 类似，但影响的是流的起始事件。客户端在流开始时即应获取完整的 usage 结构。

**实现思路：**
1. 在 `SSEBuilder.message_start()` 中补充字段：
   ```typescript
   usage: {
     input_tokens: safeInput,
     output_tokens: 1,
     cache_creation_input_tokens: 0,
     cache_read_input_tokens: 0,
     server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
   }
   ```

**相关文件：** `src/sse/builder.ts`

---

### TODO-11: 服务端工具事件的原生 SSE 输出

**协议要求：** 服务端工具（web_search/web_fetch）应通过 `server_tool_use` + `web_search_tool_result`/`web_fetch_tool_result` 内容块在 SSE 流中原生输出。

**当前状态：** `SSEBuilder` 中已有构造方法，但实际运行时将工具结果降级为文本内容块发出（为规避 Claude Code 域名安全验证问题）。

**影响：** 非标准输出格式。当 Claude Code 能访问 `claude.ai` 或使用其他客户端时，原生格式可能更合适。

**实现思路：**
1. 添加配置选项（如 `--emit-native-server-tool-events`），允许用户选择是否发出原生 server_tool_use 事件
2. 默认行为保持当前降级为文本的方式
3. 当启用原生模式时，使用已有的 `emit_server_tool_use()` / `emit_web_search_tool_result()` / `emit_web_fetch_tool_result()` 方法

**相关文件：** `src/server/routes.ts`, `src/server/config.ts`

---

### TODO-12: 完善 SSE 错误后的流关闭行为

**协议要求：** 流内错误发生后，`message_stop` 可能不会发送，且打开的内容块可能缺少 `content_block_stop`。客户端应能优雅处理部分内容。

**当前状态：** 异常捕获时调用 `close_all_blocks()` 尝试优雅关闭，但在某些极端场景（如网络突然断开）可能来不及执行。

**实现思路：**
1. 在 `ReadableStream` 的 `cancel()` 回调中确保清理所有打开的块
2. 在 `finalizeDump()` 中添加对未关闭块的检测和日志
3. 考虑在错误场景中添加超时机制，确保 `close_all_blocks()` 有机会执行

**相关文件：** `src/server/routes.ts`, `src/transport/stream.ts`

---

## ⚪ P3 — 低

### TODO-13: 实现定时 `ping` 心跳机制

**协议说明：** `ping` 事件可在流中任意位置出现，建议在思考阶段（长时间无输出）定期发送。

**当前状态：** 与 TODO-3 相关，但此项指更高级的定时心跳机制。

**实现思路：**
1. 在 `ReadableStream.start()` 中启动 `setInterval` 定时器
2. 每隔 N 秒（如 15 秒）检查是否有内容输出
3. 若长时间无输出，入队 `ping` 事件
4. 流结束时清理定时器

**相关文件：** `src/server/routes.ts`

---

### TODO-14: 支持流式响应的 prompt caching 指标透传

**协议说明：** 当使用 prompt caching 时，响应中应包含 `cache_creation_input_tokens` 和 `cache_read_input_tokens`。

**当前状态：** 未实现。无法获取上游的缓存命中指标。

**实现思路：**
1. 从上游响应头中提取缓存相关指标（如 `anthropic-cache-creation-input-tokens` 等自定义头）
2. 在 `message_start` 和 `message_delta` 中透传这些值
3. 需要确认上游 API 的具体响应头格式

**相关文件：** `src/server/routes.ts`, `src/sse/builder.ts`

---

## 实现优先级总结

| 优先级 | TODO 项 | 核心价值 |
|---|---|---|
| 🔴 P0 | TODO-1: `signature_delta` | 多轮思考连续性 |
| 🔴 P0 | TODO-2: `redacted_thinking` SSE 输出 | 思考内容编辑兼容性 |
| 🔴 P0 | TODO-3: `ping` 心跳 | 连接保活 |
| 🟠 P1 | TODO-4: `citations_delta` | 引用功能 |
| 🟠 P1 | TODO-5: 细分 error 类型 | 客户端差异化错误处理 |
| 🟠 P1 | TODO-6: `message_delta` usage 扩展 | 成本分析 |
| 🟠 P1 | TODO-7: 完整 stop_reason 映射 | 停止原因准确性 |
| 🟠 P1 | TODO-8: `stop_details` | 安全拒绝信息 |
| 🟡 P2 | TODO-9: `container` 字段 | 代码执行工具 |
| 🟡 P2 | TODO-10: `message_start` usage 扩展 | 结构完整性 |
| 🟡 P2 | TODO-11: 原生 server_tool_use 输出 | 格式标准化 |
| 🟡 P2 | TODO-12: 完善错误后流关闭 | 鲁棒性 |
| ⚪ P3 | TODO-13: 定时 ping 心跳 | 长连接稳定性 |
| ⚪ P3 | TODO-14: prompt caching 指标透传 | 缓存监控 |
