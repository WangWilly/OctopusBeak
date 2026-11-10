/**
 * Canonical credit-card staging: the one step that turns a card issuer's
 * commit requests and its current used credit into staged items (ADR 0108,
 * ADR 0119, ADR 0121). Each issuer still builds its own commit requests,
 * inside `admitCreditCards`; this step owns their item keys, the card the
 * used credit binds to, and the order between the snapshot's validation and
 * the single stage call.
 */
import type { CreditCardCurrentBalanceCaptureInput } from "../ledger/canonical/credit-card-current-balance-admission.ts";
import type { PGliteCanonicalCreditCardCaptureRequest } from "../ledger/pglite/credit-card.ts";
import { PGLITE_CANONICAL_CREDIT_CARD_COMMIT_COMMAND } from "../ledger/pglite/workflow-commands.ts";
import type { ProductCollectionHandle, ProductStageRequest } from "../lib/automation/product-collection.ts";
import {
  stageCurrentStateSnapshot,
  type CurrentCreditCardStagingCapture,
  type CurrentStateSnapshotStaging,
  type SnapshotProduct,
} from "./current-state-snapshot-capture.ts";

/** One admitted issuer capture and the commit request the issuer built from it. */
export type CanonicalCreditCard<Capture> = Readonly<{
  capture: Capture;
  request: PGliteCanonicalCreditCardCaptureRequest;
}>;

declare const admittedThroughValidate: unique symbol;

/** An issuer's admitted cards, built inside `product.validate`. Only `admitCreditCards` makes one. */
export type CreditCardAdmission<Capture> = readonly CanonicalCreditCard<Capture>[] & Readonly<{ [admittedThroughValidate]: true }>;

/**
 * Run an issuer's whole-run card admission as the product's validation check
 * (ADR 0106), so a thrown admission fails as a validation failure for every
 * issuer. Keep browser and network reads outside `admit`.
 */
export async function admitCreditCards<Capture>(
  product: Pick<ProductCollectionHandle, "validate">,
  admit: () => readonly CanonicalCreditCard<Capture>[] | Promise<readonly CanonicalCreditCard<Capture>[]>,
): Promise<CreditCardAdmission<Capture>> {
  return await product.validate(admit) as CreditCardAdmission<Capture>;
}

/** The capture a used-credit row is built against: the issuer capture and its card identity. */
export type CurrentUsedCreditCapture<Capture> = CurrentCreditCardStagingCapture & Readonly<{ capture: Capture }>;

/** The used-credit rows an issuer read, with the declaration that stages them. */
export type CurrentUsedCredit<Row, Capture> = Readonly<{
  snapshot: CurrentStateSnapshotStaging<Row, CurrentUsedCreditCapture<Capture>, CreditCardCurrentBalanceCaptureInput>;
  rows: readonly Row[];
}>;

/**
 * Stage the cards and their current used credit in one call, after the
 * snapshot has validated, so a broken snapshot stages no card. With no cards
 * it stages nothing and does not stage the snapshot.
 *
 * Used credit is an issuer-aggregate figure (ADR 0023), and every issuer's
 * snapshot matches its rows to one issuer aggregate, so it binds to the one
 * card capture an issuer admits per run. More than one card with used credit
 * throws instead of binding the figure to a guessed card.
 */
export async function stageCanonicalCreditCards<Capture, Row>(
  product: Pick<ProductCollectionHandle, "stage"> & SnapshotProduct,
  cards: CreditCardAdmission<Capture>,
  currentUsedCredit?: CurrentUsedCredit<Row, Capture>,
): Promise<void> {
  const [first] = cards;
  if (!first) return;
  if (currentUsedCredit && cards.length > 1)
    throw new Error("Current used credit is an issuer aggregate; an issuer with used credit admits one card capture per run.");
  const balances = currentUsedCredit
    ? (await stageCurrentStateSnapshot(currentUsedCredit.snapshot, currentUsedCredit.rows, {
        captures: [{ capture: first.capture, cardIdentity: first.request.identity }],
        product,
      })).items
    : [];
  const items: ProductStageRequest[] = cards.map(({ request }) => ({
    product: "credit-card",
    itemKey: request.capture.captureId,
    command: { kind: PGLITE_CANONICAL_CREDIT_CARD_COMMIT_COMMAND, request },
  }));
  product.signal.throwIfAborted();
  product.stage(...items, ...balances);
}
