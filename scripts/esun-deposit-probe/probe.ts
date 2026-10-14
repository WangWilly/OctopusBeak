import { inventoryFields, safeResultCode, type FieldInventory } from "./report.ts";

export type PortalReply =
  | Readonly<{ kind: "json"; httpStatus: number; json: unknown }>
  | Readonly<{ kind: "non-json"; httpStatus: number }>
  | Readonly<{ kind: "network-error" }>
  | Readonly<{ kind: "portal-session-missing" }>;

/** Posts one `/esb/<path>` envelope from inside the signed-in page. */
export type PortalTransport = (
  path: string,
  requestBody: Readonly<Record<string, unknown>>,
  resetFlow: boolean,
) => Promise<PortalReply>;

export type DepositKind = "tw" | "fr";

export type FailureReason =
  | "http-status" | "non-json" | "network-error" | "portal-session-missing" | "envelope-invalid" | "result-code";

export type StepOutcome =
  | Readonly<{ status: "ok" }>
  | Readonly<{ status: "not-held" }>
  | Readonly<{ status: "failed"; reason: FailureReason }>
  | Readonly<{ status: "skipped"; reason: "earlier-step-failed" | "not-held" | "no-default-account" }>;

export type StepReport = Readonly<{
  step: string;
  path: string;
  httpStatus?: number;
  resultCode?: string | null;
  outcome: StepOutcome;
  fields?: FieldInventory;
}>;

export type ProbeReport = Readonly<{
  probe: "esun-deposit";
  reportVersion: 1;
  complete: boolean;
  steps: readonly StepReport[];
  observedRequests: readonly string[];
}>;

export const DEPOSIT_INIT_PATH = "mib-ctw-portal/ctw01/ctw01002/home/init";
export const PREQUERY_PATHS: Readonly<Record<DepositKind, string>> = {
  tw: "mib-ctw-portal/ctw01/ctw01002/home/preQueryTWTransactionDetail",
  fr: "mib-ctw-portal/ctw01/ctw01002/home/preQueryFRTransactionDetail",
};
export const SEARCH_PATHS: Readonly<Record<DepositKind, string>> = {
  tw: "mib-ctw-portal/ctw01/ctw01002/search/queryTWTransactionDetail",
  fr: "mib-ctw-portal/ctw01/ctw01002/search/queryFRTransactionDetail",
};
const NOT_HELD_DESCRIPTIONS: Readonly<Record<DepositKind, RegExp>> = {
  tw: /查無臺幣帳號|尚未開立臺幣帳戶/u,
  fr: /查無外幣帳號|尚未開立外幣帳戶/u,
};
const SUCCESS = "0000";
const NOT_HELD = "S001";
export const SEARCH_PAGE_SIZE = 100;
export const SEARCH_RANGE_DAYS = 31;

type StepCall = Readonly<{
  step: string;
  path: string;
  requestBody: Readonly<Record<string, unknown>>;
  resetFlow: boolean;
  kind: DepositKind;
}>;

type Envelope = Readonly<{ resultCode?: unknown; resultDescription?: unknown; resultBody?: unknown }>;

function envelopeOf(json: unknown): Envelope | null {
  return json && typeof json === "object" && !Array.isArray(json) ? json as Envelope : null;
}

function taipeiSlashDate(instant: Date) {
  const shifted = new Date(instant.getTime() + 8 * 3_600_000);
  return [
    shifted.getUTCFullYear(),
    String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    String(shifted.getUTCDate()).padStart(2, "0"),
  ].join("/");
}

export function searchRange(now: Date) {
  const start = new Date(now.getTime() - SEARCH_RANGE_DAYS * 86_400_000);
  return { startDate: taipeiSlashDate(start), endDate: taipeiSlashDate(now) };
}

function defaultAccount(json: unknown): string | null {
  const body = envelopeOf(json)?.resultBody;
  if (!body || typeof body !== "object") return null;
  const account = (body as { demandDeptAcc?: unknown }).demandDeptAcc;
  return typeof account === "string" && account.trim() !== "" ? account.trim() : null;
}

async function callStep(transport: PortalTransport, call: StepCall): Promise<{ report: StepReport; json?: unknown }> {
  const base = { step: call.step, path: call.path };
  const reply = await transport(call.path, call.requestBody, call.resetFlow);
  if (reply.kind === "network-error" || reply.kind === "portal-session-missing") {
    return { report: { ...base, outcome: { status: "failed", reason: reply.kind } } };
  }
  if (reply.kind === "non-json") {
    return { report: { ...base, httpStatus: reply.httpStatus, outcome: { status: "failed", reason: "non-json" } } };
  }
  const withShape = { ...base, httpStatus: reply.httpStatus, fields: inventoryFields(reply.json) };
  if (reply.httpStatus !== 200) {
    return { report: { ...withShape, outcome: { status: "failed", reason: "http-status" } } };
  }
  const envelope = envelopeOf(reply.json);
  if (!envelope || typeof envelope.resultCode !== "string") {
    return { report: { ...withShape, outcome: { status: "failed", reason: "envelope-invalid" } } };
  }
  const resultCode = safeResultCode(envelope.resultCode);
  if (envelope.resultCode === SUCCESS) {
    return { report: { ...withShape, resultCode, outcome: { status: "ok" } }, json: reply.json };
  }
  const notHeld = call.step.endsWith("-prequery")
    && envelope.resultCode === NOT_HELD
    && typeof envelope.resultDescription === "string"
    && NOT_HELD_DESCRIPTIONS[call.kind].test(envelope.resultDescription);
  return {
    report: { ...withShape, resultCode, outcome: notHeld ? { status: "not-held" } : { status: "failed", reason: "result-code" } },
  };
}

/**
 * Walks E.SUN's deposit task for TWD then foreign-currency accounts: reset the
 * flow, pre-query the default account, then search its recent transactions.
 * The first failure stops every later call. Account numbers pass from the
 * pre-query to the search in memory and never enter the report.
 */
export async function runDepositProbe(
  transport: PortalTransport,
  options: Readonly<{ now: Date; observedRequests: () => readonly string[] }>,
): Promise<ProbeReport> {
  const steps: StepReport[] = [];
  let stopped = false;
  const skip = (step: string, path: string, reason: "earlier-step-failed" | "not-held" | "no-default-account") => {
    steps.push({ step, path, outcome: { status: "skipped", reason } });
  };

  for (const kind of ["tw", "fr"] as const) {
    const initStep = `${kind}-init`;
    const prequeryStep = `${kind}-prequery`;
    const searchStep = `${kind}-search`;
    if (stopped) {
      skip(initStep, DEPOSIT_INIT_PATH, "earlier-step-failed");
      skip(prequeryStep, PREQUERY_PATHS[kind], "earlier-step-failed");
      skip(searchStep, SEARCH_PATHS[kind], "earlier-step-failed");
      continue;
    }
    const init = await callStep(transport, { step: initStep, path: DEPOSIT_INIT_PATH, requestBody: {}, resetFlow: true, kind });
    steps.push(init.report);
    if (init.report.outcome.status !== "ok") {
      stopped = true;
      skip(prequeryStep, PREQUERY_PATHS[kind], "earlier-step-failed");
      skip(searchStep, SEARCH_PATHS[kind], "earlier-step-failed");
      continue;
    }
    const prequery = await callStep(transport, {
      step: prequeryStep, path: PREQUERY_PATHS[kind], requestBody: { account: null }, resetFlow: false, kind,
    });
    steps.push(prequery.report);
    if (prequery.report.outcome.status === "not-held") {
      skip(searchStep, SEARCH_PATHS[kind], "not-held");
      continue;
    }
    if (prequery.report.outcome.status !== "ok") {
      stopped = true;
      skip(searchStep, SEARCH_PATHS[kind], "earlier-step-failed");
      continue;
    }
    const account = defaultAccount(prequery.json);
    if (!account) {
      skip(searchStep, SEARCH_PATHS[kind], "no-default-account");
      continue;
    }
    const search = await callStep(transport, {
      step: searchStep,
      path: SEARCH_PATHS[kind],
      requestBody: {
        account,
        ...searchRange(options.now),
        startIndex: 1,
        count: SEARCH_PAGE_SIZE,
        customerInputHashtag: [],
      },
      resetFlow: false,
      kind,
    });
    steps.push(search.report);
    if (search.report.outcome.status !== "ok") stopped = true;
  }

  return {
    probe: "esun-deposit",
    reportVersion: 1,
    complete: !stopped,
    steps,
    observedRequests: options.observedRequests(),
  };
}
