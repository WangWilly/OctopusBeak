/**
 * Preserve source transaction text without inventing a description. Empty
 * parts are omitted, surrounding whitespace is trimmed, and an identical
 * description/note is emitted only once.
 */
export function combineDomesticDepositDescription(
  description: unknown,
  note: unknown,
): string | null {
  const parts = [description, note]
    .map((value) => String(value ?? "").trim())
    .filter((value) => value.length > 0);
  const uniqueParts = [...new Set(parts)];
  return uniqueParts.length > 0 ? uniqueParts.join(" · ") : null;
}
