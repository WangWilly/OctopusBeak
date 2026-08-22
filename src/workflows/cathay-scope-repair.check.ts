import assert from "node:assert/strict";
import {
  cathayStatementScopeRepairRequired,
  publishCathayStatementScopeRepairStage,
} from "./cathay-statements.ts";

assert.equal(
  cathayStatementScopeRepairRequired(
    new Error("Cathay response date scope does not match the requested scope."),
  ),
  true,
);
assert.equal(
  cathayStatementScopeRepairRequired(
    new Error("Cathay count does not match details."),
  ),
  false,
);

const box = { x: 10, y: 20, width: 120, height: 32 };
const placeholder = {
  boundingBox: async () => box,
};
const page = {
  getByText: () => ({
    nth: () => placeholder,
  }),
};
const published: unknown[] = [];

await publishCathayStatementScopeRepairStage(
  page as never,
  "foreign_currency",
  (contract) => published.push(contract),
);

assert.equal(published.length, 1);
const contract = published[0] as {
  stageId: string;
  title: string;
  targets: Array<{ semanticId: string }>;
};
assert.equal(
  contract.stageId,
  "cathay-foreign_currency-statement-scope-repair",
);
assert.match(contract.title, /account|query period/i);
assert.doesNotMatch(contract.title, /OTP/i);
assert.deepEqual(
  contract.targets.map((target) => target.semanticId),
  [
    "cathay.foreign_currency.statement.account-selector",
    "cathay.foreign_currency.statement.date-selector",
  ],
);
