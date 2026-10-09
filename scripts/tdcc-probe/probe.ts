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
  try {
    endpoints = await probeEndpoints(client, terminal);
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
  return { calls: calls.length, pages: pages.length, failures, inventory: pages.length > 0 ? inventoryFields(pages) : null };
}

async function probeEndpoints(client: TdccClient, terminal: ProbeTerminal) {
  let positions: unknown = null;
  let bankBalances: unknown = null;
  const endpoints: Record<string, EndpointReport> = {
    positions: await collect(terminal, "positions (TR001)", [async () => [positions = await client.positions()]]),
    fundPositions: await collect(terminal, "fundPositions (TR051V1)", [async () => [await client.fundPositions()]]),
    bankBalances: await collect(terminal, "bankBalances (TSP006)", [async () => [bankBalances = await client.bankBalances()]]),
  };
  endpoints.bankTransactions = await collect(
    terminal,
    "bankTransactions (TSP007)",
    settlementAccounts(bankBalances).map((account) => () => client.bankTransactions(account)),
  );
  endpoints.tradeDetails = await collect(
    terminal,
    "tradeDetails (TR002)",
    brokerAccounts(positions).map((account) => () => client.tradeDetails(account)),
  );
  endpoints.assetTrend = client.exportSession().richUrl
    ? await collect(terminal, "assetTrend (TR087)", [async () => [await client.assetTrend("1Y")]])
    : { calls: 0, pages: 0, failures: [], inventory: null, skipped: "sign-in returned no richUrl" };
  return endpoints;
}

const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
    : [];

const text = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value).trim() : "";

/** Visible TSP006 settlement accounts, as the reference client selects them. */
export function settlementAccounts(body: unknown): TdccBankAccountRef[] {
  const root = records([body])[0];
  return records(root?.tspAccountInfos).flatMap((info) =>
    records(info.tspAccount)
      .filter((account) => account.isShow !== false && text(info.bankId) && text(account.accountNo))
      .map((account) => ({
        bankId: text(info.bankId),
        accountNo: text(account.accountNo),
        currency: text(account.currency) || "TWD",
      })));
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
