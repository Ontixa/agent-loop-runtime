/**
 * Deterministic JSON serialization (RFC 8785 JCS-style) for signing.
 *
 * A signature is only meaningful over bytes every verifier reproduces
 * identically. `JSON.stringify` is NOT canonical: object member order
 * follows insertion order, so two equal receipts can serialize differently.
 * This serializer emits exactly one byte sequence per JSON value:
 *
 * - object members sorted by UTF-16 code unit (JCS ordering),
 * - `undefined`/function/symbol members dropped (same as JSON.stringify),
 * - arrays keep order, whitespace-free output,
 * - numbers via JSON.stringify (shortest round-trip; -0 → 0),
 * - non-JSON values (bigint, non-finite numbers, top-level undefined)
 *   fail closed — signing an unrepresentable value is never allowed.
 */
export function canonicalJson(value: unknown): string {
  const out = serialize(value);
  if (out === undefined) {
    throw new TypeError('Value is not representable as canonical JSON');
  }
  return out;
}

function serialize(value: unknown): string | undefined {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`Non-finite number is not representable as canonical JSON: ${value}`);
      }
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        const items = value.map(item => {
          const s = serialize(item);
          // JSON.stringify serializes undefined array elements as null.
          return s === undefined ? 'null' : s;
        });
        return `[${items.join(',')}]`;
      }
      if (value instanceof Date || value instanceof RegExp ||
          value instanceof Map || value instanceof Set || ArrayBuffer.isView(value)) {
        throw new TypeError(`Non-plain object is not representable as canonical JSON: ${Object.prototype.toString.call(value)}`);
      }
      const obj = value as Record<string, unknown>;
      const members: string[] = [];
      for (const key of Object.keys(obj).sort()) {
        const s = serialize(obj[key]);
        if (s !== undefined) members.push(`${JSON.stringify(key)}:${s}`);
      }
      return `{${members.join(',')}}`;
    }
    default:
      // undefined, function, symbol, bigint
      return undefined;
  }
}
