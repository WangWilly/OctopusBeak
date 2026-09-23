import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PGLITE_BASELINE_SQL } from "./baseline.ts";
import { createPgliteBaselineSql } from "./baseline-generator.ts";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
assert.equal(
  digest(createPgliteBaselineSql()),
  digest(PGLITE_BASELINE_SQL),
  "the committed PGlite SQL must be regenerated from the reviewed canonical schema manifest",
);
