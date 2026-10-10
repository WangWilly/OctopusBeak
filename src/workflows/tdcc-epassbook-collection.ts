import {
  readTdccFunds,
  readTdccPositions,
  tdccFundHoldingCapture,
  tdccPassbookMovementCapture,
  tdccSecuritiesHoldingCapture,
  TdccInvestmentContractError,
  type TdccAdmittedFundAccount,
  type TdccInvestmentExclusion,
} from "../ledger/canonical/tdcc-investment-admission.ts";
import {
  readTdccSettlementSnapshot,
  tdccSettlementBalanceCapture,
  tdccSettlementTransactionCapture,
  TdccSettlementContractError,
  type TdccSettlementExclusion,
} from "../ledger/canonical/tdcc-settlement-admission.ts";
import {
  PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
  PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND,
  PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND,
} from "../ledger/pglite/workflow-client.ts";
import { currentDepositBalanceCommandRequest } from "../ledger/pglite/current-deposit-balance-command.ts";
import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import type { TypedWorkflowErrorCode } from "../lib/automation/workflow-failures.ts";
import {
  TdccClient,
  TdccError,
  type TdccClientOptions,
  type TdccSession,
} from "./tdcc-epassbook-client.ts";
import type { TdccConnection, TdccIssuedSession, TdccSessionLease, TdccSessionPort } from "./tdcc-session.ts";

export const TDCC_PRODUCT_IDS = ["securities", "fund", "settlement"] as const;
export type TdccProductId = typeof TDCC_PRODUCT_IDS[number];

/** The data endpoints a run may call. Sign-in and OTP calls stay inside TdccRunSession. */
export type TdccDataClient = Pick<TdccClient, "positions" | "fundPositions" | "bankBalances" | "bankTransactions" | "tradeDetails">;

/** TDCC no longer trusts this device, or none is registered for the saved sign-in identifier. */
export class TdccDeviceRegistrationRequiredError extends Error {
  constructor() {
    super("TDCC device registration is required.");
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

/** Failures that end the whole run: every later product would fail the same way. */
export function tdccFatalCode(error: unknown): TypedWorkflowErrorCode | undefined {
  if (error instanceof TdccDeviceRegistrationRequiredError) return "device-registration-required";
  if (!(error instanceof TdccError)) return undefined;
  switch (error.failure.reason) {
    case "device-untrusted":
      return "device-registration-required";
    case "protocol-outdated":
      return "provider-protocol-outdated";
    case "session-expired":
    case "otp-expired":
      return "authentication-failed";
    case "http":
      return "source-unavailable";
    case "rejected":
      return error.endpoint === "login" || error.endpoint === "initialToken" ? "authentication-failed" : undefined;
    default:
      return undefined;
  }
}

/** A failure confined to one product: a malformed body, broken paging, or a response that breaks its Source Contract. */
export function tdccProductFailureCode(error: unknown): TypedWorkflowErrorCode | undefined {
  if (error instanceof TdccSettlementContractError || error instanceof TdccInvestmentContractError) return "source-validation-failed";
  if (error instanceof TdccError && error.failure.reason === "malformed-response") return "source-integrity-failed";
  return undefined;
}

/** Reported accounts the contract does not admit, as counts. No account number leaves the run. */
export type TdccExclusionCounts = {
  excludedUnknownInstitutionCount: number;
  excludedNonIsoCurrencyCount: number;
  excludedNonNumericAccountCount: number;
  excludedTimeDepositCount: number;
  hiddenAccountCount: number;
  excludedBankNotUpdatedCount: number;
  excludedEmptyNonIsoCurrencyCount: number;
};

export function emptyTdccExclusionCounts(): TdccExclusionCounts {
  return { excludedUnknownInstitutionCount: 0, excludedNonIsoCurrencyCount: 0, excludedNonNumericAccountCount: 0, excludedTimeDepositCount: 0, hiddenAccountCount: 0, excludedBankNotUpdatedCount: 0, excludedEmptyNonIsoCurrencyCount: 0 };
}

function countExclusions(counts: TdccExclusionCounts, exclusions: readonly (TdccSettlementExclusion | TdccInvestmentExclusion)[]) {
  for (const exclusion of exclusions) {
    switch (exclusion.reason) {
      case "unknown-institution-code": counts.excludedUnknownInstitutionCount += 1; break;
      case "non-iso-currency": counts.excludedNonIsoCurrencyCount += 1; break;
      case "non-numeric-account-number": counts.excludedNonNumericAccountCount += 1; break;
      case "time-deposits-not-admitted": counts.excludedTimeDepositCount += exclusion.count; break;
      case "hidden-account": counts.hiddenAccountCount += 1; break;
      case "bank-not-updated": counts.excludedBankNotUpdatedCount += 1; break;
      case "empty-non-iso-currency": counts.excludedEmptyNonIsoCurrencyCount += 1; break;
    }
  }
}

export type TdccProductCollection = Readonly<{
  items: readonly PGliteWorkflowRunItem[];
  sourceCaptureCount: number;
  rowCount: number;
}>;

export type TdccCollectionContext = Readonly<{
  session: TdccRunSession;
  runId: string;
  observedAt: string;
  exclusions: TdccExclusionCounts;
  admittedFundAccounts(connection: TdccConnection): Promise<readonly TdccAdmittedFundAccount[]>;
}>;

const investmentItem = (product: TdccProductId, itemKey: string, capture: ReturnType<typeof tdccSecuritiesHoldingCapture>): PGliteWorkflowRunItem => ({
  provider: "tdcc",
  product,
  itemKey,
  command: { kind: PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND, request: { capture } },
});

/** TR001 holdings and every TR002 page of each broker account. */
async function collectSecurities(context: TdccCollectionContext): Promise<TdccProductCollection> {
  const { session, runId, observedAt } = context;
  const positions = readTdccPositions(await session.call((client) => client.positions()));
  countExclusions(context.exclusions, positions.exclusions);
  const items: PGliteWorkflowRunItem[] = [];
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
  return { items, sourceCaptureCount: 1 + positions.accounts.length, rowCount };
}

/** TR051V1 holdings, with an empty snapshot for every admitted fund account TDCC no longer lists. */
async function collectFunds(context: TdccCollectionContext): Promise<TdccProductCollection> {
  const { session, runId, observedAt } = context;
  const funds = readTdccFunds(await session.call((client) => client.fundPositions()));
  countExclusions(context.exclusions, funds.exclusions);
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
  };
}

/** TSP006 balances and every TSP007 page of each admitted settlement account. */
async function collectSettlement(context: TdccCollectionContext): Promise<TdccProductCollection> {
  const { session, runId, observedAt } = context;
  const snapshot = readTdccSettlementSnapshot(await session.call((client) => client.bankBalances()));
  countExclusions(context.exclusions, snapshot.exclusions);
  const items: PGliteWorkflowRunItem[] = [];
  let rowCount = 0;
  for (const [index, account] of snapshot.accounts.entries()) {
    const capture = { observedAt, connection: session.connection, account };
    const pages = await session.call((client) => client.bankTransactions(account));
    const transactions = tdccSettlementTransactionCapture({ ...capture, captureId: `${runId}:tsp007:${account.sourceAccountKey}`, pages });
    items.push({
      provider: "tdcc",
      product: "settlement",
      itemKey: `transactions:${index}`,
      command: { kind: PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND, request: { capture: transactions } },
    });
    items.push({
      provider: "tdcc",
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
  return { items, sourceCaptureCount: 1 + snapshot.accounts.length, rowCount };
}

export const TDCC_PRODUCT_COLLECTORS: Readonly<Record<TdccProductId, (context: TdccCollectionContext) => Promise<TdccProductCollection>>> = {
  securities: collectSecurities,
  fund: collectFunds,
  settlement: collectSettlement,
};
