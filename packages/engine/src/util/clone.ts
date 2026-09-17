/**
 * Deep clone for model objects.
 *
 * Scenario evaluation and the optimiser both need to copy a `SystemModel`
 * before editing it, so that a candidate configuration never mutates the
 * baseline. `structuredClone` would do the job, but it is an ambient global:
 * relying on it forces the engine's tsconfig to pull in the DOM or Node type
 * libraries, which this package deliberately avoids so it can be compiled and
 * consumed identically in a browser, in Node and in a test runner.
 *
 * The model is plain JSON data — numbers, strings, booleans, arrays and object
 * literals, with no Dates, Maps, functions or cyclic references — so a
 * straightforward recursive copy is both correct and faster than a
 * serialise/parse round trip.
 */

export function deepClone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = deepClone(value[i]);
    return out as unknown as T;
  }

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    out[key] = deepClone(source[key]);
  }
  return out as T;
}
