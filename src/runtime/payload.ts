/**
 * Picks string fields from a raw payload, mapping snake_case keys to camelCase.
 *
 * For each [camelKey, snakeKey] pair in snakeMap, reads payload[snakeKey].
 * If the value is a non-empty string (after .trim()), includes camelKey: value in the result.
 * Otherwise drops the key entirely (no undefined keys in the output).
 */
export function pickStringFields<M extends Record<string, string>>(
  payload: Record<string, unknown>,
  snakeMap: M,
): { [K in keyof M]?: string } {
  const result: Record<string, string> = {};
  for (const [camelKey, snakeKey] of Object.entries(snakeMap)) {
    const value = payload[snakeKey];
    if (typeof value === "string" && value.trim() !== "") {
      result[camelKey] = value;
    }
  }
  return result as { [K in keyof M]?: string };
}
