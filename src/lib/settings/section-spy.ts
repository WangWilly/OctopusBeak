/**
 * The section a reader is in: the last one whose top has scrolled up to the
 * reading line, the first before any has, and the last once the page can
 * scroll no further, since a short final section never reaches the line.
 */
export function activeSectionAt(
  sections: readonly Readonly<{ id: string; top: number }>[],
  readingLine: number,
  atEnd: boolean,
): string | null {
  if (sections.length === 0) return null;
  if (atEnd) return sections.at(-1)!.id;
  let active = sections[0]!.id;
  for (const section of sections) if (section.top <= readingLine) active = section.id;
  return active;
}
