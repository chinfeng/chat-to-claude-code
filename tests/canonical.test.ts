import { describe, it, expect } from "bun:test";
import {
  canonicalize,
  canonicalJsonStringify,
  filterPrivateParams,
  prepareCanonicalBody,
} from "../src/conversion/canonical.js";

describe("canonicalize", () => {
  it("sorts object keys recursively (arrays preserved, primitives unchanged)", () => {
    const input = { c: 1, a: { z: 1, b: 2 }, m: [3, 1, 2] };
    const out = canonicalize(input);
    expect(Object.keys(out)).toEqual(["a", "c", "m"]);
    expect(Object.keys(out.a as Record<string, unknown>)).toEqual(["b", "z"]);
    expect(out.m).toEqual([3, 1, 2]); // array order preserved
    expect(out.c).toBe(1);
  });

  it("returns a fresh value and does not mutate the input", () => {
    const input: Record<string, unknown> = { b: 1, a: 2 };
    const out = canonicalize(input);
    expect(Object.keys(input)).toEqual(["b", "a"]); // input order preserved
    expect(Object.keys(out)).toEqual(["a", "b"]);
  });

  it("returns primitives/null/undefined unchanged (identity for scope types)", () => {
    expect(canonicalize(42)).toBe(42);
    expect(canonicalize("x")).toBe("x");
    expect(canonicalize(null)).toBeNull();
    expect(canonicalize(undefined)).toBeUndefined();
    expect(canonicalize(true)).toBe(true);
  });
});

describe("filterPrivateParams", () => {
  it("drops top-level `_`-prefixed keys", () => {
    const out = filterPrivateParams({ x: 1, _private: 2, y: 3 }) as Record<string, unknown>;
    expect(out).toEqual({ x: 1, y: 3 });
  });

  it("drops `_`-prefixed keys recursively, including inside arrays", () => {
    const out = filterPrivateParams({
      messages: [{ role: "user", _trace: "t", content: "hi" }],
      _meta: { keep: "no" },
    }) as Record<string, unknown>;
    expect("_meta" in out).toBe(false);
    const msgs = out.messages as Record<string, unknown>[];
    expect("_trace" in msgs[0]).toBe(false);
    expect(msgs[0].content).toBe("hi");
  });

  it("preserves `_`-prefixed names inside JSON-Schema name maps (properties/patternProperties/definitions/$defs)", () => {
    const out = filterPrivateParams({
      properties: { _id: { type: "string" }, name: { type: "string" } },
      patternProperties: { "^x_": { type: "number" } },
      definitions: { _Inner: { type: "object" } },
      $defs: { _Refd: { type: "string" } },
      _internal: "drop me",
    }) as Record<string, unknown>;
    expect("_internal" in out).toBe(false);
    const props = out.properties as Record<string, unknown>;
    expect("_id" in props).toBe(true);
    expect("name" in props).toBe(true);
    // Schema value objects lower in the tree are filtered normally again — a
    // `_`-prefixed annotation on an individual property's schema is dropped
    // (the object directly under `properties` is the name map; below it, the
    // schema itself is NOT a name map).
    expect("_id" in props).toBe(true);
  });

  it("returns a fresh value and does not mutate the input", () => {
    const input: Record<string, unknown> = { _a: 1, b: 2 };
    const out = filterPrivateParams(input) as Record<string, unknown>;
    expect("_a" in input).toBe(true);
    expect(out).toEqual({ b: 2 });
  });
});

describe("canonicalJsonStringify", () => {
  it("serializes with sorted keys and no incidental whitespace", () => {
    expect(canonicalJsonStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it("is stable regardless of input key order", () => {
    expect(canonicalJsonStringify({ b: 2, a: 1 })).toBe(canonicalJsonStringify({ a: 1, b: 2 }));
  });

  it("canonicalizes nested object keys inside arrays", () => {
    expect(canonicalJsonStringify([{ y: 2, x: 1 }])).toBe('[{"x":1,"y":2}]');
  });
});

describe("prepareCanonicalBody", () => {
  it("filters private params then canonicalizes key order", () => {
    const body = prepareCanonicalBody({ z: 1, a: 2, _hidden: 3 });
    expect(Object.keys(body)).toEqual(["a", "z"]);
    expect(body.a).toBe(2);
  });

  it("does not mutate the input body", () => {
    const input: Record<string, unknown> = { b: 1, a: 2, _drop: 3 };
    prepareCanonicalBody(input);
    expect(Object.keys(input)).toEqual(["b", "a", "_drop"]);
  });
});
