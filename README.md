# chat-to-claude-code

将任意 OpenAI Chat Completions 兼容端点转为 Anthropic Messages API，让 Claude Code CLI 直接使用。

## 工作原理

```
Claude Code CLI
    │  Anthropic API (SSE)
    ▼
chat-to-claude-code  ────►  OpenAI /chat/completions (SSE)
    │                          (NVIDIA NIM / OpenAI / Ollama / LM Studio / ...)
    │  Anthropic SSE
    ▼
Claude Code CLI 收到标准 Anthropic 响应
```

核心能力：

- **协议转换** — Anthropic Messages API ↔ OpenAI Chat Completions 双向转换
- **流式 SSE** — OpenAI 流式 chunk 实时转为 Anthropic SSE 事件
- **Thinking 支持** — `reasoning_content` 和 `<think>` 标签两种推理格式均转 Anthropic thinking block
- **工具调用** — 原生 `tool_calls` 和文本形式的 `● <function=...>` 启发式解析均支持
- **零依赖** — 纯 Bun runtime，无外部 npm 包

## 快速开始

### 1. 安装 Bun

```bash
curl -fsSL https://bun.sh/install | bash
```

### 2. 配置环境变量

```bash
# 必填：上游 OpenAI 兼容端点
export UPSTREAM_BASE_URL="https://integrate.api.nvidia.com/v1"

# 必填：API Key
export API_KEY="nvapi-xxxx"

# 可选：是否透传客户端 API Key（默认 true）
export ENABLE_API_KEY_PASSTHROUGH="true"

# 可选：是否启用 thinking（默认 true）
export ENABLE_THINKING="true"

# 可选：默认模型名（默认 gpt-4o）
export DEFAULT_MODEL="nvidia_nim/z-ai/glm-5.1"

# 可选：服务端口（默认 8082）
export PORT="8082"
```

### 3. 启动代理

```bash
bun run src/server/index.ts
# 或
bun run start
```

输出：

```
chat-to-claude-code listening on http://localhost:8082
  Upstream: https://integrate.api.nvidia.com/v1
  API key passthrough: true
  Thinking: true
```

### 4. 连接 Claude Code

```bash
export ANTHROPIC_BASE_URL="http://localhost:8082"
export ANTHROPIC_AUTH_TOKEN="your-token-here"
claude
```

或在单行中启动：

```bash
ANTHROPIC_BASE_URL=http://localhost:8082 ANTHROPIC_AUTH_TOKEN=freecc claude
```

## 环境变量参考

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `UPSTREAM_BASE_URL` | `https://api.openai.com/v1` | 上游 OpenAI Chat Completions 兼容端点 |
| `API_KEY` | `""` | 服务端持有的 API Key；客户端未提供时使用此值 |
| `ENABLE_API_KEY_PASSTHROUGH` | `true` | `true` = 透传客户端 `x-api-key` / `Authorization` 头 |
| `ENABLE_THINKING` | `true` | 是否将上游推理内容转为 Anthropic thinking block |
| `DEFAULT_MODEL` | `gpt-4o` | 请求未指定模型时的回退值 |
| `PORT` | `8082` | HTTP 监听端口 |

## API 端点

| 路径 | 方法 | 说明 |
|------|------|------|
| `/v1/messages` | POST | Anthropic Messages API 代理（核心端点） |
| `/health` | GET | 健康检查 |

未匹配路径返回 `404` + Anthropic 格式错误体。

## 转换细节

### 消息转换

| Anthropic | OpenAI | 说明 |
|-----------|--------|------|
| `system` (string / content blocks) | `{"role": "system", "content": "..."}` | 系统提示提取为 system message |
| `tool_use` block | `tool_calls[i]` | 工具调用参数 JSON 序列化 |
| `tool_result` block | `{"role": "tool", "tool_call_id": "..."}` | 工具结果序列化为 tool message |
| `thinking` block | `<think>...</think>` 标签嵌入 content | 由 `ReasoningReplayMode` 控制 |
| `redacted_thinking` block | 丢弃 | 不转发至上游 |

### 流式 SSE 事件映射

| OpenAI chunk | Anthropic SSE event |
|-------------|-------------------|
| `delta.reasoning_content` | `content_block_start(thinking)` + `content_block_delta(thinking_delta)` |
| `delta.content` (含 `<think>` 标签) | 解析后分发为 thinking / text delta |
| `delta.content` (纯文本) | `content_block_delta(text_delta)` |
| `delta.tool_calls` | `content_block_start(tool_use)` + `content_block_delta(input_json_delta)` |
| `finish_reason: "stop"` | `message_delta(stop_reason: "end_turn")` |
| `finish_reason: "tool_calls"` | `message_delta(stop_reason: "tool_use")` |

### Stop Reason 映射

| OpenAI | Anthropic |
|--------|-----------|
| `stop` | `end_turn` |
| `length` | `max_tokens` |
| `tool_calls` | `tool_use` |
| `content_filter` | `end_turn` |
| 其他 | `end_turn` |

### 启发式工具调用解析

部分模型不返回原生 `tool_calls`，而是将工具调用以文本形式输出：

```
● <function=read_file><parameter=path>/etc/hosts</parameter>
```

解析器会将其转为结构化 `tool_use` block。同时支持 WebFetch / WebSearch 的 JSON 文本格式：

```
Use WebFetch {"url": "https://example.com"}
Use WebSearch {"query": "test query"}
```

## 常用 Provider 配置示例

### NVIDIA NIM

```bash
export UPSTREAM_BASE_URL="https://integrate.api.nvidia.com/v1"
export API_KEY="nvapi-your-key"
export DEFAULT_MODEL="nvidia_nim/z-ai/glm-5.1"
```

### OpenAI

```bash
export UPSTREAM_BASE_URL="https://api.openai.com/v1"
export API_KEY="sk-your-key"
export DEFAULT_MODEL="gpt-4o"
```

### Ollama（本地）

```bash
export UPSTREAM_BASE_URL="http://localhost:11434/v1"
export API_KEY="ollama"
export DEFAULT_MODEL="llama3.1"
```

### LM Studio（本地）

```bash
export UPSTREAM_BASE_URL="http://localhost:1234/v1"
export API_KEY="lm-studio"
export DEFAULT_MODEL="lm-studio-model"
```

### OpenRouter

```bash
export UPSTREAM_BASE_URL="https://openrouter.ai/api/v1"
export API_KEY="sk-or-your-key"
export DEFAULT_MODEL="deepseek/deepseek-chat-v3-0324:free"
```

## 开发

### 项目结构

```
src/
├── conversion/
│   └── converter.ts      # Anthropic → OpenAI 消息/工具/系统提示转换
├── core/
│   ├── errors.ts         # Anthropic 格式错误响应
│   └── tokens.ts         # Token 估算（char/4 启发式）
├── parsers/
│   ├── think_tag_parser.ts       # <think> 标签流式解析
│   └── heuristic_tool_parser.ts  # ● <function=...> 启发式工具调用解析
├── server/
│   ├── config.ts         # 环境变量配置加载
│   ├── index.ts          # Bun.serve() 入口 + CORS
│   └── routes.ts         # HTTP 路由处理
├── sse/
│   └── builder.ts        # Anthropic SSE 事件构建器
├── transport/
│   └── stream.ts         # OpenAI 流 → Anthropic SSE 流式转换
└── utils/
    └── helpers.ts        # 通用工具函数
```

### 运行测试

```bash
bun test
```

### 开发模式（文件变更自动重启）

```bash
bun run dev
```

### 类型检查

```bash
bunx tsc --noEmit
```

## 与 free-claude-code (Python) 的差异

本项目是 [free-claude-code](https://github.com/Alishahryar1/free-claude-code) 的 TypeScript/Bun 精简移植，聚焦核心协议转换功能：

| 特性 | Python 版 | 本项目 (TS/Bun) |
|------|-----------|----------------|
| 运行时 | Python 3.14 + FastAPI | Bun |
| 外部依赖 | FastAPI, Pydantic, httpx, tiktoken 等 | 零 |
| Provider 数量 | 11 (NIM, OpenRouter, DeepSeek, Kimi, Wafer, LM Studio, llama.cpp, Ollama, OpenCode, Z.ai, OpenAI) | 1（通用 OpenAI 兼容端点） |
| Model Router | Opus/Sonnet/Haiku 多 provider 路由 | 无（单一 upstream） |
| Admin UI | 本地 Web 配置界面 | 无 |
| 请求优化 | quota mock / title skip / prefix detection / filepath mock | 无 |
| Discord/Telegram Bot | 完整 bot 集成 | 无 |
| Web Server Tools | 代理端 web_search / web_fetch | 无 |
| Rate Limiting | 令牌桶限速 | 无 |
| Token 计数 | tiktoken (cl100k_base) | char/4 估算 |
| 日志/追踪 | loguru + 结构化 trace | console |

## License

MIT
