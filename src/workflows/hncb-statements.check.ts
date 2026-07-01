import assert from "node:assert/strict";
import type { Frame, Page } from "playwright";
import { ensureHncbStatementForm } from "./hncb-statements.ts";

const page = {} as Page;
const currentFrame = {} as Frame;
const reopenedFrame = {} as Frame;

let reopened = false;
assert.equal(
  await ensureHncbStatementForm(
    page,
    async () => currentFrame,
    async () => {
      reopened = true;
      return reopenedFrame;
    },
  ),
  currentFrame,
);
assert.equal(reopened, false);

let observedTimeout = 0;
assert.equal(
  await ensureHncbStatementForm(
    page,
    async (_page, timeoutMs) => {
      observedTimeout = timeoutMs ?? 0;
      throw new Error("statement form missing");
    },
    async () => reopenedFrame,
  ),
  reopenedFrame,
);
assert.equal(observedTimeout, 5_000);
