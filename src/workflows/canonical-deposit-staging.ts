/**
 * Canonical deposit staging: the step that turns a deposit source's admitted
 * captures and its current balances into staged items (ADR 0121). Each source
 * still admits its own captures, one at a time through `admitDeposit`, so its
 * own loop keeps its progress events. This step owns the item keys, the item
 * order, and the order between the balance snapshot's validation and the
 * single stage call.
 */
import type { CanonicalFinancialDepositCapture } from "../ledger/canonical/canonical-financial-deposit-admission.ts";
import type { CanonicalSourceEvidence } from "../ledger/canonical/canonical-source-evidence.ts";
import {
  PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND,
  PGLITE_CANONICAL_MIXED_COMMIT_COMMAND,
  PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND,
} from "../ledger/pglite/workflow-commands.ts";
import type { ProductCollectionHandle, ProductStageRequest } from "../lib/automation/product-collection.ts";
import type { ProviderAcquisition, ProviderDateRule } from "./provider-response.ts";
import {
  captureCurrentStateSnapshots,
  stageCurrentStateSnapshot,
  type CurrentStateSnapshotDeclaration,
  type CurrentStateSnapshotStaging,
  type SnapshotProduct,
} from "./current-state-snapshot-capture.ts";

/** What one capture's admission decided, before the step keys and orders it. */
export type DepositDecision<Balance> =
  | Readonly<{
      /** Commit only the source evidence, keyed by its capture id. */
      product: string;
      sourceOnly: CanonicalSourceEvidence;
    }>
  | Readonly<{
      /** Commit the deposit capture, keyed by its capture id. */
      product: string;
      capture: CanonicalFinancialDepositCapture;
      /** The capture the current-balance snapshot matches rows against; absent for a capture the snapshot does not cover. */
      balance?: Balance;
      /** Source evidence committed in the same transaction as the deposit. */
      withSource?: CanonicalSourceEvidence;
      relationCommands?: ProductStageRequest["relationCommands"];
    }>;

declare const admittedThroughValidate: unique symbol;

/** A decision made inside `product.validate`. Only `admitDeposit` makes one. */
export type DepositAdmission<Balance> = DepositDecision<Balance> & Readonly<{ [admittedThroughValidate]: true }>;

/**
 * Run one capture's admission as the product's validation check (ADR 0106),
 * so a thrown admission fails as a validation failure in every source. Keep
 * browser, network and ledger reads outside `admit`.
 */
export async function admitDeposit<Balance>(
  product: Pick<ProductCollectionHandle, "validate">,
  admit: () => DepositDecision<Balance> | Promise<DepositDecision<Balance>>,
): Promise<DepositAdmission<Balance>> {
  return await product.validate(admit) as DepositAdmission<Balance>;
}

/** How the step reads the current balances: acquired now, or rows the source already read (ADR 0065). */
export type DepositCurrentBalance<Acquired extends ProviderAcquisition, Row, Balance, DateRule extends ProviderDateRule> =
  | Readonly<{
      snapshot: CurrentStateSnapshotDeclaration<Acquired, Row, Balance, DateRule>;
      acquire: () => Promise<Acquired>;
      /** When the source read the balances, if before the step acquires them. */
      observedAt?: string;
    }>
  | Readonly<{
      snapshot: CurrentStateSnapshotStaging<Row, Balance>;
      rows: readonly Row[];
    }>;

/**
 * Stage every admission and the current balances in one call, after the
 * snapshot has validated, so a broken snapshot stages no deposit. Source-only
 * items come first, then deposits in admission order, then balances. With no
 * admitted deposit that carries a balance capture, the snapshot is neither
 * read nor staged. Returns the rows the snapshot's `exclude` policy left out,
 * for the source to report.
 */
export async function stageCanonicalDeposits<Acquired extends ProviderAcquisition, Row, Balance, DateRule extends ProviderDateRule>(
  product: Pick<ProductCollectionHandle, "stage"> & SnapshotProduct,
  admissions: readonly DepositAdmission<Balance>[],
  currentBalance: DepositCurrentBalance<Acquired, Row, Balance, DateRule>,
): Promise<readonly Row[]> {
  const sourceOnly: ProductStageRequest[] = [];
  const deposits: ProductStageRequest[] = [];
  const balanceCaptures: Balance[] = [];
  for (const admission of admissions) {
    if ("sourceOnly" in admission) {
      sourceOnly.push({
        product: admission.product,
        itemKey: admission.sourceOnly.captureId,
        command: { kind: PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND, request: admission.sourceOnly },
      });
      continue;
    }
    const { capture, withSource, relationCommands } = admission;
    deposits.push({
      product: admission.product,
      itemKey: capture.captureId,
      command: withSource
        ? {
            kind: PGLITE_CANONICAL_MIXED_COMMIT_COMMAND,
            request: { steps: [{ kind: "source", request: withSource }, { kind: "deposit", request: { capture } }] },
          }
        : { kind: PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND, request: { capture } },
      ...(relationCommands ? { relationCommands } : {}),
    });
    if (admission.balance !== undefined) balanceCaptures.push(admission.balance);
  }
  const balances = balanceCaptures.length === 0
    ? { items: [], excluded: [] }
    : "rows" in currentBalance
      ? await stageCurrentStateSnapshot(currentBalance.snapshot, currentBalance.rows, { captures: balanceCaptures, product })
      : await captureCurrentStateSnapshots(currentBalance.snapshot, {
          captures: balanceCaptures,
          acquire: currentBalance.acquire,
          ...(currentBalance.observedAt === undefined ? {} : { observedAt: currentBalance.observedAt }),
          product,
        });
  product.signal.throwIfAborted();
  product.stage(...sourceOnly, ...deposits, ...balances.items);
  return balances.excluded;
}
