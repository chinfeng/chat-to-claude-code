# chat-to-claude-code

Convert any OpenAI Chat Completions compatible endpoint to the Anthropic Messages API, enabling Claude Code CLI to use it directly.

[中文文档](README-zh.md)

## Design Philosophy

This project follows the Unix philosophy: **one process, one upstream endpoint**. If you need multiple upstreams (e.g. different models or providers), run multiple processes on different ports and let the client or a load balancer handle routing. Benefits:

- Each process is simple, predictable, and easy to debug
- No built-in routing state — processes are stateless, start and stop at will
- Independent scaling and rolling upgrades without cross-contamination

## Motivation

Inspired by [free-claude-code](https://github.com/Alishahryar1/free-claude-code), this project was created to provide a **lighter-weight alternative** for deployment:

- **Smaller footprint** — Pure Bun runtime with zero npm dependencies, consuming less disk space and memory than a Python + FastAPI stack
- **Simplified routing** — Multi-upstream forwarding is removed entirely; only single-upstream OpenAI-to-Anthropic protocol translation remains
- **Passthrough-friendly** — Auth token passthrough allows deploying on minimal servers (e.g. 1 vCPU / 1 GB RAM) without hardcoding upstream keys
- **Multi-process scaling** — When multiple upstreams are needed, simply run one process per upstream on different ports, and let a reverse proxy or DNS route traffic

### Multi-Upstream Example

```bash
# Process 1: NVIDIA NIM on port 8082
bun run src/server/index.ts \
  --upstream-base-url https://integrate.api.nvidia.com/v1 \
  --upstream-api-key nvapi-xxxx \
  --port 8082

# Process 2: OpenRouter on port 8083
bun run src/server/index.ts \
  --upstream-base-url https://openrouter.ai/api/v1 \
  --upstream-api-key sk-or-xxxx \
  --port 8083
```

Then point Claude Code to the desired upstream:

```bash
# Use NVIDIA NIM
ANTHROPIC_BASE_URL=http://localhost:8082 claude

# Use OpenRouter
ANTHROPIC_BASE_URL=http://localhost:8083 claude
```

Or place both behind a reverse proxy (nginx, Caddy, etc.) and route by domain or path.

## How It Works

```
Claude Code CLI
    │  Anthropic API (SSE)
    ▼
chat-to-claude-code ────► OpenAI /chat/completions (SSE)
                            │  (NVIDIA NIM / OpenAI / Ollama / LM Studio / ...)
    │  Anthropic SSE
    ▼
Claude Code CLI receives standard Anthropic response
```

Key features:

- **Protocol conversion** — Anthropic Messages API ↔ OpenAI Chat Completions bidirectional translation
- **Streaming SSE** — OpenAI streaming chunks converted to Anthropic SSE events in real time
- **Thinking support** — Both `reasoning_content` and thinking tag formats are converted to Anthropic thinking blocks
- **Tool calls** — Both native `tool_calls` and heuristic text-based `● <function=...>` parsing are supported
- **Downstream auth** — Optional `--auth-token` for x-api-key verification of connecting clients
- **Request dumping** — Optional `--dump <dir>` records full request/response for debugging
- **Zero dependencies** — Pure Bun runtime, no external npm packages

## Quick Start

### 1. Install Bun

```bash
curl -fsSL https://bun.sh/install | bash
```

### 2. Start the proxy

All configuration is passed via CLI arguments:

```bash
bun run src/server/index.ts \
  --upstream-base-url https://integrate.api.nvidia.com/v1 \
  --upstream-api-key nvapi-xxxx
```

Output:

```
chat-to-claude-code listening on http://localhost:8082
  Upstream: https://integrate.api.nvidia.com/v1
  Upstream API key: configured
  Auth token: not set
  Passthrough mode: false
  Thinking: true
  Dump: disabled
```

### 3. Connect Claude Code

```bash
export ANTHROPIC_BASE_URL="http://localhost:8082"
export ANTHROPIC_AUTH_TOKEN="your-token-here"
claude
```

Or as a one-liner:

```bash
ANTHROPIC_BASE_URL=http://localhost:8082 ANTHROPIC_AUTH_TOKEN=freecc claude
```

## CLI Arguments Reference

| Argument | Default | Description |
|----------|---------|-------------|
| `--upstream-base-url` | `https://api.openai.com/v1` | Upstream OpenAI Chat Completions compatible endpoint |
| `--upstream-api-key` | `""` | Upstream API key for authenticating with the upstream endpoint |
| `--auth-token` | `""` | Downstream auth token; clients must provide a matching x-api-key header when set |
| `--port` | `8082` | HTTP listen port |
| `--enable-thinking` | `true` | Convert upstream reasoning content to Anthropic thinking blocks |
| `--no-enable-thinking` | — | Disable thinking conversion |
| `--dump` | `""` | Request dump directory; when set, each request is written to a unique subdirectory |

### Passthrough Mode

When both `--upstream-api-key` and `--auth-token` are unset, passthrough mode is automatically enabled: the key provided by the client via `x-api-key` or `Authorization` header is forwarded as-is to the upstream endpoint.

### Downstream Auth

When `--auth-token` is set, client requests must include a matching `x-api-key` or `Authorization: Bearer xxx` header, otherwise a 401 is returned. This protects the proxy from unauthorized access.

### Request Dumping

Enable `--dump <dir>` to log each downstream request into a sequentially numbered directory containing `request.log` and `response.log`. On completion, the directory is renamed to `{seq}-{startTime}-{endTime}` for chronological sorting. Full SSE event streams are also captured.

```bash
bun run src/server/index.ts \
  --upstream-base-url https://integrate.api.nvidia.com/v1 \
  --upstream-api-key nvapi-xxxx \
  --dump /var/log/chat-to-claude-code
```

Example dump directory structure:

```
/var/log/chat-to-claude-code/
└── 1-2026-05-20T08-30-00-000Z-2026-05-20T08-30-05-123Z/
    ├── request.log
    └── response.log
```

## Build as Single Executable

```bash
bun run build
```

Produces `chat-to-claude-code` (`chat-to-claude-code.exe` on Windows), which can be run directly:

```bash
./chat-to-claude-code \
  --upstream-base-url https://integrate.api.nvidia.com/v1 \
  --upstream-api-key nvapi-xxxx \
  --port 8082
```

## Docker Deployment

### Build image

```bash
docker build -t chat-to-claude-code .
```

### Run container

```bash
docker run -p 8082:8082 chat-to-claude-code \
  --upstream-base-url https://integrate.api.nvidia.com/v1 \
  --upstream-api-key nvapi-xxxx
```

With downstream auth:

```bash
docker run -p 8082:8082 chat-to-claude-code \
  --upstream-base-url https://integrate.api.nvidia.com/v1 \
  --upstream-api-key nvapi-xxxx \
  --auth-token my-secret-token
```

Passthrough mode (no keys needed):

```bash
docker run -p 8082:8082 chat-to-claude-code \
  --upstream-base-url http://localhost:11434/v1
```

## API Endpoints

| Path | Method | Description |
|------|--------|-------------|
| `/v1/messages` | POST | Anthropic Messages API proxy (core endpoint) |
| `/health` | GET | Health check |

Unmatched paths return `404` with an Anthropic-format error body.

**Note**: The `model` field is required in the request body; omitting it returns an error.

## Conversion Details

### Message Conversion

| Anthropic | OpenAI | Description |
|-----------|--------|-------------|
| `system` (string / content blocks) | `{"role": "system", "content": "..."}` | System prompt extracted as system message |
| `tool_use` block | `tool_calls[i]` | Tool call arguments JSON-serialized |
| `tool_result` block | `{"role": "tool", "tool_call_id": "..."}` | Tool result serialized as tool message |
| `thinking` block | thinking tag embedded in content | Controlled by `ReasoningReplayMode` |
| `redacted_thinking` block | Dropped | Not forwarded upstream |

### Streaming SSE Event Mapping

| OpenAI chunk | Anthropic SSE event |
|-------------|-------------------|
| `delta.reasoning_content` | `content_block_start(thinking)` + `content_block_delta(thinking_delta)` |
| `delta.content` (contains thinking tag) | Parsed and dispatched as thinking / text delta |
| `delta.content` (plain text) | `content_block_delta(text_delta)` |
| `delta.tool_calls` | `content_block_start(tool_use)` + `content_block_delta(input_json_delta)` |
| `finish_reason: "stop"` | `message_delta(stop_reason: "end_turn")` |
| `finish_reason: "tool_calls"` | `message_delta(stop_reason: "tool_use")` |

### Stop Reason Mapping

| OpenAI | Anthropic |
|--------|-----------|
| `stop` | `end_turn` |
| `length` | `max_tokens` |
| `tool_calls` | `tool_use` |
| `content_filter` | `end_turn` |
| other | `end_turn` |

### Heuristic Tool Call Parsing

Some models don't return native `tool_calls` but emit tool invocations as text:

```
● <function=read_file><parameter=path>/etc/hosts</parameter>
```

The parser converts these to structured `tool_use` blocks. It also supports WebFetch / WebSearch JSON text format:

```
Use WebFetch {"url": "https://example.com"}
Use WebSearch {"query": "test query"}
```

## Provider Configuration Examples

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

### Ollama (local)

```bash
bun run src/server/index.ts \
  --upstream-base-url http://localhost:11434/v1
```

### LM Studio (local)

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

## Development

### Project Structure

```
src/
├── conversion/
│   └── converter.ts       # Anthropic → OpenAI message/tool/system-prompt conversion
├── core/
│   ├── dump.ts            # Request/response dump logger
│   ├── errors.ts          # Anthropic-format error responses
│   └── tokens.ts          # Token estimation (char/4 heuristic)
├── parsers/
│   ├── think_tag_parser.ts       # Think tag streaming parser
│   └── heuristic_tool_parser.ts  # ● <function=...> heuristic tool call parser
├── server/
│   ├── config.ts          # CLI argument configuration loader
│   ├── index.ts           # Bun.serve() entry point + CORS
│   └── routes.ts          # HTTP route handling + auth
├── sse/
│   └── builder.ts         # Anthropic SSE event builder
├── transport/
│   └── stream.ts          # OpenAI stream → Anthropic SSE stream converter
```

### Run Tests

```bash
bun test
```

### Dev Mode (auto-restart on file change)

```bash
bun run dev -- --upstream-base-url https://integrate.api.nvidia.com/v1 --upstream-api-key nvapi-xxxx
```

### Type Check

```bash
bunx tsc --noEmit
```

### Build

```bash
bun run build
```

## Differences from free-claude-code (Python)

This project is a streamlined TypeScript/Bun port of [free-claude-code](https://github.com/chinfeng/free-claude-code), focused on core protocol conversion:

| Feature | Python version | This project (TS/Bun) |
|---------|---------------|----------------------|
| Runtime | Python 3.14 + FastAPI | Bun |
| External deps | FastAPI, Pydantic, httpx, tiktoken, etc. | Zero |
| Provider count | 11 (NIM, OpenRouter, DeepSeek, Kimi, Wafer, LM Studio, llama.cpp, Ollama, OpenCode, Z.ai, OpenAI) | 1 (generic OpenAI-compatible endpoint) |
| Model Router | Opus/Sonnet/Haiku multi-provider routing | None (single upstream) |
| Configuration | Environment variables | CLI startup arguments |
| Downstream auth | None | AUTH_TOKEN verification |
| Executable | None | bun build --compile single file |
| Containerization | None | Dockerfile (distroless) |
| Request dump | None | --dump sequential directories |
| Admin UI | Local web configuration UI | None |
| Request optimization | quota mock / title skip / prefix detection / filepath mock | None |
| Discord/Telegram Bot | Full bot integration | None |
| Web Server Tools | Proxy-side web_search / web_fetch | None |
| Rate Limiting | Token bucket rate limiting | None |
| Token counting | tiktoken (cl100k_base) | char/4 estimation |
| Logging/tracing | loguru + structured trace | console + optional dump |

## License

MIT
