import {
  readTdccFunds,
  readTdccPositions,
  tdccFundHoldingCapture,
  tdccPassbookMovementCapture,
  tdccSecuritiesHoldingCapture,
  type TdccAdmittedFundAccount,
} from "../ledger/canonical/tdcc-investment-admission.ts";
import {
  readTdccSettlementSnapshot,
  tdccSettlementBalanceCapture,
  tdccSettlementTransactionCapture,
} from "../ledger/canonical/tdcc-settlement-admission.ts";
import {
  PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
  PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND,
  PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND,
} from "../ledger/pglite/workflow-client.ts";
import { currentDepositBalanceCommandRequest } from "../ledger/pglite/current-deposit-balance-command.ts";
import type { ProductStageRequest } from "../lib/automation/product-collection.ts";
import { FailureCodeError } from "../lib/automation/workflow-failures.ts";
import {
  TdccCollectionSummaryInvariantError,
  type TdccProductId,
  type TdccValidatedExclusion,
} from "../lib/automation/tdcc-collection-summary.ts";
import {
  TdccClient,
  TdccError,
  type TdccClientOptions,
  type TdccSession,
} from "./tdcc-epassbook-client.ts";
import type { TdccConnection, TdccIssuedSession, TdccSessionLease, TdccSessionPort } from "./tdcc-session.ts";

export { TDCC_PRODUCT_IDS, type TdccProductId } from "../lib/automation/tdcc-collection-summary.ts";

/** The data endpoints a run may call. Sign-in and OTP calls stay inside TdccRunSession. */
export type TdccDataClient = Pick<TdccClient, "positions" | "fundPositions" | "bankBalances" | "bankTransactions" | "tradeDetails">;

/** TDCC no longer trusts this device, or none is registered for the saved sign-in identifier. */
export class TdccDeviceRegistrationRequiredError extends FailureCodeError {
  constructor() {
    super("device-registration-required", "TDCC device registration is required.");
    this.name = "TdccDeviceRegistrationRequiredError";
  }
}

/**
 * One run's TDCC session. It reuses the saved token, signs in at most once
 * when TDCC rejects it, and reports every rotated token to the session port.
 * It never asks TDCC for a one-time code: an untrusted device ends the run.
 */
export class TdccRunSession {
  readonly connection: TdccConnection;
  readonly #port: TdccSessionPort;
  readonly #lease: Extract<TdccSessionLease, { status: "ready" }>;
  readonly #clientOptions: Omit<TdccClientOptions, "identity" | "session" | "onSessionChange">;
  readonly #now: () => Date;
  #issuedAt: string;
  #client: TdccClient;
  #signedIn = false;

  constructor(
    port: TdccSessionPort,
    lease: Extract<TdccSessionLease, { status: "ready" }>,
    options: Omit<TdccClientOptions, "identity" | "session" | "onSessionChange"> = {},
  ) {
    this.connection = lease.connection;
    this.#port = port;
    this.#lease = lease;
    this.#clientOptions = options;
    this.#now = options.now ?? (() => new Date());
    this.#issuedAt = lease.session?.issuedAt ?? this.#now().toISOString();
    this.#client = this.#newClient(lease.session ?? undefined);
  }

  #newClient(session?: TdccSession) {
    return new TdccClient({
      ...this.#clientOptions,
      identity: this.#lease.device,
      ...(session ? { session } : {}),
      onSessionChange: (next) => this.#port.saveSession({ ...next, issuedAt: this.#issuedAt } satisfies TdccIssuedSession),
    });
  }

  async #signIn() {
    this.#signedIn = true;
    const signIn = await this.#port.signInDetails();
    if (signIn.status !== "ready") throw new TdccDeviceRegistrationRequiredError();
    this.#issuedAt = this.#now().toISOString();
    this.#client = this.#newClient();
    await this.#client.getInitialToken();
    if ((await this.#client.login(signIn.details)).kind !== "trusted") throw new TdccDeviceRegistrationRequiredError();
  }

  async call<T>(request: (client: TdccDataClient) => Promise<T>): Promise<T> {
    if (!this.#signedIn && !this.#lease.session?.tokenId) await this.#signIn();
    try {
      return await request(this.#client);
    } catch (error) {
      if (this.#signedIn || !(error instanceof TdccError) || error.failure.reason !== "session-expired") throw error;
      await this.#signIn();
      return await request(this.#client);
    }
  }
}

export type TdccProductCollection = Readonly<{
  items: readonly ProductStageRequest[];
  sourceCaptureCount: number;
  rowCount: number;
  /** Only a fully validated source response with no accounts or exclusions proves absence. */
  absence?: "not_held";
}>;

export type TdccCollectionContext = Readonly<{
  session: TdccRunSession;
  runId: string;
  observedAt: string;
  /** Bound by the workflow to the product whose validated response is being read. */
  recordValidatedExclusions(exclusions: readonly TdccValidatedExclusion[]): void;
  admittedFundAccounts(connection: TdccConnection): Promise<readonly TdccAdmittedFundAccount[]>;
}>;

const investmentItem = (product: TdccProductId, itemKey: string, capture: ReturnType<typeof tdccSecuritiesHoldingCapture>): ProductStageRequest => ({
  product,
  itemKey,
  command: { kind: PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND, request: { capture } },
});

/** TR001 holdings and every TR002 page of each broker account. */
async function collectSecurities(context: TdccCollectionContext): Promise<TdccProductCollection> {
  const { session, runId, observedAt } = context;
  const positions = readTdccPositions(await session.call((client) => client.positions()));
  context.recordValidatedExclusions(positions.exclusions);
  const items: ProductStageRequest[] = [];
  let rowCount = 0;
  for (const [index, account] of positions.accounts.entries()) {
    const capture = { observedAt, connection: session.connection };
    items.push(investmentItem("securities", `holdings:${index}`, tdccSecuritiesHoldingCapture({
      ...capture, captureId: `${runId}:tr001:${account.accountKey}`, positions, account,
    })));
    const pages = await session.call((client) => client.tradeDetails(account));
    const movements = tdccPassbookMovementCapture({ ...capture, captureId: `${runId}:tr002:${account.accountKey}`, account, pages });
    items.push(investmentItem("securities", `passbook-movements:${index}`, movements));
    rowCount += account.holdings.length + (movements.passbookMovements?.length ?? 0);
  }
  return {
    items, sourceCaptureCount: 1 + positions.accounts.length, rowCount,
    ...(positions.accounts.length === 0 && positions.exclusions.length === 0 ? { absence: "not_held" as const } : {}),
  };
}

/** TR051V1 holdings, with an empty snapshot for every admitted fund account TDCC no longer lists. */
async function collectFunds(context: TdccCollectionContext): Promise<TdccProductCollection> {
  const { session, runId, observedAt } = context;
  const funds = readTdccFunds(await session.call((client) => client.fundPositions()));
  context.recordValidatedExclusions(funds.exclusions);
  const accounts = new Map<string, TdccAdmittedFundAccount>();
  for (const account of [...funds.accounts, ...await context.admittedFundAccounts(session.connection)])
    if (!accounts.has(account.accountKey)) accounts.set(account.accountKey, { accountKey: account.accountKey, institutionKey: account.institutionKey });
  const items = [...accounts.values()].map((account, index) => investmentItem("fund", `holdings:${index}`, tdccFundHoldingCapture({
    captureId: `${runId}:tr051v1:${account.accountKey}`,
    observedAt,
    connection: session.connection,
    funds,
    account,
  })));
  return {
    items,
    sourceCaptureCount: 1,
    rowCount: funds.accounts.reduce((total, account) => total + account.holdings.length, 0),
    ...(items.length === 0 && funds.accounts.length === 0 && funds.exclusions.length === 0 ? { absence: "not_held" as const } : {}),
  };
}

/** TSP006 balances and every TSP007 page of each admitted settlement account. */
async function collectSettlement(context: TdccCollectionContext): Promise<TdccProductCollection> {
  const { session, runId, observedAt } = context;
  const snapshot = readTdccSettlementSnapshot(await session.call((client) => client.bankBalances()));
  context.recordValidatedExclusions(snapshot.exclusions);
  const items: ProductStageRequest[] = [];
  let rowCount = 0;
  for (const [index, account] of snapshot.accounts.entries()) {
    const capture = { observedAt, connection: session.connection, account };
    const pages = await session.call((client) => client.bankTransactions(account));
    const transactions = tdccSettlementTransactionCapture({ ...capture, captureId: `${runId}:tsp007:${account.sourceAccountKey}`, pages });
    items.push({
      product: "settlement",
      itemKey: `transactions:${index}`,
      command: { kind: PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND, request: { capture: transactions } },
    });
    items.push({
      product: "settlement",
      itemKey: `balance:${index}`,
      command: {
        kind: PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
        request: currentDepositBalanceCommandRequest(tdccSettlementBalanceCapture({
          ...capture, captureId: `${runId}:tsp006:${account.sourceAccountKey}`, snapshot,
        })),
      },
    });
    rowCount += transactions.records.length;
  }
  return {
    items, sourceCaptureCount: 1 + snapshot.accounts.length, rowCount,
    ...(snapshot.accounts.length === 0 && snapshot.exclusions.length === 0 ? { absence: "not_held" as const } : {}),
  };
}

export const TDCC_PRODUCT_COLLECTORS: Readonly<Record<TdccProductId, (context: TdccCollectionContext) => Promise<TdccProductCollection>>> = {
  securities: collectSecurities,
  fund: collectFunds,
  settlement: collectSettlement,
};
