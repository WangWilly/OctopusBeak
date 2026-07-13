import assert from "node:assert/strict";
import { isEsunCompleteGrid } from "./esun-credit-card-statements.ts";

assert.equal(
  isEsunCompleteGrid({
    currentPage: "1",
    currentPageSize: String(2_147_483_647),
  }),
  true,
);
assert.equal(
  isEsunCompleteGrid({
    currentPage: "2",
    currentPageSize: String(2_147_483_647),
  }),
  false,
);
assert.equal(
  isEsunCompleteGrid({ currentPage: "1", currentPageSize: "100" }),
  false,
);
