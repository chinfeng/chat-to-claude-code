/** Set body[key] only when value is not null or undefined. */
export function setIfNotNone(body: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== null && value !== undefined) {
    body[key] = value;
  }
}

/** Extract an attribute from a Pydantic-like object, plain object, or dict. */
export function getBlockAttr(block: unknown, attr: string, defaultValue: unknown = null): unknown {
  if (block !== null && typeof block === "object") {
    const obj = block as Record<string, unknown>;
    if (attr in obj) return obj[attr];
  }
  return defaultValue;
}

/** Return the content block type when present. */
export function getBlockType(block: unknown): string | null {
  return getBlockAttr(block, "type") as string | null;
}
