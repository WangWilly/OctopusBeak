import type { DateRange } from "./sinopac-statements.ts";

export const SINOPAC_IDENTITY_FIELD_NAMES = [
  "DataText1",
  "DataText2",
  "DataText3",
  "DataText4",
  "DataText5",
  "DataText6",
  "DataText7",
  "DataText8",
  "DataText9",
  "DataText10",
  "DataText11",
] as const;

export const SINOPAC_IDENTITY_CANDIDATE_FIELD_NAMES = [
  "DataText6",
  "DataText10",
  "DataText11",
] as const;

export type SinopacIdentityFieldName =
  (typeof SINOPAC_IDENTITY_FIELD_NAMES)[number];
export type SinopacIdentityCandidateFieldName =
  (typeof SINOPAC_IDENTITY_CANDIDATE_FIELD_NAMES)[number];

type RawValue = unknown;

export type SinopacIdentityRawRow = Partial<
  Record<SinopacIdentityFieldName, RawValue>
>;

export type SinopacIdentityResponse = {
  window: DateRange;
  response: Record<string, RawValue>;
  rows: SinopacIdentityRawRow[];
};

export type SinopacIdentityCapture = {
  label: "exact-repeat-1" | "exact-repeat-2" | "overlap";
  range: DateRange;
  windows: SinopacIdentityResponse[];
};

type ValueType =
  | "undefined"
  | "null"
  | "string"
  | "number"
  | "boolean"
  | "array"
  | "object"
  | "function";

type LengthBucket =
  | "absent"
  | "empty"
  | "1-8"
  | "9-32"
  | "33-128"
  | "129+"
  | "not-applicable";

type CountMap = Record<ValueType, number>;
type LengthMap = Record<LengthBucket, number>;

export type SinopacIdentityValueProfile = {
  presentCount: number;
  nonEmptyCount: number;
  typeCounts: CountMap;
  lengthBuckets: LengthMap;
};

type CandidatePopulation = {
  populatedRows: number;
  uniqueValues: number;
  duplicateValueRows: number;
  uniqueWithinCapture: boolean;
};

type CandidateComparison = {
  leftPopulatedRows: number;
  rightPopulatedRows: number;
  matchedByOtherFields: number;
  equalCandidateValues: number;
  stableForMatchedRows: boolean;
};

export type SinopacIdentityCandidateEvidence = {
  populationByCapture: Record<
    SinopacIdentityCapture["label"],
    CandidatePopulation
  >;
  exactRepeat: CandidateComparison;
  overlap: CandidateComparison;
};

export type SinopacIdentityDerivedFieldEvidence = {
  formula: 'DataText4 + "<br />" + DataText5';
  populationByCapture: Record<
    SinopacIdentityCapture["label"],
    {
      evaluatedRows: number;
      exactMatches: number;
      exactForAllEvaluatedRows: boolean;
    }
  >;
};

export type SinopacIdentityCaptureSummary = {
  label: SinopacIdentityCapture["label"];
  range: DateRange;
  windowCount: number;
  responseCount: number;
  windowRowCounts: number[];
  rowCount: number;
  completeRowCount: number;
  duplicateCompleteRowGroups: number;
  duplicateCompleteRows: number;
  duplicateCompleteRowsExist: boolean;
  topLevelKeyNames: string[];
  topLevelFieldProfiles: Record<string, SinopacIdentityValueProfile>;
  rowFieldProfiles: Record<
    SinopacIdentityFieldName,
    SinopacIdentityValueProfile
  >;
};

export type SinopacIdentityRowComparison = {
  rowCountEqual: boolean;
  rowSetEqual: boolean;
  leftRowCount: number;
  rightRowCount: number;
  completeRowMatches: number;
  matchingRows: number;
  rightRowsContained: boolean;
};

export type SinopacIdentitySiteAssessment = {
  botProtectionDetected: boolean;
  fetchXhrWrapperCategory: {
    fetch: "native" | "patched" | "unknown";
    xhr: "native" | "patched" | "unknown";
  };
  challengeType: "none" | "captcha" | "cloudflare" | "generic-bot-check";
};

export type SinopacIdentityEvidenceSummary = {
  mode: "identity-validation";
  evidenceVersion: "sinopac-identity-evidence-v2";
  currency: "USD";
  accountCount: number;
  captures: SinopacIdentityCaptureSummary[];
  exactRepeat: SinopacIdentityRowComparison;
  overlap: SinopacIdentityRowComparison;
  candidateFields: Record<
    SinopacIdentityCandidateFieldName,
    SinopacIdentityCandidateEvidence
  >;
  derivedFields: {
    DataText9: SinopacIdentityDerivedFieldEvidence;
  };
  siteAssessment: SinopacIdentitySiteAssessment;
  sideEffects: {
    canonicalCommits: false;
    statementFilesWritten: false;
    rawValuesReturned: false;
  };
};

const VALUE_TYPES: ValueType[] = [
  "undefined",
  "null",
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "function",
];

const LENGTH_BUCKETS: LengthBucket[] = [
  "absent",
  "empty",
  "1-8",
  "9-32",
  "33-128",
  "129+",
  "not-applicable",
];

function emptyCounts<T extends string>(keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}

function emptyProfile(): SinopacIdentityValueProfile {
  return {
    presentCount: 0,
    nonEmptyCount: 0,
    typeCounts: emptyCounts(VALUE_TYPES),
    lengthBuckets: emptyCounts(LENGTH_BUCKETS),
  };
}

function valueType(value: RawValue): ValueType {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value as ValueType;
}

function lengthBucket(value: RawValue): LengthBucket {
  if (value === undefined) return "absent";
  if (typeof value !== "string" && !Array.isArray(value))
    return "not-applicable";
  const length = value.length;
  if (length === 0) return "empty";
  if (length <= 8) return "1-8";
  if (length <= 32) return "9-32";
  if (length <= 128) return "33-128";
  return "129+";
}

function isNonEmpty(value: RawValue): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  return value !== undefined && value !== null;
}

function addProfileValue(profile: SinopacIdentityValueProfile, value: RawValue) {
  const type = valueType(value);
  profile.typeCounts[type] += 1;
  profile.lengthBuckets[lengthBucket(value)] += 1;
  if (value !== undefined) profile.presentCount += 1;
  if (isNonEmpty(value)) profile.nonEmptyCount += 1;
}

function stableSerialize(value: RawValue): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return `string:${JSON.stringify(value)}`;
  if (typeof value === "number" || typeof value === "boolean")
    return `${typeof value}:${String(value)}`;
  if (Array.isArray(value))
    return `array:[${value.map((item) => stableSerialize(item)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, RawValue>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return `object:{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
      .join(",")}}`;
  }
  return `${typeof value}:${String(value)}`;
}

function rowSignature(row: SinopacIdentityRawRow): string {
  return SINOPAC_IDENTITY_FIELD_NAMES.map((field) =>
    stableSerialize(row[field]),
  ).join("|");
}

function rowCoreSignature(
  row: SinopacIdentityRawRow,
  candidate: SinopacIdentityCandidateFieldName,
): string {
  return SINOPAC_IDENTITY_FIELD_NAMES.filter((field) => field !== candidate)
    .map((field) => stableSerialize(row[field]))
    .join("|");
}

function candidateValue(row: SinopacIdentityRawRow, field: string): string | null {
  const value = row[field as SinopacIdentityFieldName];
  if (!isNonEmpty(value)) return null;
  return stableSerialize(value);
}

function flattenRows(capture: SinopacIdentityCapture): SinopacIdentityRawRow[] {
  return capture.windows.flatMap((window) => window.rows);
}

function duplicateCounts(values: Iterable<string>): {
  uniqueValues: number;
  duplicateValueRows: number;
} {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let duplicateValueRows = 0;
  for (const count of counts.values()) duplicateValueRows += Math.max(0, count - 1);
  return { uniqueValues: counts.size, duplicateValueRows };
}

function candidatePopulation(
  rows: SinopacIdentityRawRow[],
  field: SinopacIdentityCandidateFieldName,
): CandidatePopulation {
  const values = rows
    .map((row) => candidateValue(row, field))
    .filter((value): value is string => value !== null);
  const { uniqueValues, duplicateValueRows } = duplicateCounts(values);
  return {
    populatedRows: values.length,
    uniqueValues,
    duplicateValueRows,
    uniqueWithinCapture: duplicateValueRows === 0,
  };
}

function multisetCounts(values: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function multisetIntersectionCount(
  left: Map<string, number>,
  right: Map<string, number>,
): number {
  let total = 0;
  for (const [key, leftCount] of left) {
    total += Math.min(leftCount, right.get(key) ?? 0);
  }
  return total;
}

function compareRows(
  left: SinopacIdentityRawRow[],
  right: SinopacIdentityRawRow[],
  relation: "exact" | "overlap",
): SinopacIdentityRowComparison {
  const leftCounts = multisetCounts(left.map(rowSignature));
  const rightCounts = multisetCounts(right.map(rowSignature));
  const matchingRows = multisetIntersectionCount(leftCounts, rightCounts);
  const leftComplete = left.filter(isCompleteRow);
  const rightComplete = right.filter(isCompleteRow);
  const completeMatches = multisetIntersectionCount(
    multisetCounts(leftComplete.map(rowSignature)),
    multisetCounts(rightComplete.map(rowSignature)),
  );
  const rowSetEqual =
    left.length === right.length &&
    matchingRows === left.length &&
    [...leftCounts].every(
      ([key, count]) => (rightCounts.get(key) ?? 0) === count,
    );
  return {
    rowCountEqual: left.length === right.length,
    rowSetEqual,
    leftRowCount: left.length,
    rightRowCount: right.length,
    completeRowMatches: completeMatches,
    matchingRows,
    rightRowsContained:
      relation === "exact"
        ? rowSetEqual
        : matchingRows === right.length && right.length <= left.length,
  };
}

function isCompleteRow(row: SinopacIdentityRawRow): boolean {
  return SINOPAC_IDENTITY_FIELD_NAMES.every(
    (field) => row[field] !== undefined && row[field] !== null,
  );
}

function duplicateCompleteRowStats(rows: SinopacIdentityRawRow[]): {
  completeRowCount: number;
  duplicateCompleteRowGroups: number;
  duplicateCompleteRows: number;
} {
  const completeRows = rows.filter(isCompleteRow);
  const counts = multisetCounts(completeRows.map(rowSignature));
  let duplicateCompleteRowGroups = 0;
  let duplicateCompleteRows = 0;
  for (const count of counts.values()) {
    if (count > 1) duplicateCompleteRowGroups += 1;
    duplicateCompleteRows += Math.max(0, count - 1);
  }
  return {
    completeRowCount: completeRows.length,
    duplicateCompleteRowGroups,
    duplicateCompleteRows,
  };
}

function compareCandidate(
  left: SinopacIdentityRawRow[],
  right: SinopacIdentityRawRow[],
  field: SinopacIdentityCandidateFieldName,
): CandidateComparison {
  const leftPopulatedRows = left.filter((row) => candidateValue(row, field) !== null);
  const rightPopulatedRows = right.filter(
    (row) => candidateValue(row, field) !== null,
  );
  const leftBuckets = new Map<string, string[]>();
  const rightBuckets = new Map<string, string[]>();
  for (const row of leftPopulatedRows) {
    const key = rowCoreSignature(row, field);
    const value = candidateValue(row, field);
    if (value !== null) leftBuckets.set(key, [...(leftBuckets.get(key) ?? []), value]);
  }
  for (const row of rightPopulatedRows) {
    const key = rowCoreSignature(row, field);
    const value = candidateValue(row, field);
    if (value !== null)
      rightBuckets.set(key, [...(rightBuckets.get(key) ?? []), value]);
  }
  let matchedByOtherFields = 0;
  let equalCandidateValues = 0;
  for (const [key, leftValues] of leftBuckets) {
    const rightValues = rightBuckets.get(key) ?? [];
    matchedByOtherFields += Math.min(leftValues.length, rightValues.length);
    equalCandidateValues += multisetIntersectionCount(
      multisetCounts(leftValues),
      multisetCounts(rightValues),
    );
  }
  return {
    leftPopulatedRows: leftPopulatedRows.length,
    rightPopulatedRows: rightPopulatedRows.length,
    matchedByOtherFields,
    equalCandidateValues,
    stableForMatchedRows:
      matchedByOtherFields > 0 && equalCandidateValues === matchedByOtherFields,
  };
}

function dataText9Derivation(rows: SinopacIdentityRawRow[]) {
  const evaluableRows = rows.filter(
    (row) =>
      typeof row.DataText4 === "string" &&
      typeof row.DataText5 === "string" &&
      typeof row.DataText9 === "string",
  );
  const exactMatches = evaluableRows.filter(
    (row) => row.DataText9 === `${row.DataText4}<br />${row.DataText5}`,
  ).length;
  return {
    evaluatedRows: evaluableRows.length,
    exactMatches,
    exactForAllEvaluatedRows:
      evaluableRows.length > 0 && exactMatches === evaluableRows.length,
  };
}

function captureSummary(
  capture: SinopacIdentityCapture,
): SinopacIdentityCaptureSummary {
  const rows = flattenRows(capture);
  const rowFieldProfiles = Object.fromEntries(
    SINOPAC_IDENTITY_FIELD_NAMES.map((field) => [field, emptyProfile()]),
  ) as Record<SinopacIdentityFieldName, SinopacIdentityValueProfile>;
  for (const row of rows) {
    for (const field of SINOPAC_IDENTITY_FIELD_NAMES)
      addProfileValue(rowFieldProfiles[field], row[field]);
  }

  const topLevelKeys = new Set<string>();
  const topLevelFieldProfiles = new Map<string, SinopacIdentityValueProfile>();
  for (const window of capture.windows) {
    for (const key of Object.keys(window.response)) {
      topLevelKeys.add(key);
      const profile = topLevelFieldProfiles.get(key) ?? emptyProfile();
      addProfileValue(profile, window.response[key]);
      topLevelFieldProfiles.set(key, profile);
    }
  }
  const duplicateStats = duplicateCompleteRowStats(rows);
  return {
    label: capture.label,
    range: capture.range,
    windowCount: capture.windows.length,
    responseCount: capture.windows.length,
    windowRowCounts: capture.windows.map((window) => window.rows.length),
    rowCount: rows.length,
    ...duplicateStats,
    duplicateCompleteRowsExist: duplicateStats.duplicateCompleteRows > 0,
    topLevelKeyNames: [...topLevelKeys].sort(),
    topLevelFieldProfiles: Object.fromEntries(
      [...topLevelFieldProfiles.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    rowFieldProfiles,
  };
}

export function summarizeSinopacIdentityEvidence(
  captures: [
    SinopacIdentityCapture,
    SinopacIdentityCapture,
    SinopacIdentityCapture,
  ],
  siteAssessment: SinopacIdentitySiteAssessment,
  accountCount = 1,
): SinopacIdentityEvidenceSummary {
  const [first, second, overlap] = captures;
  const firstRows = flattenRows(first);
  const secondRows = flattenRows(second);
  const overlapRows = flattenRows(overlap);
  const candidateFields = Object.fromEntries(
    SINOPAC_IDENTITY_CANDIDATE_FIELD_NAMES.map((field) => [
      field,
      {
        populationByCapture: {
          "exact-repeat-1": candidatePopulation(firstRows, field),
          "exact-repeat-2": candidatePopulation(secondRows, field),
          overlap: candidatePopulation(overlapRows, field),
        },
        exactRepeat: compareCandidate(firstRows, secondRows, field),
        overlap: compareCandidate(firstRows, overlapRows, field),
      },
    ]),
  ) as Record<
    SinopacIdentityCandidateFieldName,
    SinopacIdentityCandidateEvidence
  >;
  return {
    mode: "identity-validation",
    evidenceVersion: "sinopac-identity-evidence-v2",
    currency: "USD",
    accountCount,
    captures: captures.map(captureSummary),
    exactRepeat: compareRows(firstRows, secondRows, "exact"),
    overlap: compareRows(firstRows, overlapRows, "overlap"),
    candidateFields,
    derivedFields: {
      DataText9: {
        formula: 'DataText4 + "<br />" + DataText5',
        populationByCapture: {
          "exact-repeat-1": dataText9Derivation(firstRows),
          "exact-repeat-2": dataText9Derivation(secondRows),
          overlap: dataText9Derivation(overlapRows),
        },
      },
    },
    siteAssessment,
    sideEffects: {
      canonicalCommits: false,
      statementFilesWritten: false,
      rawValuesReturned: false,
    },
  };
}
