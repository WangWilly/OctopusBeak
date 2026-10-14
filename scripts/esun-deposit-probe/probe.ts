import { inventoryFields, safeResultCode, type FieldInventory } from "./report.ts";

export type PortalReply =
  | Readonly<{ kind: "json"; httpStatus: number; json: unknown }>
  | Readonly<{ kind: "non-json"; httpStatus: number }>
  | Readonly<{ kind: "network-error" }>
  | Readonly<{ kind: "portal-session-missing" }>;

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

const DEPOSIT_KINDS = ["tw", "fr"] as const;
const PLANNED_STEPS = DEPOSIT_KINDS.flatMap((kind) => [
  { step: `${kind}-init`, path: DEPOSIT_INIT_PATH },
  { step: `${kind}-prequery`, path: PREQUERY_PATHS[kind] },
  { step: `${kind}-search`, path: SEARCH_PATHS[kind] },
]);

async function probeKind(transport: PortalTransport, kind: DepositKind, now: Date, steps: StepReport[]): Promise<"continue" | "stop"> {
  const searchStep = `${kind}-search`;
  const init = await callStep(transport, { step: `${kind}-init`, path: DEPOSIT_INIT_PATH, requestBody: {}, resetFlow: true, kind });
  steps.push(init.report);
  if (init.report.outcome.status !== "ok") return "stop";
  const prequery = await callStep(transport, {
    step: `${kind}-prequery`, path: PREQUERY_PATHS[kind], requestBody: { account: null }, resetFlow: false, kind,
  });
  steps.push(prequery.report);
  if (prequery.report.outcome.status === "not-held") {
    steps.push({ step: searchStep, path: SEARCH_PATHS[kind], outcome: { status: "skipped", reason: "not-held" } });
    return "continue";
  }
  if (prequery.report.outcome.status !== "ok") return "stop";
  const account = defaultAccount(prequery.json);
  if (!account) {
    steps.push({ step: searchStep, path: SEARCH_PATHS[kind], outcome: { status: "skipped", reason: "no-default-account" } });
    return "continue";
  }
  const search = await callStep(transport, {
    step: searchStep,
    path: SEARCH_PATHS[kind],
    requestBody: { account, ...searchRange(now), startIndex: 1, count: SEARCH_PAGE_SIZE, customerInputHashtag: [] },
    resetFlow: false,
    kind,
  });
  steps.push(search.report);
  return search.report.outcome.status === "ok" ? "continue" : "stop";
}

export async function runDepositProbe(
  transport: PortalTransport,
  options: Readonly<{ now: Date; observedRequests: () => readonly string[] }>,
): Promise<ProbeReport> {
  const steps: StepReport[] = [];
  for (const kind of DEPOSIT_KINDS) {
    if (await probeKind(transport, kind, options.now, steps) === "stop") break;
  }
  for (const { step, path } of PLANNED_STEPS.slice(steps.length)) {
    steps.push({ step, path, outcome: { status: "skipped", reason: "earlier-step-failed" } });
  }
  return {
    probe: "esun-deposit",
    reportVersion: 1,
    complete: !steps.some((step) => step.outcome.status === "failed"),
    steps,
    observedRequests: options.observedRequests(),
  };
}
