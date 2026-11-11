import assert from "node:assert/strict";
import type { PGliteCanonicalBalanceCaptureRequest } from "../ledger/pglite/balance.ts";
import { PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND } from "../ledger/pglite/workflow-commands.ts";
import {
  productCollectionHandle,
  type ProductCollectionStageEvent,
  type ProductStageRequest,
} from "../lib/automation/product-collection.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import type { SnapshotProduct } from "./current-state-snapshot-capture.ts";

/**
 * The product a check drives a current-state snapshot declaration through:
 * its reader accepts the fixture response the check acquires, on the given
 * run clock and strict text, and it reports through `event`. A snapshot
 * returns its items, so staging or asking for a period fails the check.
 */
export function snapshotCheckProduct(
  options: Readonly<{
    /** The run clock, an RFC3339 instant. */
    now: string;
    event?: ProductCollectionStageEvent;
    signal?: AbortSignal;
  }>,
): SnapshotProduct {
  return productCollectionHandle({
    now: () => options.now,
    text: strictSourceText,
    signal: options.signal ?? new AbortController().signal,
    event: options.event ?? (async () => undefined),
    stage: () => assert.fail("a snapshot returns its items and never stages them"),
    reportActivity: async () => undefined,
    collectionPeriod: () => assert.fail("a snapshot takes no collection period"),
  });
}

/** The balance-capture request a staged current deposit balance item commits. */
export function stagedBalanceRequest(item: ProductStageRequest | undefined): PGliteCanonicalBalanceCaptureRequest {
  assert.ok(item, "the snapshot staged the balance item");
  assert.ok(item.command.kind === PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND, "the item commits a balance capture");
  return item.command.request;
}
