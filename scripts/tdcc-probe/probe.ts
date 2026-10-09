import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  registerTdccDevice,
  type TdccRegistrationResult,
} from "../../src/workflows/tdcc-device-registration.ts";
import {
  TDCC_API_VER,
  TDCC_APP_INFO,
  TdccClient,
  TdccError,
  createTdccDeviceIdentity,
  type TdccBankAccountRef,
  type TdccBrokerAccountRef,
  type TdccClientOptions,
  type TdccFailure,
  type TdccSignInDetails,
  nextTradeCursor,
  type TdccTradeCursor,
} from "../../src/workflows/tdcc-epassbook-client.ts";
import { inventoryFields, type FieldInventory } from "./field-inventory.ts";
import type { StoredTdccDevice, StoredTdccSecrets, TdccSecretStore } from "./stored-secrets.ts";
import type { ProbeTerminal } from "./terminal.ts";

export const TDCC_PROBE_USAGE = `Usage: npm run probe:tdcc [-- --help]

Development-only TDCC e-Passbook probe (Phase 0 of ADR 0041).

Reads the TDCC sign-in details from the App's credentials.json, and asks for
them in the terminal when they are not saved. Reuses the saved session when
TDCC still accepts it. Otherwise it signs in, and registers this device with
the Email and SMS codes TDCC sends when it does not trust the device. It then
calls every e-Passbook endpoint and writes a redacted field inventory to
reports/tdcc-probe/<timestamp>.json, plus one line to
reports/tdcc-probe/session-log.jsonl.

Quit Octopus Beak before you run it. Both write credentials.json.`;

type ProbeFailure = TdccFailure | { reason: "unexpected"; errorName: string };

export type EndpointReport = Readonly<{
  calls: number;
  pages: number;
  /** Row count of each page with an `items` array, to show where paging stopped. */
  pageRows?: readonly number[];
  failures: readonly ProbeFailure[];
  inventory: FieldInventory | null;
  skipped?: string;
}>;

type SessionReuse =
  | { stored: false }
  | { stored: true; valid: boolean; ageMs: number };

type FreshLogin = Readonly<{
  at: string;
  registration: TdccRegistrationResult;
}>;

type PhoneAppAnswer = "y" | "n" | "skip";

export type TdccProbeOptions = Readonly<{
  store: TdccSecretStore;
  reportsDirectory: string;
  terminal: ProbeTerminal;
  fetch?: TdccClientOptions["fetch"];
  now?: () => Date;
}>;

/** Runs one probe and returns the report path. Never writes outside the store and reportsDirectory. */
export async function runTdccProbe(options: TdccProbeOptions): Promise<string> {
  const { store, terminal } = options;
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const secrets = store.read();
  const details = await signInDetails(store, secrets, terminal);
  const { device, reset } = deviceFor(store, secrets, details.userId);
  const savedSession = reset ? undefined : secrets.session;
  const clientFor = (session?: StoredTdccSecrets["session"]) =>
    new TdccClient({ identity: device, session, fetch: options.fetch, now });

  let client = clientFor(savedSession);
  let sessionReuse: SessionReuse = { stored: false };
  if (savedSession?.tokenId) {
    terminal.print("Checking the saved TDCC session.");
    sessionReuse = {
      stored: true,
      valid: await sessionIsValid(client),
      ageMs: startedAt.getTime() - Date.parse(savedSession.issuedAt),
    };
    terminal.print(sessionReuse.valid ? "The saved session is still valid." : "The saved session has expired.");
  }

  let freshLogin: FreshLogin | null = null;
  let issuedAt = savedSession?.issuedAt ?? startedAt.toISOString();
  if (!sessionReuse.stored || !sessionReuse.valid) {
    client = clientFor();
    freshLogin = await signIn(client, details, terminal, now);
    issuedAt = freshLogin.at;
    store.write({ session: { ...client.exportSession(), issuedAt } });
  }

  let endpoints: Record<string, EndpointReport>;
  let nonIsoSettlementAccounts: NonIsoSettlementAccount[];
  let tradeCursorExperiment: TradeCursorTrial[];
  try {
    ({ endpoints, nonIsoSettlementAccounts } = await probeEndpoints(client, terminal));
    tradeCursorExperiment = await probeTradeCursors(client, terminal);
  } finally {
    store.write({ session: { ...client.exportSession(), issuedAt } });
  }

  const phoneAppSignedOut = freshLogin ? await askPhoneAppSignedOut(terminal) : null;
  const report = {
    probedAt: startedAt.toISOString(),
    protocol: { appInfo: TDCC_APP_INFO, apiVer: TDCC_API_VER },
    device: { reset, devType: device.devType, devModel: device.devModel },
    sessionReuse,
    freshLogin,
    phoneAppSignedOut,
    endpoints,
    nonIsoSettlementAccounts,
    tradeCursorExperiment,
  };
  mkdirSync(options.reportsDirectory, { recursive: true });
  const reportPath = join(options.reportsDirectory, `${report.probedAt.replaceAll(":", "-")}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  appendFileSync(
    join(options.reportsDirectory, "session-log.jsonl"),
    `${JSON.stringify({ at: report.probedAt, sessionReuse, freshLogin, phoneAppSignedOut })}\n`,
    { mode: 0o600 },
  );
  return reportPath;
}

async function signInDetails(
  store: TdccSecretStore,
  secrets: StoredTdccSecrets,
  terminal: ProbeTerminal,
): Promise<TdccSignInDetails> {
  if (secrets.userId && secrets.password) return { userId: secrets.userId, password: secrets.password };
  terminal.print("TDCC sign-in details are not saved yet. They will be saved, encrypted, in credentials.json.");
  const userId = secrets.userId ?? await terminal.ask("TDCC user ID: ");
  const password = secrets.password ?? await terminal.askHidden("TDCC password: ");
  if (!userId || !password) throw new Error("TDCC sign-in details are required.");
  store.write({ userId, password });
  return { userId, password };
}

/** Keeps the registered device unless the sign-in identifier changed. */
function deviceFor(store: TdccSecretStore, secrets: StoredTdccSecrets, userId: string) {
  if (secrets.device?.userId === userId) return { device: secrets.device, reset: false };
  const device: StoredTdccDevice = { ...createTdccDeviceIdentity(), userId };
  store.write({ device, session: null });
  return { device, reset: true };
}

async function sessionIsValid(client: TdccClient) {
  try {
    await client.positions();
    return true;
  } catch (error) {
    if (error instanceof TdccError && error.failure.reason === "session-expired") return false;
    throw error;
  }
}

async function signIn(
  client: TdccClient,
  details: TdccSignInDetails,
  terminal: ProbeTerminal,
  now: () => Date,
): Promise<FreshLogin> {
  terminal.print("Signing in to TDCC.");
  const registration = await registerTdccDevice({
    client,
    details,
    readOtp: (channel) => terminal.ask(`Enter the TDCC code sent by ${channel === "email" ? "email" : "SMS"}: `),
  });
  if (registration.kind === "registered") {
    terminal.print(`Device registered (${registration.channels.join(" + ")}). Signing in again to confirm TDCC trusts it.`);
    await client.getInitialToken();
    if ((await client.login(details)).kind !== "trusted") {
      throw new TdccError("login", { reason: "device-untrusted", code: null });
    }
  }
  return { at: now().toISOString(), registration };
}

function probeFailure(error: unknown): ProbeFailure {
  if (error instanceof TdccError) return error.failure;
  return { reason: "unexpected", errorName: error instanceof Error ? error.name : typeof error };
}

async function collect(
  terminal: ProbeTerminal,
  name: string,
  calls: ReadonlyArray<() => Promise<unknown[]>>,
  enumSlots: readonly string[] = [],
): Promise<EndpointReport> {
  if (calls.length === 0) {
    terminal.print(`${name}: skipped, no accounts reported`);
    return { calls: 0, pages: 0, failures: [], inventory: null, skipped: "no accounts reported" };
  }
  const pages: unknown[] = [];
  const failures: ProbeFailure[] = [];
  for (const call of calls) {
    try {
      pages.push(...await call());
    } catch (error) {
      failures.push(probeFailure(error));
      if (error instanceof TdccError && error.providerMessage) {
        terminal.print(`${name}: TDCC said "${error.providerMessage}"`);
      }
    }
  }
  terminal.print(`${name}: ${calls.length} call(s), ${pages.length} page(s), ${failures.length} failure(s)`);
  const pageRows = pages.flatMap((page) => {
    const items = typeof page === "object" && page !== null ? (page as { items?: unknown }).items : undefined;
    return Array.isArray(items) ? [items.length] : [];
  });
  return {
    calls: calls.length,
    pages: pages.length,
    ...(pageRows.length > 0 ? { pageRows } : {}),
    failures,
    inventory: pages.length > 0 ? inventoryFields(pages, { enumSlots }) : null,
  };
}

// TR002 row slots that hold exchange, status, unit, credit type, stock type,
// transaction code and name, debit/credit, transaction type and currency codes.
const TRADE_CODE_SLOTS = [4, 5, 6, 7, 8, 10, 11, 14, 15, 20].map((slot) => `$[].items[][${slot}]`);

type TradeCursorTrial = Readonly<{
  firstPageRows: number;
  /** txnDate of the oldest row on page one, to compare with the earliest trade the phone App shows. */
  oldestTxnDate: string;
  secondPage: ReadonlyArray<{ cursor: string; end: boolean; rows: number } | { cursor: string; failure: ProbeFailure }>;
}>;

// Which TR002 cursor form TDCC accepts is unconfirmed, so ask for page two of
// each account with a non-empty first page in every candidate form.
const TRADE_CURSOR_FORMS: ReadonlyArray<readonly [string, (row: readonly unknown[]) => TdccTradeCursor]> = [
  ["app-joined", nextTradeCursor],
  ["postDate+txnSerNo", (row) => ({ postDate: String(row[0] ?? ""), txnSerNo: String(row[1] ?? "") })],
  ["txnSerNo-only", (row) => ({ postDate: "", txnSerNo: String(row[1] ?? "") })],
];

async function probeTradeCursors(client: TdccClient, terminal: ProbeTerminal): Promise<TradeCursorTrial[]> {
  const trials: TradeCursorTrial[] = [];
  for (const account of brokerAccounts(await client.positions())) {
    const first = await client.tradeDetailsPage(account);
    if (first.end) continue;
    const last = first.rows.at(-1)!;
    const secondPage: TradeCursorTrial["secondPage"][number][] = [];
    for (const [cursor, form] of TRADE_CURSOR_FORMS) {
      try {
        const page = await client.tradeDetailsPage(account, form(last));
        secondPage.push({ cursor, end: page.end, rows: page.rows.length });
      } catch (error) {
        secondPage.push({ cursor, failure: probeFailure(error) });
      }
    }
    terminal.print(
      `tradeCursorExperiment: first page ${first.rows.length} row(s), oldest ${String(last[9] ?? "")}; page two ${secondPage
        .map((trial) => `${trial.cursor}=${"rows" in trial ? trial.rows : "failed"}`)
        .join(", ")}`,
    );
    const oldestTxnDate = String(last[9] ?? "");
    trials.push({ firstPageRows: first.rows.length, oldestTxnDate, secondPage });
  }
  return trials;
}

async function probeEndpoints(client: TdccClient, terminal: ProbeTerminal) {
  let positions: unknown = null;
  let bankBalances: unknown = null;
  const transactionPages = new Map<string, unknown[]>();
  const endpoints: Record<string, EndpointReport> = {
    positions: await collect(terminal, "positions (TR001)", [async () => [positions = await client.positions()]]),
    fundPositions: await collect(terminal, "fundPositions (TR051V1)", [async () => [await client.fundPositions()]]),
    bankBalances: await collect(terminal, "bankBalances (TSP006)", [async () => [bankBalances = await client.bankBalances()]]),
  };
  endpoints.bankTransactions = await collect(
    terminal,
    "bankTransactions (TSP007)",
    settlementAccounts(bankBalances).map((account) => async () => {
      const pages = await client.bankTransactions(account);
      transactionPages.set(settlementAccountKey(account), pages);
      return pages;
    }),
  );
  endpoints.tradeDetails = await collect(
    terminal,
    "tradeDetails (TR002)",
    brokerAccounts(positions).map((account) => () => client.tradeDetails(account)),
    TRADE_CODE_SLOTS,
  );
  endpoints.assetTrend = client.exportSession().richUrl
    ? await collect(terminal, "assetTrend (TR087)", [async () => [await client.assetTrend("1Y")]])
    : { calls: 0, pages: 0, failures: [], inventory: null, skipped: "sign-in returned no richUrl" };
  return { endpoints, nonIsoSettlementAccounts: nonIsoSettlementAccounts(bankBalances, transactionPages) };
}

const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
    : [];

const text = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value).trim() : "";

/** Visible TSP006 settlement account rows, each with the reference the client queries TSP007 by. */
function visibleSettlementRows(body: unknown) {
  const root = records([body])[0];
  return records(root?.tspAccountInfos).flatMap((info) =>
    records(info.tspAccount)
      .filter((account) => account.isShow !== false && text(info.bankId) && text(account.accountNo))
      .map((account) => ({
        row: account,
        ref: {
          bankId: text(info.bankId),
          accountNo: text(account.accountNo),
          currency: text(account.currency) || "TWD",
        } satisfies TdccBankAccountRef,
      })));
}

/** Visible TSP006 settlement accounts, as the reference client selects them. */
export function settlementAccounts(body: unknown): TdccBankAccountRef[] {
  return visibleSettlementRows(body).map(({ ref }) => ref);
}

const settlementAccountKey = (account: TdccBankAccountRef) =>
  [account.bankId, account.accountNo, account.currency].join("\u0000");

/** Whether a decimal is non-zero, without its value. */
type NonZero = boolean | "unparseable";

export type NonIsoSettlementAccount = Readonly<{
  currency: string;
  balanceNonZero: NonZero;
  availableBalanceNonZero: NonZero;
  hasTransactions: boolean | "call-failed";
}>;

const ISO_CURRENCIES = new Set(Intl.supportedValuesOf("currency"));

function nonZero(value: unknown): NonZero {
  const lexeme = text(value);
  if (!/^[+-]?\d+(?:\.\d+)?$/u.test(lexeme)) return "unparseable";
  return /[1-9]/u.test(lexeme);
}

/**
 * ADR 0042 leaves a settlement account in a non-ISO currency such as `NAN`
 * unadmitted. The probe records only whether such an account holds anything.
 */
export function nonIsoSettlementAccounts(
  bankBalances: unknown,
  transactionPages: ReadonlyMap<string, readonly unknown[]>,
): NonIsoSettlementAccount[] {
  return visibleSettlementRows(bankBalances).flatMap(({ row, ref }) => {
    if (ISO_CURRENCIES.has(ref.currency)) return [];
    const pages = transactionPages.get(settlementAccountKey(ref));
    return [{
      currency: ref.currency,
      balanceNonZero: nonZero(row.balanceAmt),
      availableBalanceNonZero: nonZero(row.availableBalance),
      hasTransactions: pages
        ? records(pages).some((page) => Array.isArray(page.transactionDetails) && page.transactionDetails.length > 0)
        : "call-failed",
    }];
  });
}

export function brokerAccounts(body: unknown): TdccBrokerAccountRef[] {
  const root = records([body])[0];
  const byKey = new Map<string, TdccBrokerAccountRef>();
  for (const account of records(root?.accounts)) {
    const brokerNo = text(account.brokerNo);
    const brokerAccount = text(account.brokerAccount) || text(account.acctSerNo);
    if (brokerNo && brokerAccount) byKey.set(`${brokerNo}\u0000${brokerAccount}`, { brokerNo, brokerAccount });
  }
  return [...byKey.values()];
}

async function askPhoneAppSignedOut(terminal: ProbeTerminal): Promise<PhoneAppAnswer> {
  for (;;) {
    const answer = (await terminal.ask("Was the e-Passbook phone app signed out? [y/n/skip] ")).toLowerCase();
    if (answer === "y" || answer === "n" || answer === "skip") return answer;
  }
}
