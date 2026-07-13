import { z } from "zod";

export const fullCreditCardCaptureMetadataSchema = z.object({
  snapshotMode: z.literal("full"),
  captureId: z.string().uuid(),
  capturedAt: z.string().datetime(),
  captureKinds: z.tuple([z.literal("billed"), z.literal("unbilled")]),
  cardRowCounts: z.record(
    z.string().regex(/^\d{4}$/),
    z.number().int().nonnegative(),
  ),
  completenessEvidence: z.record(z.unknown()),
});

export function captureCardRowCounts<T extends { cardKey: string }>(
  cardKeys: string[],
  rows: T[],
) {
  const counts: Record<string, number> = Object.fromEntries(
    cardKeys.map((cardKey) => [cardKey, 0]),
  );
  for (const { cardKey } of rows) counts[cardKey] = (counts[cardKey] ?? 0) + 1;
  return counts;
}

export function assignOccurrenceIndexes<
  T extends { contentKey: string; sourceRowIndex: number },
>(rows: T[]) {
  const seen = new Map<string, number>();
  return [...rows]
    .sort((a, b) => a.sourceRowIndex - b.sourceRowIndex)
    .map((row) => {
      const occurrenceIndex = seen.get(row.contentKey) ?? 0;
      seen.set(row.contentKey, occurrenceIndex + 1);
      return { ...row, occurrenceIndex };
    });
}
