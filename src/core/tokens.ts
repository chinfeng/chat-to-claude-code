/** Token counting utilities. No tiktoken — use simple char-based heuristics. */

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function estimateInputTokens(messages: unknown[]): number {
  let total = 0;
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    if (typeof m.content === "string") {
      total += estimateTokens(m.content);
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") total += estimateTokens(b.text);
        if (b.type === "thinking" && typeof b.thinking === "string") total += estimateTokens(b.thinking);
        if (b.type === "tool_use") {
          total += estimateTokens(JSON.stringify(b.input ?? {}));
          total += estimateTokens(String(b.name ?? ""));
        }
        if (b.type === "tool_result") {
          if (typeof b.content === "string") total += estimateTokens(b.content);
          else if (Array.isArray(b.content)) {
            for (const sub of b.content) {
              const s = sub as Record<string, unknown>;
              if (s.type === "text" && typeof s.text === "string") total += estimateTokens(s.text);
            }
          }
        }
      }
    }
    total += 4; // per-message overhead
  }
  return Math.max(total, 1);
}
