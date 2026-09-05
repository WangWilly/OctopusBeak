import type { CanonicalRuntimeOptions } from "./canonical-runtime.ts";

export type CanonicalProjectionRebuildFailureInjection =
  | "creation"
  | "population"
  | "validation"
  | "pre-switch"
  | "after-generation-creation"
  | "after-generation-population"
  | "after-validation";

export type CanonicalProjectionKnowledgePoint = {
  kind: "commit-sequence";
  commitSequence: number;
};

export type CanonicalProjectionRebuildOptions = CanonicalRuntimeOptions & {
  cutoff?: CanonicalProjectionKnowledgePoint;
  injectFailure?: CanonicalProjectionRebuildFailureInjection;
  clock?: () => string;
};

export type CanonicalProjectionRebuildResult = {
  status: "switched";
  previousGeneration: number;
  generation: number;
  cutoffCommitSequence: number;
  commitSequence: number;
  transactionCount: number;
  fieldCount: number;
};
