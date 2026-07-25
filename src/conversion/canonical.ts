/** Request-body canonicalization for stable upstream wire bytes.
 *
 *  Upstream providers that do prefix-caching (e.g. newapi fronting GLM/OSS
 *  models) key their cache on the *token* prefix of the request body. Two
 *  requests that are semantically identical but differ in JSON key order — or
 *  that carry one-off internal fields whose value rotates per request — produce
 *  different token prefixes and miss the cache. To make every request for the
 *  same conversation land on the same cache entry, we
 *
 *    1. drop "private" keys (those prefixed with `_`) that the client injects
 *       for its own bookkeeping and that should never reach the upstream, and
 *    2. canonicalize the body to a stable key order (all object keys sorted,
 *       arrays preserved, primitives preserved).
 *
 *  Matches cc-switch's `filter_private_params_with_whitelist` + `canonicalize_value`
 *  (body_filter.rs / json_canonical.rs). */

/** Keys whose VALUES are JSON-Schema "name maps" — i.e. the keys directly beneath
 *  them are arbitrary *names* (property names, definition names, pattern names),
 *  not schema keywords. A `_`-prefixed name inside one of these maps is a
 *  legitimate schema property (e.g. `{ properties: { _id: {...} } }`) and must
 *  NOT be stripped; only the top-level / message-level `_`-prefixed params are
 *  dropped. */
const SCHEMA_NAME_MAP_KEYS = new Set([
  "properties",
  "patternProperties",
  "definitions",
  "$defs",
]);

/** Recursively strip keys whose name starts with `_`, EXCEPT inside JSON-Schema
 *  name maps (`properties` / `patternProperties` / `definitions` / `$defs`),
 *  whose keys are arbitrary names that legitimately begin with `_`. Returns a
 *  new value; never mutates the input. */
export function filterPrivateParams(value: unknown): unknown {
  return filterPrivate(value, false);
}

function filterPrivate(value: unknown, insideSchemaNameMap: boolean): unknown {
  if (Array.isArray(value)) {
    // Elements of an array reset the schema-name-map context — only the object
    // that is the direct value of a schema-name-map key has name-keys.
    return value.map((v) => filterPrivate(v, false));
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      if (!insideSchemaNameMap && key.startsWith("_")) continue; // drop private param
      out[key] = filterPrivate(obj[key], SCHEMA_NAME_MAP_KEYS.has(key));
    }
    return out;
  }
  return value;
}

/** Recursively canonicalize a JSON value to a stable wire form: all object keys
 *  sorted ascending, arrays preserved (order significant), primitives unchanged.
 *  Returns a NEW value; never mutates the input. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = canonicalize(obj[key]);
    }
    return out;
  }
  return value;
}

/** Canonical JSON serialization — sorted keys, no incidental whitespace. Used
 *  for tool-call `arguments` so that the same tool invocation produces the same
 *  bytes regardless of the order in which the caller assembled its input object. */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Prepare the final upstream request body: strip private `_`-prefixed params,
 *  then canonicalize key order. Order matches cc-switch
 *  (canonicalize_value(filter_private_params_with_whitelist(body, &[]))). Always
 *  returns a fresh object; never mutates the input. */
export function prepareCanonicalBody(body: Record<string, unknown>): Record<string, unknown> {
  return canonicalize(filterPrivateParams(body)) as Record<string, unknown>;
}
