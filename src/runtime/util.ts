/**
 * Shared utility helpers used across runtime and platform modules.
 *
 * Decision 1 (trim): nonBlankString returns value.trim() — leading/trailing
 * whitespace is noise in config-like values. All callers that previously
 * returned the untrimmed string now receive the trimmed value; no test
 * asserts whitespace-preservation so this is safe.
 *
 * Decision 2 (gemini key-spread optionalString): inlined at call sites.
 *
 * Decision 3 (firstNonBlank): firstString is a strict superset; firstNonBlank
 * is deleted and its single caller in paths.ts updated to use firstString.
 */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const s = nonBlankString(value);
    if (s !== undefined) {
      return s;
    }
  }
  return undefined;
}

export function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
  for (const value of values) {
    if (isPlainObject(value)) {
      return value;
    }
  }
  return undefined;
}

export function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}
