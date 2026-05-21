# chat-to-claude-code

将任意 OpenAI Chat Completions 兼容端点转为 Anthropic Messages API，让 Claude Code CLI 直接使用。

## 设计哲学

本项目遵循 Unix 哲学：**一个进程只对接一个上游端点**。若需同时使用多个上游（如不同模型或 provider），请启动多个进程，各自监听不同端口，由客户端或负载均衡器做路由选择。这样做的好处是：

- 每个进程简单、可预测、易调试
- 无内置路由状态，进程无状态，随起随停
- 可独立扩缩容、滚动升级，互不影响

## 项目动机

受 [free-claude-code](https://github.com/Alishahryar1/free-claude-code) 启发，本项目旨在提供一个**更轻量的部署方案**：

- **更小占用** — 纯 Bun 运行时，零 npm 依赖，磁盘和内存占用远低于 Python + FastAPI 方案
- **简化路由** — 完全去掉多上游转发，仅保留单上游的 OpenAI→Anthropic 协议中转
- **透传友好** — 支持 auth_token 透传，无需硬编码上游密钥，适合部署在极轻量服务器（如 1C1G）上
- **多进程扩展** — 需要多个上游时，只需每个上游启动一个进程，监听不同端口，由反向代理或 DNS 做路由分发

### 多上游部署示例

```bash
# 进程 1：NVIDIA NIM，监听 8082 端口
bun run src/server/index.ts \
  --upstream-base-url https://integrate.api.nvidia.com/v1 \
  --upstream-api-key nvapi-xxxx \
  --port 8082

# 进程 2：OpenRouter，监听 8083 端口
bun run src/server/index.ts \
  --upstream-base-url https://openrouter.ai/api/v1 \
  --upstream-api-key sk-or-xxxx \
  --port 8083
```

然后将 Claude Code 指向所需的上游：

```bash
# 使用 NVIDIA NIM
ANTHROPIC_BASE_URL=http://localhost:8082 claude

# 使用 OpenRouter
ANTHROPIC_BASE_URL=http://localhost:8083 claude
```

或者将两个进程置于反向代理（nginx、Caddy 等）之后，按域名或路径做路由分发。

## 工作原理

```
Claude Code CLI
    │  Anthropic API (SSE)
    ▼
chat-to-claude-code ────► OpenAI /chat/completions (SSE)
                            │  (NVIDIA NIM / OpenAI / Ollama / LM Studio / ...)
    │  Anthropic SSE
    ▼
Claude Code CLI 收到标准 Anthropic 响应
```

核心能力：

- **协议转换** — Anthropic Messages API ↔ OpenAI Chat Completions 双向转换
- **流式 SSE** — OpenAI 流式 chunk 实时转为 Anthropic SSE 事件
- **Thinking 支持** — `reasoning_content` 和 thinking tag 两种推理格式均转 Anthropic thinking block
- **工具调用** — 原生 `tool_calls` 和文本形式的 `● <function=...>` 启发式解析均支持
- **下游鉴权** — 可选 `--auth-token` 对接入方进行 x-api-key 验证
- **请求转储** — 可选 `--dump <dir>` 记录完整请求/响应，便于调试
- **零依赖** — 纯 Bun runtime，无外部 npm 包

## 快速开始

### 1. 安装 Bun

```bash
curl -fsSL https://bun.sh/install | bash
```

### 2. 启动代理

所有配置通过 CLI 参数传入：

```bash
bun run src/server/index.ts \
  --upstream-base-url https://integrate.api.nvidia.com/v1 \
  --upstream-api-key nvapi-xxxx
```

输出：

```
chat-to-claude-code listening on http://localhost:8082
  Upstream: https://integrate.api.nvidia.com/v1
  Upstream API key: configured
  Auth token: not set
  Passthrough mode: false
  Thinking: true
  Dump: disabled
```

### 3. 连接 Claude Code

```bash
export ANTHROPIC_BASE_URL="http://localhost:8082"
export ANTHROPIC_AUTH_TOKEN="your-token-here"
claude
```

或在单行中启动：

```bash
ANTHROPIC_BASE_URL=http://localhost:8082 ANTHROPIC_AUTH_TOKEN=freecc claude
```

## CLI 参数参考

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--upstream-base-url` | `https://api.openai.com/v1` | 上游 OpenAI Chat Completions 兼容端点 |
| `--upstream-api-key` | `""` | 上游 API Key；用于请求上游端点时的鉴权 |
| `--auth-token` | `""` | 下游鉴权 Token；设置后客户端需在 x-api-key 头部提供匹配的值 |
| `--port` | `8082` | HTTP 监听端口 |
| `--enable-thinking` | `true` | 将上游推理内容转为 Anthropic thinking block |
| `--no-enable-thinking` | — | 禁用 thinking 转换 |
| `--dump` | `""` | 请求转储目录；启用后每个请求写入独立子目录 |

### 透传模式

当 `--upstream-api-key` 与 `--auth-token` 均未配置时，自动启用透传模式：客户端通过 `x-api-key` 或 `Authorization` 头部传入的 Key 将原样转发给上游端点。

### 下游鉴权

设置 `--auth-token` 后，客户端请求必须携带匹配的 `x-api-key` 或 `Authorization: Bearer xxx` 头部，否则返回 401。此功能用于保护代理不被未授权的客户端调用。

### 请求转储

启用 `--dump <dir>` 后，每个下游请求会创建一个顺序编号的目录，内含 `request.log` 和 `response.log`。请求完成后，目录会重命名为 `{序号}-{开始时间}-{结束时间}` 格式，便于按时间排序和查找。流式响应的完整 SSE 事件也会被记录。

```bash
bun run src/server/index.ts \
  --upstream-base-url https://integrate.api.nvidia.com/v1 \
  --upstream-api-key nvapi-xxxx \
  --dump /var/log/chat-to-claude-code
```

转储目录结构示例：

```
/var/log/chat-to-claude-code/
└── 1-2026-05-20T08-30-00-000Z-2026-05-20T08-30-05-123Z/
    ├── request.log
    └── response.log
```

## 打包为单文件可执行

```bash
bun run build
```

生成 `chat-to-claude-code`（Windows 下为 `chat-to-claude-code.exe`），可直接运行：

```bash
./chat-to-claude-code \
  --upstream-base-url https://integrate.api.nvidia.com/v1 \
  --upstream-api-key nvapi-xxxx \
  --port 8082
```

## Docker 容器化部署

### 构建镜像

```bash
docker build -t chat-to-claude-code .
```

### 运行容器

```bash
docker run -p 8082:8082 chat-to-claude-code \
  --upstream-base-url https://integrate.api.nvidia.com/v1 \
  --upstream-api-key nvapi-xxxx
```

带下游鉴权：

```bash
docker run -p 8082:8082 chat-to-claude-code \
  --upstream-base-url https://integrate.api.nvidia.com/v1 \
  --upstream-api-key nvapi-xxxx \
  --auth-token my-secret-token
```

透传模式（无需任何 Key）：

```bash
docker run -p 8082:8082 chat-to-claude-code \
  --upstream-base-url http://localhost:11434/v1
```

## API 端点

| 路径 | 方法 | 说明 |
|------|------|------|
| `/v1/messages` | POST | Anthropic Messages API 代理（核心端点） |
| `/health` | GET | 健康检查 |

未匹配路径返回 `404` + Anthropic 格式错误体。

**注意**：`model` 字段为必填，请求体中必须包含 `model` 字段，否则返回错误。

## 转换细节

### 消息转换

| Anthropic | OpenAI | 说明 |
|-----------|--------|------|
| `system` (string / content blocks) | `{"role": "system", "content": "..."}` | 系统提示提取为 system message |
| `tool_use` block | `tool_calls[i]` | 工具调用参数 JSON 序列化 |
| `tool_result` block | `{"role": "tool", "tool_call_id": "..."}` | 工具结果序列化为 tool message |
| `thinking` block | thinking tag 嵌入 content | 由 `ReasoningReplayMode` 控制 |
| `redacted_thinking` block | 丢弃 | 不转发至上游 |

### 流式 SSE 事件映射

| OpenAI chunk | Anthropic SSE event |
|-------------|-------------------|
| `delta.reasoning_content` | `content_block_start(thinking)` + `content_block_delta(thinking_delta)` |
| `delta.content` (含 thinking tag) | 解析后分发为 thinking / text delta |
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
bun run src/server/index.ts \
  --upstream-base-url https://integrate.api.nvidia.com/v1 \
  --upstream-api-key nvapi-your-key
```

### OpenAI

```bash
bun run src/server/index.ts \
  --upstream-base-url https://api.openai.com/v1 \
  --upstream-api-key sk-your-key
```

### Ollama（本地）

```bash
bun run src/server/index.ts \
  --upstream-base-url http://localhost:11434/v1
```

### LM Studio（本地）

```bash
bun run src/server/index.ts \
  --upstream-base-url http://localhost:1234/v1
```

### OpenRouter

```bash
bun run src/server/index.ts \
  --upstream-base-url https://openrouter.ai/api/v1 \
  --upstream-api-key sk-or-your-key
```

## 开发

### 项目结构

```
src/
├── conversion/
│   └── converter.ts       # Anthropic → OpenAI 消息/工具/系统提示转换
├── core/
│   ├── dump.ts            # 请求/响应转储日志
│   ├── errors.ts          # Anthropic 格式错误响应
│   └── tokens.ts          # Token 估算（char/4 启发式）
├── parsers/
│   ├── think_tag_parser.ts       # think tag streaming parser
│   └── heuristic_tool_parser.ts  # ● <function=...> 启发式工具调用解析
├── server/
│   ├── config.ts          # CLI 参数配置加载
│   ├── index.ts           # Bun.serve() 入口 + CORS
│   └── routes.ts          # HTTP 路由处理 + 鉴权
├── sse/
│   └── builder.ts         # Anthropic SSE 事件构建器
├── transport/
│   └── stream.ts          # OpenAI 流 → Anthropic SSE 流式转换
```

### 运行测试

```bash
bun test
```

### 开发模式（文件变更自动重启）

```bash
bun run dev -- --upstream-base-url https://integrate.api.nvidia.com/v1 --upstream-api-key nvapi-xxxx
```

### 类型检查

```bash
bunx tsc --noEmit
```

### 打包

```bash
bun run build
```

## 与 free-claude-code (Python) 的差异

本项目是 [free-claude-code](https://github.com/chinfeng/free-claude-code) 的 TypeScript/Bun 精简移植，聚焦核心协议转换功能：

| 特性 | Python 版 | 本项目 (TS/Bun) |
|------|-----------|----------------|
| 运行时 | Python 3.14 + FastAPI | Bun |
| 外部依赖 | FastAPI, Pydantic, httpx, tiktoken 等 | 零 |
| Provider 数量 | 11 (NIM, OpenRouter, DeepSeek, Kimi, Wafer, LM Studio, llama.cpp, Ollama, OpenCode, Z.ai, OpenAI) | 1（通用 OpenAI 兼容端点） |
| Model Router | Opus/Sonnet/Haiku 多 provider 路由 | 无（单一 upstream） |
| 配置方式 | 环境变量 | CLI 启动参数 |
| 下游鉴权 | 无 | AUTH_TOKEN 验证 |
| 可执行文件 | 无 | bun build --compile 单文件 |
| 容器化 | 无 | Dockerfile (distroless) |
| 请求转储 | 无 | --dump 顺序目录 |
| Admin UI | 本地 Web 配置界面 | 无 |
| 请求优化 | quota mock / title skip / prefix detection / filepath mock | 无 |
| Discord/Telegram Bot | 完整 bot 集成 | 无 |
| Web Server Tools | 代理端 web_search / web_fetch | 无 |
| Rate Limiting | 令牌桶限速 | 无 |
| Token 计数 | tiktoken (cl100k_base) | char/4 估算 |
| 日志/追踪 | loguru + 结构化 trace | console + 可选 dump |

## License

MIT
