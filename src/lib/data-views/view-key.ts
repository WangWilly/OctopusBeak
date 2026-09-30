/** A stable identity for a named view with JSON-compatible parameters. */
export function viewSubscriptionKey(view: string, params: unknown): string {
  return JSON.stringify([view, params], (_key, value: unknown) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
  });
}
