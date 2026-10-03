/**
 * Postgres jsonb can't store U+0000, nor lone UTF-16 surrogates: one in a tool's output (a fetched binary file, a
 * command printing NULs) would fail the whole write. Replaces them with U+FFFD everywhere in a JSON value, copying only
 * what changes.
 */
const NUL = /\u0000/g;

const cleanString = (s: string) => {
  const nulFree = s.includes("\u0000") ? s.replace(NUL, "�") : s;
  return nulFree.isWellFormed() ? nulFree : nulFree.toWellFormed();
};

export function jsonbSafe<T>(value: T): T {
  if (typeof value === "string") return cleanString(value) as T;
  if (Array.isArray(value)) {
    let out: unknown[] | null = null;
    value.forEach((v, i) => {
      const c = jsonbSafe(v);
      if (c !== v) (out ??= [...value])[i] = c;
    });
    return (out ?? value) as T;
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    let out: Record<string, unknown> | null = null;
    for (const [k, v] of Object.entries(value)) {
      const c = jsonbSafe(v);
      const key = cleanString(k);
      if (c !== v || key !== k) {
        out ??= { ...(value as Record<string, unknown>) };
        if (key !== k) delete out[k];
        out[key] = c;
      }
    }
    return (out ?? value) as T;
  }
  return value;
}
