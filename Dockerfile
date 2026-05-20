FROM oven/bun:1-alpine AS builder
WORKDIR /build
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY src/ src/
COPY tsconfig.json ./
RUN bun build src/server/index.ts --compile --outfile chat-to-claude-code

FROM oven/bun:1-alpine
COPY --from=builder /build/chat-to-claude-code /app/chat-to-claude-code
EXPOSE 8082
ENTRYPOINT ["/app/chat-to-claude-code"]
