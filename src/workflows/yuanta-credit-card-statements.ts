import { createHash, createHmac, randomUUID } from "node:crypto";
import { errors, type Locator, type Page } from "playwright";
import { z } from "zod";
import { creditCardCommandRequestFromCanonicalCapture } from "../ledger/pglite/credit-card-adapters.ts";
import {
  SourceTextIntegrityError,
  type SourceTextPort,
} from "../lib/automation/source-text.ts";
import {
  buildYuantaCanonicalCreditCardCapture as buildCanonicalYuantaCreditCardCapture,
  yuantaCanonicalSpineCapture,
  yuantaNeutralCreditCardCapture,
  YUANTA_STATEMENT_GRID,
  type YuantaCreditCardCaptureBuilderOptions,
  type YuantaCreditCardIdentityInput,
  type YuantaCreditCardSourceRow,
  type YuantaCreditCardStatementSummary,
  type YuantaCreditCardValidatedCapture,
} from "../ledger/canonical/yuanta-credit-card-admission.ts";
import { YUANTA_CREDIT_CARD_IDENTITY_EPOCHS } from "../ledger/canonical/yuanta-credit-card-human-attestation-contract.ts";
import { statementGridQueryShortfalls } from "../ledger/canonical/credit-card-query-inventory.ts";
import {
  canonicalCreditCardCurrentBalanceIdentity,
  CREDIT_CARD_CURRENT_BALANCE_ROUTE_CONTRACTS,
  type CreditCardCurrentBalanceCaptureInput,
  type CreditCardExactAmount,
} from "../ledger/canonical/credit-card-current-balance-admission.ts";
import {
  assembleCurrentCreditCardCapture,
  CURRENT_CREDIT_CARD_BALANCE_STAGING,
  issuerAggregateMatching,
  readCurrentStateSnapshot,
  type CurrentStateSnapshotDeclaration,
} from "./current-state-snapshot-capture.ts";
import { admitCreditCards, stageCanonicalCreditCards, type CurrentUsedCreditCapture } from "./canonical-credit-card-staging.ts";
import type { ProviderCharset, ProviderResponse, ProviderResponseDeclaration } from "./provider-response.ts";
import {
  endsRequestChainFrom,
  sourceReader,
  type ProviderBodyAcquisition,
  type ProviderResponseReader,
} from "./provider-response-reader.ts";
import { ProviderResponseCheckError } from "../lib/automation/provider-response-check.ts";
import { hasAttachedLocator } from "./browser-interaction.ts";
import {
  StatementComponentAbsentError,
  type ProductCollectionHandle,
  type ProductCollectionSummary,
} from "../lib/automation/product-collection.ts";
import type { WorkflowContext } from "../lib/automation/workflow-executor.ts";
import {
  deriveYuantaSourceConnectionKey,
  yuantaSourceConnectionScope,
  type YuantaStableLoginCredentials,
} from "./yuanta-auth.ts";
import {
  FrameScopeTimeoutError,
  ifFound,
  type BrowserScope,
  type FrameScope,
} from "./frame-scope.ts";
import {
  YUANTA_EBANK_ORIGIN,
  yuantaEbankSite,
  type YuantaEbankSite,
  type YuantaRoute,
} from "./yuanta-ebank-site.ts";
import {
  collectYuantaCreditCardHistorySummaries,
  hasUntraversedPager,
  hasYuantaCurrentCreditTable,
  isActiveYuantaSummaryPagerControl,
  parseCreditCardBillsHtml,
  parseYuantaCreditCardSettledStatementHistoryPage,
  parseYuantaCurrentCreditCardUsedCreditSummaryHtml,
  resolveYuantaSettledStatementCycles,
  traverseYuantaCreditCardSettledStatementSummaryPages,
  type YuantaCreditCardHistorySettledSummaryPage,
  type YuantaCreditCardIssuerSummary,
  type YuantaCreditCardMonthOption,
  type YuantaCreditCardStatementRow,
  type YuantaCreditCardSummaryTraversal,
  type YuantaCurrentUsedCreditSnapshot,
} from "./yuanta-credit-card-parser.ts";
import { taipeiDate } from "../lib/time/timezone.ts";
import { collapseSourceWhitespace } from "../lib/automation/source-text.ts";

type MonthOption = YuantaCreditCardMonthOption;

type StatementKind = "unbilled" | "billed";
export type YuantaCreditCardCaptureMetadata =
  | {
      snapshotMode: "full";
      captureId: string;
      capturedAt: string;
      captureKinds: ["billed", "unbilled"];
      completenessEvidence: Record<string, unknown>;
    }
  | {
      snapshotMode: "partial";
      completenessEvidence: Record<string, unknown>;
    };

type CaptureMetadata = YuantaCreditCardCaptureMetadata;

type StatementRow = YuantaCreditCardStatementRow;

/** The summary's POST response was observed, but its page could not be read. */
class YuantaCurrentCreditReadError extends Error {
  constructor(cause: unknown) {
    super("YuanTa credit-card summary responded, but its current used credit could not be read.", { cause });
    this.name = "YuantaCurrentCreditReadError";
  }
}

class YuantaCreditSummaryNavigationError extends Error {
  constructor() {
    super("YuanTa credit-card current-summary navigation did not reach the reviewed page.");
    this.name = "YuantaCreditSummaryNavigationError";
  }
}

export const yuantaCreditCardStatementsInputSchema = z.object({
  monthIndexes: z.array(z.number().int().min(0).max(24)).optional(),
  includeUnbilled: z.boolean().default(true),
  includePaymentDetails: z.boolean().default(true),
  includeSummary: z.boolean().default(true),
});
const inputSchema = yuantaCreditCardStatementsInputSchema;

type WorkflowInput = z.infer<typeof inputSchema>;

/**
 * The workflow's Yuanta identity epoch is declared by the human-attested
 * credit-card contract. The stable login identity derives the shared Source
 * Connection key; the managed secret is used only for the separate portfolio
 * attestation. Neither is returned as raw input.
 */
export const YUANTA_CREDIT_CARD_IDENTITY_EPOCH = YUANTA_CREDIT_CARD_IDENTITY_EPOCHS.current;

export type YuantaCanonicalHumanAttestation = {
  sourceConnectionKey: string;
  identityEpochKey: typeof YUANTA_CREDIT_CARD_IDENTITY_EPOCH;
  humanAttestedAccountKey: string;
};

export type YuantaCreditCardCollectionInput = WorkflowInput & Readonly<{
  canonicalHumanAttestation: YuantaCanonicalHumanAttestation;
  /** Device-owned managed secret; consumed only while deriving opaque instruments. */
  instrumentFingerprintSecret: string;
}>;

export type YuantaCreditCardCanonicalCaptureInput = {
  capture: YuantaCreditCardCaptureMetadata;
  identity: YuantaCreditCardIdentityInput;
  /** Device-owned managed secret; consumed only while deriving opaque instruments. */
  instrumentFingerprintSecret: string;
  allMonthOptions: readonly MonthOption[];
  selectedMonthOptions: readonly MonthOption[];
  includeUnbilled: boolean;
  includeSummary: boolean;
  terminalPages: readonly boolean[];
  billedRows: readonly YuantaCreditCardStatementRow[];
  unbilledRows: readonly YuantaCreditCardStatementRow[];
  statementSummaries?: readonly YuantaCreditCardStatementSummary[];
};

function hmacYuantaIdentity(secret: string, value: unknown): string {
  return createHmac("sha256", secret)
    .update(JSON.stringify(value))
    .digest("base64url");
}

type YuantaProjectedInstrumentIdentity = {
  instrumentKey: string;
  cardMask: `****${number}${number}${number}${number}`;
};

/**
 * Parse the exact masked label observed on both Yuanta grids and immediately
 * reduce its first-six + last-four projection to an account-scoped HMAC.
 * Full PANs, last-four-only values, malformed masks, and empty secrets are
 * deliberately rejected.
 */
export function deriveYuantaProjectedInstrumentIdentity(
  cardLabel: string,
  identity: YuantaCreditCardIdentityInput,
  managedSecret: string,
): YuantaProjectedInstrumentIdentity | undefined {
  const secret = managedSecret.trim();
  if (!secret) return undefined;
  const normalized = collapseSourceWhitespace(cardLabel)
    .normalize("NFKC")
    .replace(/[‐‑‒–—−]/gu, "-");
  const match = normalized.match(
    /^(\d{4})-(\d{2})([xX*•●]{2})-([xX*•●]{4})-(\d{4})$/u,
  );
  if (!match) return undefined;
  const firstSix = `${match[1]}${match[2]}`;
  const lastFour = match[5]!;
  const projection = `${firstSix}:${lastFour}`;
  return {
    instrumentKey: `yuanta_instrument_${hmacYuantaIdentity(secret, [
      "yuanta-credit-card-instrument-projection-v2",
      identity.sourceConnectionKey,
      identity.identityEpochKey,
      identity.humanAttestedAccountKey,
      projection,
    ])}`,
    cardMask: `****${lastFour}` as `****${number}${number}${number}${number}`,
  };
}

/**
 * Derive the product-independent Yuanta source key from the normalized login
 * scope, plus the separate portfolio attestation key. The password is
 * intentionally excluded so password rotation does not create a new source
 * connection. The device-owned managed secret is used only for the portfolio
 * attestation; it never participates in Source Connection derivation and is
 * never included in returned identity or workflow output.
 */
export function deriveYuantaCanonicalHumanAttestation(
  credentials: YuantaStableLoginCredentials,
  managedSecret: string,
): YuantaCanonicalHumanAttestation | undefined {
  const secret = managedSecret.trim();
  const sourceConnectionKey = deriveYuantaSourceConnectionKey(credentials);
  if (!secret || !sourceConnectionKey) return undefined;
  const normalizedScope = yuantaSourceConnectionScope(credentials);
  const [userId, account] = normalizedScope.split("\u0000");
  const humanAttestedAccountKey = `portfolio_${hmacYuantaIdentity(secret, [
    "yuanta-credit-card-primary-cardholder-portfolio-v2",
    sourceConnectionKey,
    userId,
    account,
  ])}`;
  return {
    sourceConnectionKey,
    identityEpochKey: YUANTA_CREDIT_CARD_IDENTITY_EPOCH,
    humanAttestedAccountKey,
  };
}

export function isCreditCardProductAbsentText(
  value: string | null | undefined,
): boolean {
  return /未持有信用卡|目前(?:無|沒有)信用卡|無信用卡產品|尚未申請信用卡|查無信用卡|無可用信用卡|未持有卡片/.test(
    collapseSourceWhitespace(value),
  );
}

/**
 * The historical-bills page: ready once a scope's document is the
 * creditcardbillsquery page. Its served HTML is checked for product-absent
 * text and parsed for month links afterwards, as the bills read always did.
 * A login without a card may land on a notice elsewhere instead, which is
 * product absence, as the old bills search found it.
 */
async function isCreditCardBillsPage(scope: BrowserScope): Promise<boolean> {
  let pathname: string;
  try {
    pathname = new URL(scope.url()).pathname;
  } catch {
    return false;
  }
  if (pathname === "/nib/tx/creditcardbillsquery")
    return await hasAttachedLocator(scope.locator("body"));
  const bodyText = await scope.locator("body").textContent({ timeout: 500 }).catch(() => "");
  if (isCreditCardProductAbsentText(bodyText)) {
    throw new StatementComponentAbsentError(
      "No YuanTa credit-card product is available for this login.",
      "not_held",
    );
  }
  return false;
}

const CREDIT_CARD_BILLS_ROUTE: YuantaRoute = {
  path: "creditcardbillsquery",
  description: "YuanTa credit card bills page",
  ready: isCreditCardBillsPage,
};

const YUANTA_EBANK_HOST = new URL(YUANTA_EBANK_ORIGIN).hostname;
const UTF_8: ProviderCharset = { decode: "utf-8" };
/** A query the page's own request chooses, which the workflow does not set. */
const ANY_QUERY = /^(?:\?.*)?$/su;

/** The bills page the route opens; it may land there through a redirect whose query the workflow does not set. */
const YUANTA_CARD_BILLS_RESPONSE: ProviderResponseDeclaration<"optional"> = {
  label: "Yuanta credit-card bills page",
  host: YUANTA_EBANK_HOST,
  endpoints: [{ path: "/nib/tx/creditcardbillsquery", method: "GET", search: ANY_QUERY, charset: UTF_8 }],
  cacheControl: [],
  providerDate: "optional",
};

/** One billed month, posted from the bills form to the action the workflow sets. */
const YUANTA_CARD_MONTH_RESPONSE: ProviderResponseDeclaration<"optional"> = {
  label: "Yuanta credit-card billed month",
  host: YUANTA_EBANK_HOST,
  endpoints: [{
    path: "/nib/tx/creditcardbillsquery",
    method: "POST",
    search: /^\?method=queryHistoryDetail$/u,
    charset: UTF_8,
  }],
  cacheControl: [],
  providerDate: "optional",
};

/** The unbilled grid, posted from the bills form to the action the workflow sets. */
const YUANTA_CARD_UNBILLED_RESPONSE: ProviderResponseDeclaration<"optional"> = {
  label: "Yuanta credit-card unbilled",
  host: YUANTA_EBANK_HOST,
  endpoints: [{ path: "/nib/tx/creditcardunbilled", method: "POST", charset: UTF_8 }],
  cacheControl: [],
  providerDate: "optional",
};

const YUANTA_CURRENT_USED_CREDIT_CONTRACT =
  CREDIT_CARD_CURRENT_BALANCE_ROUTE_CONTRACTS["yuanta/credit-card/current-used-credit-v1"];

/** The summary page's own POST, whose first page also carries current used credit. */
const YUANTA_CARD_SUMMARY_RESPONSE: ProviderResponseDeclaration<"optional"> = {
  label: "Yuanta credit-card summary",
  host: YUANTA_EBANK_HOST,
  endpoints: [{ path: YUANTA_CURRENT_USED_CREDIT_CONTRACT.endpointPath, method: "POST", search: ANY_QUERY, charset: UTF_8 }],
  cacheControl: [],
  providerDate: "optional",
};

type CreditCardBillsPage = Readonly<{
  /** The scope that shows the bills page and holds its month form. */
  scope: BrowserScope;
  /** The bills page as the provider served it. */
  html: string;
}>;

/**
 * Open the bills route and read the document its navigation landed on; a
 * redirect on the way carries no body.
 */
async function openCreditCardBillsPage(
  site: YuantaEbankSite,
  reader: ProviderResponseReader,
): Promise<CreditCardBillsPage> {
  return await site.openDocument(CREDIT_CARD_BILLS_ROUTE, YUANTA_CARD_BILLS_RESPONSE, reader);
}

/**
 * YuanTa renders a copy of the menu in fmenu while the usable controls live
 * in fmain.  Search fmain for the whole bounded wait first, so a hidden fmenu
 * clone cannot win while fmain is still rendering, then search every scope.
 */
async function firstVisibleYuantaScopedLocator(
  frames: FrameScope,
  locatorFor: (scope: BrowserScope) => Locator,
  description: string,
  timeoutMs = 5_000,
): Promise<Locator | null> {
  const fmain = frames.page.frame({ name: "fmain" });
  if (fmain) {
    const candidate = await ifFound(
      frames.firstVisible(locatorFor, description, { in: fmain, timeoutMs }),
    );
    if (candidate) return candidate;
  }
  return await ifFound(
    frames.firstVisible(locatorFor, description, { timeoutMs }),
  );
}

function selectMonthOptions(
  options: MonthOption[],
  input: WorkflowInput,
): MonthOption[] {
  if (!input.monthIndexes) return options;

  const selected = options.filter((option) =>
    input.monthIndexes?.includes(option.index),
  );
  const missing = input.monthIndexes.filter(
    (index) => !options.some((option) => option.index === index),
  );
  if (missing.length > 0) {
    throw new Error(
      `YuanTa did not expose credit card statement month indexes: ${missing.join(
        ", ",
      )}.`,
    );
  }
  return selected;
}

async function waitForYuantaCreditCardSummary(
  frames: FrameScope,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  return await frames.until(async () => {
    for (const scope of frames.scopes()) {
      const bodyText = collapseSourceWhitespace(
        await scope.locator("body").innerText().catch(() => ""),
      );
      if (
        /結帳日|帳單結帳日|本期結帳日/u.test(bodyText) &&
        /繳款截止日|繳款期限|到期日/u.test(bodyText) &&
        /本期應繳(?:總額|總金額)|應繳(?:總額|金額)/u.test(bodyText) &&
        /本期最低應繳(?:額|金額)|最低應繳/u.test(bodyText)
      )
        return scope;
    }
    return null;
  }, "Timed out waiting for YuanTa credit-card summary.", { timeoutMs });
}

const yuantaSummaryResultText =
  /結帳日|帳單結帳日|本期結帳日|繳款截止日|繳款期限|本期應繳/u;
const yuantaCurrentCreditResultText =
  /信用額度|已使用額度|信用額度餘額/u;

async function findYuantaSummaryPagerControl(
  frames: FrameScope,
  scope: BrowserScope,
): Promise<Locator | null> {
  const summaryTable = scope.locator("table").filter({
    hasText: yuantaSummaryResultText,
  }).first();
  if ((await summaryTable.count().catch(() => 0)) === 0) return null;

  const nearestContainer = summaryTable.locator(
    "xpath=ancestor::*[self::div or self::section or self::form][1]",
  );
  for (const container of [summaryTable, nearestContainer]) {
    const controls = container.locator("a,button,input");
    const count = await controls.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const control = controls.nth(index);
      const controlHtml = await frames.race(
        control.evaluate((element) => element.outerHTML).catch(() => ""),
      );
      if (controlHtml && isActiveYuantaSummaryPagerControl(controlHtml))
        return control;
    }
  }
  return null;
}

async function readYuantaSummaryHtml(
  frames: FrameScope,
  previousHtml?: string,
): Promise<string> {
  return await frames.until(async () => {
    const preferredFrame = frames.page.frame({ name: "fmain" });
    const scopes = preferredFrame
      ? [preferredFrame, ...frames.scopes().filter((scope) => scope !== preferredFrame)]
      : frames.scopes();
    for (const scope of scopes) {
      const bodyText = collapseSourceWhitespace(
        await scope.locator("body").innerText().catch(() => ""),
      );
      if (
        !yuantaSummaryResultText.test(bodyText) &&
        !yuantaCurrentCreditResultText.test(bodyText)
      )
        continue;
      const html = await scope.locator("body").innerHTML().catch(() => "");
      if (html && (previousHtml === undefined || html !== previousHtml))
        return html;
    }
    return null;
  }, "Timed out waiting for the next YuanTa credit-card summary page.", {
    timeoutMs: 60_000,
  });
}

async function findYuantaVisibleTextControl(
  frames: FrameScope,
  pattern: RegExp,
  description: string,
  timeoutMs = 5_000,
): Promise<Locator | null> {
  let link = await firstVisibleYuantaScopedLocator(
    frames,
    (candidate) => candidate.getByRole("link", { name: pattern }),
    description,
    timeoutMs,
  );
  if (link) return link;

  link = await firstVisibleYuantaScopedLocator(
    frames,
    (candidate) => candidate.getByText(pattern),
    `${description} text control`,
    timeoutMs,
  );
  return link;
}

export async function findYuantaCreditCardSummaryLink(
  site: YuantaEbankSite,
  timeoutMs = 5_000,
): Promise<Locator | null> {
  return await firstVisibleYuantaScopedLocator(
    site.frames,
    (candidate) =>
      candidate.getByRole("link", { name: "信用卡總覽", exact: true }),
    "YuanTa credit card summary link",
    timeoutMs,
  );
}

/** Open the provider's reviewed feature-overview route before selecting the
 * visible credit-card summary link.  The combined workflow often leaves the
 * frame on the historical-bills page, where the direct menu action can take a
 * long time to settle without loading the current-limit table. */
async function openYuantaFeatureOverview(site: YuantaEbankSite): Promise<boolean> {
  const { frames } = site;
  const featureOverviewPattern = /功\s*能\s*總\s*覽/u;
  let link = await findYuantaVisibleTextControl(
    frames,
    featureOverviewPattern,
    "YuanTa feature overview link",
  );
  if (!link) {
    // The combined workflow may leave fmain on creditcardbillsquery.  Return
    // to the reviewed signed-in home page through its visible 首頁 control,
    // then select 功 能 總 覽 from that page.
    const homeLink = await findYuantaVisibleTextControl(
      frames,
      /^首頁$/u,
      "YuanTa home link",
    );
    if (homeLink) {
      await frames.withSignal((signal) => homeLink.click({ force: true, signal }));
      await frames.settle();
      link = await findYuantaVisibleTextControl(
        frames,
        featureOverviewPattern,
        "YuanTa feature overview link",
        15_000,
      );
    }
  }
  if (!link) return false;

  await frames.withSignal((signal) => link.click({ force: true, signal }));
  await frames.settle();
  const shown = await ifFound(frames.until(async () => {
    const fmain = frames.page.frame({ name: "fmain" });
    for (const scope of fmain ? [fmain, ...frames.scopes()] : frames.scopes()) {
      const pathname = (() => {
        try {
          return new URL(scope.url()).pathname;
        } catch {
          return "";
        }
      })();
      const hasSummaryLink =
        (await scope
          .getByRole("link", { name: "信用卡總覽", exact: true })
          .count()
          .catch(() => 0)) > 0;
      if (pathname === "/nib/pages/vnib/feature-overview" || hasSummaryLink)
        return true;
    }
    return null;
  }, "Timed out waiting for the YuanTa feature overview.", { timeoutMs: 15_000 }));
  return shown ?? false;
}

/**
 * The summary page markup that carries current used credit, and the POST
 * response it came with; or the refusal of a summary reply whose transport
 * failed its check, which the reader never read a body for. The refusal is
 * not the card's failure until the read has fallen back to the rendered
 * summary: the card then fails it inside validation (ADR 0108).
 */
type YuantaCurrentCreditEvidence =
  | Readonly<{ html: string; response: ProviderResponse }>
  | Readonly<{ refused: ProviderResponseCheckError }>;

/** What the summary's POST reply gave the read: nothing, a refused transport, or a body. */
type YuantaSummaryReply =
  | null
  | Readonly<{ refused: ProviderResponseCheckError }>
  | ProviderBodyAcquisition<"text">;

/**
 * The summary reply's HTML, or "" when it fails its provider response check.
 * The read then falls back to the rendered summary, as it did before the
 * check, and the current-credit snapshot rejects the reply inside validation.
 */
async function summaryReplyHtml(reader: ProviderResponseReader, reply: ProviderBodyAcquisition<"text">): Promise<string> {
  try {
    return (await reader.accept(YUANTA_CARD_SUMMARY_RESPONSE, reply)).evidence.text;
  } catch (error) {
    if (error instanceof ProviderResponseCheckError) return "";
    throw error;
  }
}

/**
 * Open the credit-card summary and read the reply its POST got.
 * `reader` is one without product validation: a refused summary reply is not
 * yet the card's failure.
 */
export async function loadYuantaCreditCardSummaryPage(
  site: YuantaEbankSite,
  reader: ProviderResponseReader,
  link?: Locator,
): Promise<{
  firstHtml: string;
  /** Absent when the summary's POST response was never observed. */
  currentCredit?: YuantaCurrentCreditEvidence;
}> {
  const { frames } = site;
  const navigate = async () => {
    if (link) await frames.withSignal((signal) => link.click({ signal }));
    else
      await site.menuAction("creditcardsummary", "menu_creditcardsummary", 60_000);
    await frames.settle();
  };
  // The navigation's own failure is judged once the reply's fate is known, so it never fails the read.
  let navigated: Promise<PromiseSettledResult<void>> = Promise.resolve({ status: "fulfilled", value: undefined });
  let reply: YuantaSummaryReply;
  try {
    reply = await reader.acquire(frames, YUANTA_CARD_SUMMARY_RESPONSE, {
      evidence: "text",
      timeoutMs: 30_000,
      // A redirect hop is skipped: the reply read is the one that ends the summary POST's chain.
      waitFor: endsRequestChainFrom(YUANTA_CURRENT_USED_CREDIT_CONTRACT.endpointPath, "POST"),
      trigger: async () => {
        navigated = navigate().then(
          (value) => ({ status: "fulfilled", value }),
          (reason: unknown) => ({ status: "rejected", reason }),
        );
        await navigated;
      },
    });
  } catch (error) {
    await navigated;
    if (frames.signal.aborted) throw error;
    if (error instanceof errors.TimeoutError) reply = null;
    else if (error instanceof ProviderResponseCheckError) reply = { refused: error };
    // The reply arrived, so its body could not be read.
    else throw new YuantaCurrentCreditReadError(error);
  }
  const settled = await navigated;
  // Without an observed response there is no current used credit to lose.
  const unreadable = (error: unknown): unknown =>
    !reply || error instanceof SourceTextIntegrityError || frames.signal.aborted
      ? error
      : new YuantaCurrentCreditReadError(error);
  if (settled.status === "rejected") throw unreadable(settled.reason);
  const evidence = (html: string): YuantaCurrentCreditEvidence | undefined =>
    !reply ? undefined : "refused" in reply ? reply : { html, response: reply.response };
  try {
    const responseHtml = reply && "evidence" in reply ? await summaryReplyHtml(reader, reply) : "";
    if (hasYuantaCurrentCreditTable(responseHtml)) {
      return { firstHtml: responseHtml, currentCredit: evidence(responseHtml) };
    }

    let firstHtml: string;
    try {
      firstHtml = await readYuantaSummaryHtml(frames);
    } catch (error) {
      if (!(error instanceof FrameScopeTimeoutError)) throw error;
      throw new YuantaCreditSummaryNavigationError();
    }
    return { firstHtml, currentCredit: evidence(firstHtml) };
  } catch (error) {
    throw unreadable(error);
  }
}

/** The settled-summary traversal, with the current-credit evidence its first page carried. */
type YuantaSummaryRead = YuantaCreditCardSummaryTraversal & Readonly<{ currentCredit?: YuantaCurrentCreditEvidence }>;

async function traverseYuantaSummaryWithCurrentEvidence(
  site: YuantaEbankSite,
  firstHtml: string,
  currentCredit: YuantaCurrentCreditEvidence | undefined,
  sourceText: SourceTextPort,
): Promise<YuantaSummaryRead> {
  const { frames } = site;
  sourceText.assertIntact(firstHtml);
  frames.signal.throwIfAborted();
  let currentHtml = firstHtml;
  const current = currentCredit ? { currentCredit } : {};
  try {
    const traversal = await traverseYuantaCreditCardSettledStatementSummaryPages(
      firstHtml,
      async (_request) => {
        const scope = await waitForYuantaCreditCardSummary(frames);
        const pager = await findYuantaSummaryPagerControl(frames, scope);
        if (!pager)
          throw new Error(
            "YuanTa settled statement pagination control disappeared before traversal.",
          );
        await frames.withSignal((signal) => pager.click({ force: true, signal }));
        await frames.settle();
        frames.signal.throwIfAborted();
        const nextHtml = await readYuantaSummaryHtml(frames, currentHtml);
        sourceText.assertIntact(nextHtml);
        currentHtml = nextHtml;
        return nextHtml;
      },
    );
    return { ...traversal, ...current };
  } catch (error) {
    if (error instanceof SourceTextIntegrityError || frames.signal.aborted) throw error;
    // The settled-summary pages are an optional cross-check. A failure while
    // paging them, such as a parse change or a vanished pager, keeps the
    // current-used-credit evidence the first page already carried.
    return { summaries: [], pages: [], ...current };
  }
}

async function submitCreditCardSummary(
  site: YuantaEbankSite,
  context: Pick<WorkflowContext, "now" | "text">,
): Promise<YuantaSummaryRead> {
  let link = await findYuantaCreditCardSummaryLink(site);
  if (!link) {
    const openedFeatureOverview = await openYuantaFeatureOverview(site);
    if (openedFeatureOverview) {
      link = await findYuantaCreditCardSummaryLink(site, 15_000);
      if (!link) throw new YuantaCreditSummaryNavigationError();
    }
  }

  let loaded: Awaited<ReturnType<typeof loadYuantaCreditCardSummaryPage>>;
  try {
    // Not the card's reader: a refused summary reply fails the card only when
    // the current-credit snapshot rejects it, so a summary page that then
    // cannot be read stays a read failure, not a validation failure.
    loaded = await loadYuantaCreditCardSummaryPage(site, sourceReader(context), link ?? undefined);
  } catch (error) {
    if (
      error instanceof YuantaCreditSummaryNavigationError ||
      error instanceof YuantaCurrentCreditReadError ||
      error instanceof SourceTextIntegrityError ||
      site.frames.signal.aborted
    )
      throw error;
    throw new YuantaCreditSummaryNavigationError();
  }
  return await traverseYuantaSummaryWithCurrentEvidence(
    site,
    loaded.firstHtml,
    loaded.currentCredit,
    context.text,
  );
}

function issuerExactAmount(value: string): CreditCardExactAmount {
  const normalized = value.replaceAll(",", "");
  const [integer, fraction = ""] = normalized.split(".");
  const sign = integer.startsWith("-") ? "-" : "";
  const unsigned = integer.replace(/^-?/u, "").replace(/^0+(?=\d)/u, "") || "0";
  const coefficient = `${sign}${unsigned}${fraction}`;
  return {
    coefficient: coefficient === "-0" ? "0" : coefficient,
    scale: fraction.length,
  };
}

function yuantaCreditCurrentSnapshotDate(httpDate: string): string {
  const milliseconds = Date.parse(httpDate);
  if (!Number.isFinite(milliseconds)) throw new Error("Yuanta credit current snapshot HTTP Date is invalid.");
  return taipeiDate(milliseconds);
}

function yuantaCreditCurrentSnapshotCapture(
  capture: YuantaCreditCardValidatedCapture,
  snapshot: YuantaCurrentUsedCreditSnapshot,
): CreditCardCurrentBalanceCaptureInput {
  const effectiveAt = new Date(Date.parse(snapshot.httpDate)).toISOString();
  const used = issuerExactAmount(snapshot.usedCredit);
  const sourceRecordKey = `sha256:${createHash("sha256")
    .update(JSON.stringify(["yuanta-credit-current-used-credit-v1", capture.identity.accountNaturalKey, snapshot.httpDate]))
    .digest("base64url")}`;
  const providerKey = `sha256:${createHash("sha256")
    .update(JSON.stringify(["yuanta-credit-current-used-credit-provider-v1", snapshot.endpoint]))
    .digest("base64url")}`;
  const time = {
    effectiveAt,
    effectiveTimeBasis: "provider-http-date" as const,
    effectiveTimeRuleVersion: YUANTA_CURRENT_USED_CREDIT_CONTRACT.contractVersion,
    sourceField: "HTTP Date" as const,
    sourceValue: snapshot.httpDate,
    contractVersion: YUANTA_CURRENT_USED_CREDIT_CONTRACT.contractVersion,
  };
  const estimate = {
    kind: "estimate" as const,
    basis: "provider-used-credit" as const,
    formula: "provider-reported-used-credit",
  };
  return assembleCurrentCreditCardCapture({
    captureId: `${capture.captureId}:current-used-credit`,
    authorityRoute: "yuanta/credit-card/current-used-credit-v1",
    contractVersion: YUANTA_CURRENT_USED_CREDIT_CONTRACT.contractVersion,
    subjectDigest: capture.identity.accountNaturalKey,
    identity: canonicalCreditCardCurrentBalanceIdentity({
      integrationNamespace: "yuanta",
      sourceConnectionKey: capture.identity.sourceConnectionKey,
      identityEpochKey: capture.identity.identityEpochKey,
      sourceAccountKey: capture.identity.accountNaturalKey,
    }),
    observedAt: capture.observedAt,
    scope: {
      startDate: yuantaCreditCurrentSnapshotDate(snapshot.httpDate),
      endDate: yuantaCreditCurrentSnapshotDate(snapshot.httpDate),
    },
    providerResponse: {
      endpoint: snapshot.endpoint,
      status: 200,
      cacheControl: snapshot.cacheControl,
    },
    page: {
      metadata: { sourceField: snapshot.sourceField, table: "rwdTable:first-credit-limit" },
    },
  }, [{
    sourceRecordKey,
    providerKey,
    observationKey: "issuer-aggregate",
    sourceField: snapshot.sourceField,
    currency: "TWD",
    value: used,
    time,
    estimate,
    compact: {
      provider: "yuanta",
      limit: snapshot.limit,
      usedCredit: snapshot.usedCredit,
      available: snapshot.available,
    },
  }]);
}

const yuantaCurrentUsedCreditSnapshot: CurrentStateSnapshotDeclaration<
  Readonly<{ evidence: Readonly<{ kind: "html"; html: string }>; response: ProviderResponse }>,
  YuantaCurrentUsedCreditSnapshot,
  CurrentUsedCreditCapture<YuantaCreditCardValidatedCapture>,
  "required",
  CreditCardCurrentBalanceCaptureInput
> = {
  product: "current-balance",
  kind: CURRENT_CREDIT_CARD_BALANCE_STAGING,
  matching: issuerAggregateMatching("Yuanta current used credit"),
  build: (row, { capture }) => yuantaCreditCurrentSnapshotCapture(capture, row),
  response: {
    label: "Yuanta current used credit",
    host: YUANTA_CURRENT_USED_CREDIT_CONTRACT.endpointHost,
    endpoints: [{ path: YUANTA_CURRENT_USED_CREDIT_CONTRACT.endpointPath, method: "POST" }],
    cacheControl: YUANTA_CURRENT_USED_CREDIT_CONTRACT.requiredCacheTokens,
    providerDate: "required",
  },
  parse: (decoded, response) => {
    const table = parseYuantaCurrentCreditCardUsedCreditSummaryHtml(decoded.html);
    if (!table) throw new Error("Yuanta credit-card summary has no current used-credit table.");
    return [{
      ...table,
      endpoint: response.url.href,
      httpDate: response.providerDate.raw,
      cacheControl: response.cacheControl,
    }];
  },
};

export async function submitCreditCardMonthOptions(
  monthOptions: MonthOption[],
  submit: (month: MonthOption, position: number) => Promise<string>,
  onResponse: (
    month: MonthOption,
    html: string,
    position: number,
  ) => Promise<void> | void,
): Promise<void> {
  for (let position = 0; position < monthOptions.length; position += 1) {
    const month = monthOptions[position];
    const html = await submit(month, position);
    if (hasUntraversedPager(html)) {
      throw new Error(
        "YuanTa credit-card response has untraversed pagination.",
      );
    }
    await onResponse(month, html, position);
  }
}

function cardKeyForRow(row: StatementRow): string {
  return row.creditCardNo.replace(/\D/g, "").slice(-4);
}

function safeCanonicalCardName(value: string): string {
  return collapseSourceWhitespace(value)
    .replace(/(?<!\d)(?:\d[\s-]*){12,19}(?!\d)/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Convert parser rows to the canonical builder's redacted source-row shape.
 * The workflow HMACs the observed first-six + last-four projection, then only
 * an opaque instrument key and `****last4` cross the canonical boundary.
 */
export function toYuantaCanonicalCreditCardSourceRow(
  row: YuantaCreditCardStatementRow,
  identity: YuantaCreditCardIdentityInput,
  managedSecret: string,
  kind: StatementKind = row.period ? "billed" : "unbilled",
): YuantaCreditCardSourceRow | undefined {
  const instrument = deriveYuantaProjectedInstrumentIdentity(
    row.creditCardNo,
    identity,
    managedSecret,
  );
  if (!instrument) return undefined;
  return {
    creditCardNo: instrument.cardMask,
    creditCardName: safeCanonicalCardName(row.creditCardName),
    consumeDate: collapseSourceWhitespace(row.consumeDate),
    postedDate: collapseSourceWhitespace(row.postedDate),
    description: collapseSourceWhitespace(row.description),
    countryCurrency: collapseSourceWhitespace(row.countryCurrency),
    foreignExchangeDate: collapseSourceWhitespace(row.foreignExchangeDate),
    foreignAmount: collapseSourceWhitespace(row.foreignAmount),
    twdAmount: collapseSourceWhitespace(row.twdAmount),
    paymentStatus: collapseSourceWhitespace(row.paymentStatus),
    period: kind === "billed" ? row.period : null,
    instrumentKey: instrument.instrumentKey,
  };
}

function sameMonthOptionSet(
  left: readonly MonthOption[],
  right: readonly MonthOption[],
): boolean {
  if (left.length !== right.length) return false;
  const rightByIndex = new Map(right.map((option) => [option.index, option.label]));
  if (rightByIndex.size !== right.length) return false;
  return left.every(
    (option) => rightByIndex.get(option.index) === option.label,
  );
}

/**
 * Return terminal no-pager evidence for the six billed responses and the
 * optional unbilled response.  This helper is intentionally pure so a caller
 * can retain only booleans instead of response bodies.
 */
export function yuantaCreditCardTerminalPagesFromHtml(
  billedResponses: readonly string[],
  unbilledResponse?: string,
): boolean[] {
  return [
    ...billedResponses.map((html) => !hasUntraversedPager(html)),
    ...(unbilledResponse === undefined
      ? []
      : [!hasUntraversedPager(unbilledResponse)]),
  ];
}

/**
 * Map a complete browser capture to the canonical module's builder options.
 * Partial month selections, omitted unbilled data, and any pager evidence are
 * deliberately represented as `undefined` so callers cannot accidentally
 * admit a partial snapshot as a canonical portfolio capture.
 */
export function yuantaCreditCardCaptureBuilderOptions(
  options: YuantaCreditCardCanonicalCaptureInput,
): YuantaCreditCardCaptureBuilderOptions | undefined {
  const { capture } = options;
  const completenessEvidence = capture.completenessEvidence;
  const evidenceMonthIndexes = completenessEvidence.monthIndexes;
  const evidenceMatchesMonths =
    evidenceMonthIndexes === undefined ||
    (Array.isArray(evidenceMonthIndexes) &&
      evidenceMonthIndexes.length === options.allMonthOptions.length &&
      options.allMonthOptions.every(
        (option) => evidenceMonthIndexes.includes(option.index),
      ));
  const evidenceIncludesUnbilled =
    completenessEvidence.unbilled === undefined ||
    completenessEvidence.unbilled === true;
  const evidenceHasNoPager =
    completenessEvidence.pagination === undefined ||
    completenessEvidence.pagination === "none";
  const billedPeriods = options.allMonthOptions.map((option) => option.label);
  const completeScope =
    capture.snapshotMode === "full" &&
    options.includeUnbilled &&
    options.includeSummary &&
    options.statementSummaries !== undefined &&
    options.statementSummaries.length >= options.allMonthOptions.length - 1 &&
    options.statementSummaries.length <= options.allMonthOptions.length &&
    sameMonthOptionSet(options.allMonthOptions, options.selectedMonthOptions) &&
    evidenceMatchesMonths &&
    evidenceIncludesUnbilled &&
    evidenceHasNoPager &&
    statementGridQueryShortfalls(YUANTA_STATEMENT_GRID, {
      billedPeriods,
      terminalGrids: options.terminalPages,
    }).length === 0;
  if (!completeScope) return undefined;

  const billedRows = options.billedRows.map((row) =>
    toYuantaCanonicalCreditCardSourceRow(
      row,
      options.identity,
      options.instrumentFingerprintSecret,
      "billed",
    ),
  );
  const unbilledRows = options.unbilledRows.map((row) =>
    toYuantaCanonicalCreditCardSourceRow(
      row,
      options.identity,
      options.instrumentFingerprintSecret,
      "unbilled",
    ),
  );
  if (
    billedRows.some((row) => row === undefined) ||
    unbilledRows.some((row) => row === undefined)
  )
    return undefined;

  return {
    captureId: capture.captureId,
    observedAt: capture.capturedAt,
    identity: options.identity,
    billedRows: billedRows as YuantaCreditCardSourceRow[],
    unbilledRows: unbilledRows as YuantaCreditCardSourceRow[],
    billedPeriods,
    terminalPages: [...options.terminalPages],
    statementSummaries: [...options.statementSummaries!],
  };
}

/** Build one admitted Yuanta capture when the supplied browser evidence is complete. */
export function buildYuantaCanonicalCreditCardCaptureFromWorkflow(
  options: YuantaCreditCardCanonicalCaptureInput,
): YuantaCreditCardValidatedCapture | undefined {
  const builderOptions = yuantaCreditCardCaptureBuilderOptions(options);
  return builderOptions
    ? buildCanonicalYuantaCreditCardCapture(builderOptions)
    : undefined;
}

/**
 * Plural form mirrors the other credit-card workflow seam and keeps the
 * caller's commit path batch-friendly.  No capture is returned for partial
 * or pager-bearing browser evidence.
 */
export function buildYuantaCanonicalCreditCardCaptures(
  options: YuantaCreditCardCanonicalCaptureInput,
): YuantaCreditCardValidatedCapture[] {
  const capture = buildYuantaCanonicalCreditCardCaptureFromWorkflow(options);
  return capture ? [capture] : [];
}

async function waitForCreditCardForm(
  frames: FrameScope,
  bills: BrowserScope,
): Promise<void> {
  await frames.withSignal((signal) =>
    bills.waitForSelector(
      'form#mform [name="cdHistoryQuery"], form[name="mform"] [name="cdHistoryQuery"]',
      { state: "attached", timeout: 120_000, signal },
    ),
  );
}

async function submitCreditCardMonth(
  site: YuantaEbankSite,
  bills: BrowserScope,
  month: MonthOption,
  reader: ProviderResponseReader,
): Promise<string> {
  const { frames } = site;
  await waitForCreditCardForm(frames, bills);
  const { evidence } = await reader.capture(frames, YUANTA_CARD_MONTH_RESPONSE, {
    evidence: "text",
    timeoutMs: 120_000,
    trigger: () =>
      bills.evaluate((monthIndex) => {
        const form = document.forms.namedItem("mform");
        if (!form) throw new Error("YuanTa credit card form was not found.");
        const field = form.elements.namedItem(
          "cdHistoryQuery",
        ) as HTMLInputElement | null;
        if (!field)
          throw new Error("YuanTa credit card form missed cdHistoryQuery.");
        field.value = String(monthIndex);
        form.action = "../tx/creditcardbillsquery?method=queryHistoryDetail";
        form.submit();
      }, month.index),
  });
  return evidence.text;
}

async function submitCreditCardUnbilled(
  site: YuantaEbankSite,
  bills: BrowserScope,
  reader: ProviderResponseReader,
): Promise<string> {
  const { frames } = site;
  await waitForCreditCardForm(frames, bills);
  const { evidence } = await reader.capture(frames, YUANTA_CARD_UNBILLED_RESPONSE, {
    evidence: "text",
    timeoutMs: 120_000,
    trigger: () =>
      bills.evaluate(() => {
        const form = document.forms.namedItem("mform");
        if (!form) throw new Error("YuanTa credit card form was not found.");
        const set = (name: string, value: string) => {
          const field = form.elements.namedItem(name) as HTMLInputElement | null;
          if (field) field.value = value;
        };
        set("menutype", "creditcardunbilled");
        set("iconid", "menu_creditcardunbilled");
        set("cdHistoryQuery", "");
        form.action = "../tx/creditcardunbilled";
        form.submit();
      }),
  });
  return evidence.text;
}

export async function runYuantaCreditCardStatements(
  page: Page,
  input: YuantaCreditCardCollectionInput,
  context: WorkflowContext,
  product: ProductCollectionHandle,
): Promise<ProductCollectionSummary> {
  context.signal.throwIfAborted();
  const site = yuantaEbankSite(page, context);
  const snapshot = await readYuantaCreditCardSource(site, input, context, product);
  return await stageYuantaCreditCard(snapshot, input, context, product);
}

/** What one credit-card run read from the eBank pages, before anything is built (ADR 0065). */
export type YuantaCreditCardSourceSnapshot = Readonly<{
  /** Every billed month the bills page offered. */
  allMonthOptions: readonly MonthOption[];
  /** The billed months the run queried, in query order. */
  selectedMonthOptions: readonly MonthOption[];
  billedRows: readonly StatementRow[];
  /** One settled-summary page per selected month; empty when the summary was not requested. */
  billedHistoryPages: readonly YuantaCreditCardHistorySettledSummaryPage[];
  /** One entry per billed response, then one for the unbilled response when it was read. */
  terminalPages: readonly boolean[];
  /** Empty when unbilled rows were not requested. */
  unbilledRows: readonly StatementRow[];
  /** Current used credit, read only when the summary's POST response was observed. */
  currentUsedCredit?: readonly YuantaCurrentUsedCreditSnapshot[];
}>;

/**
 * Read the bills page, each selected billed month, the unbilled page and the
 * optional current used-credit summary. This is the only half that touches
 * the page.
 */
export async function readYuantaCreditCardSource(
  site: YuantaEbankSite,
  input: YuantaCreditCardCollectionInput,
  context: WorkflowContext,
  product: ProductCollectionHandle,
): Promise<YuantaCreditCardSourceSnapshot> {
  context.signal.throwIfAborted();
  await product.reportActivity("query");
  const { reader } = product;
  const bills = await openCreditCardBillsPage(site, reader);
  const currentMonthHtml = bills.html;
  context.text.assertIntact(currentMonthHtml);
  context.signal.throwIfAborted();
  if (isCreditCardProductAbsentText(currentMonthHtml)) {
    throw new StatementComponentAbsentError(
      "No YuanTa credit-card product is available for this login.",
      "not_held",
    );
  }
  if (hasUntraversedPager(currentMonthHtml)) {
    throw new Error(
      "YuanTa credit-card response has untraversed pagination.",
    );
  }
  const allMonthOptions = parseCreditCardBillsHtml(
    currentMonthHtml,
    null,
  ).monthOptions;
  const selectedMonthOptions = selectMonthOptions(allMonthOptions, input);
  const billedRows: StatementRow[] = [];
  const billedHistoryPages: YuantaCreditCardHistorySettledSummaryPage[] = [];
  const terminalPages: boolean[] = [];

  await submitCreditCardMonthOptions(
    selectedMonthOptions,
    async (month) => {
      context.signal.throwIfAborted();
      await product.reportActivity("query");
      return submitCreditCardMonth(site, bills.scope, month, reader);
    },
    async (month, monthHtml, monthPosition) => {
      context.signal.throwIfAborted();
      context.text.assertIntact(monthHtml);
      terminalPages.push(true);
      if (input.includeSummary) {
        billedHistoryPages.push(
          parseYuantaCreditCardSettledStatementHistoryPage(
            monthHtml,
            month,
            monthPosition,
          ),
        );
      }
      billedRows.push(...parseCreditCardBillsHtml(monthHtml, month.label).rows);
    },
  );

  let unbilledRows: StatementRow[] = [];
  if (input.includeUnbilled) {
    await product.reportActivity("query");
    const unbilledHtml = await submitCreditCardUnbilled(site, bills.scope, reader);
    context.text.assertIntact(unbilledHtml);
    context.signal.throwIfAborted();
    if (hasUntraversedPager(unbilledHtml)) {
      throw new Error(
        "YuanTa credit-card response has untraversed pagination.",
      );
    }
    terminalPages.push(true);
    unbilledRows = parseCreditCardBillsHtml(unbilledHtml, null, false).rows;
  }

  let currentCredit: YuantaCurrentCreditEvidence | undefined;
  if (input.includeSummary) {
    try {
      await product.reportActivity("query");
      const { currentCredit: evidence, ...summaryTraversal } = await submitCreditCardSummary(site, context);
      context.text.assertIntact(JSON.stringify(summaryTraversal));
      currentCredit = evidence;
    } catch (error) {
      // A summary page that never responds leaves current used credit unread;
      // a response that cannot be read, text corruption and cancellation stop
      // the read here.
      if (
        error instanceof YuantaCurrentCreditReadError ||
        error instanceof SourceTextIntegrityError ||
        context.signal.aborted
      ) {
        throw error;
      }
    }
  }
  // Once the summary's POST response is observed, any failure to read its
  // current used credit fails the card capture.
  if (currentCredit && "refused" in currentCredit) {
    const { refused } = currentCredit;
    await product.validate(() => {
      throw refused;
    });
  }
  const currentUsedCredit = currentCredit && "html" in currentCredit
    ? await readCurrentStateSnapshot(yuantaCurrentUsedCreditSnapshot, {
        acquire: async () => ({
          evidence: { kind: "html", html: currentCredit.html },
          response: currentCredit.response,
        }),
        product,
      })
    : undefined;

  return {
    allMonthOptions,
    selectedMonthOptions,
    billedRows,
    billedHistoryPages,
    terminalPages,
    unbilledRows,
    ...(currentUsedCredit ? { currentUsedCredit } : {}),
  };
}

/**
 * Build the issuer summaries, decide between a full and a partial capture
 * (ADR 0062), and stage the credit-card capture and its current balance when
 * the read covered the whole Query Inventory.
 */
export async function stageYuantaCreditCard(
  snapshot: YuantaCreditCardSourceSnapshot,
  input: YuantaCreditCardCollectionInput,
  context: WorkflowContext,
  product: ProductCollectionHandle,
): Promise<ProductCollectionSummary> {
  const { instrumentFingerprintSecret, canonicalHumanAttestation } = input;
  const {
    allMonthOptions,
    selectedMonthOptions,
    billedRows,
    billedHistoryPages,
    terminalPages,
    unbilledRows,
    currentUsedCredit,
  } = snapshot;

  let issuerSummaries: YuantaCreditCardIssuerSummary[] = [];
  let statementSummaries: YuantaCreditCardStatementSummary[] = [];
  if (input.includeSummary) {
    issuerSummaries = collectYuantaCreditCardHistorySummaries(
      billedHistoryPages,
      selectedMonthOptions,
    );
    if (issuerSummaries.length >= 2)
      statementSummaries = resolveYuantaSettledStatementCycles(issuerSummaries);
  }

  const isFullCapture =
    !input.monthIndexes &&
    input.includeUnbilled &&
    selectedMonthOptions.length === allMonthOptions.length &&
    statementGridQueryShortfalls(YUANTA_STATEMENT_GRID, {
      billedPeriods: allMonthOptions.map((month) => month.label),
      terminalGrids: terminalPages,
    }).length === 0 &&
    [...billedRows, ...unbilledRows].every(
      (row) => cardKeyForRow(row).length === 4,
    );
  const capture: CaptureMetadata = isFullCapture
    ? {
        snapshotMode: "full",
        captureId: randomUUID(),
        capturedAt: context.now(),
        captureKinds: ["billed", "unbilled"],
        completenessEvidence: {
          bank: "yuanta",
          monthIndexes: allMonthOptions.map((month) => month.index),
          unbilled: true,
          pagination: "none",
          summary: {
            requested: input.includeSummary,
            issuerSummaryCount: issuerSummaries.length,
            settledCycleCount: statementSummaries.length,
            periods: issuerSummaries.map((summary) => summary.period),
          },
        },
      }
    : {
        snapshotMode: "partial",
        completenessEvidence: {
          bank: "yuanta",
          reason: "scope_not_full",
          monthIndexes: selectedMonthOptions.map((month) => month.index),
          unbilled: input.includeUnbilled,
          summary: {
            requested: input.includeSummary,
            issuerSummaryCount: issuerSummaries.length,
            settledCycleCount: statementSummaries.length,
            periods: issuerSummaries.map((summary) => summary.period),
          },
        },
      };

  if (isFullCapture) {
    const cards = await admitCreditCards(product, () =>
      buildYuantaCanonicalCreditCardCaptures({
        capture,
        identity: canonicalHumanAttestation,
        instrumentFingerprintSecret,
        allMonthOptions,
        selectedMonthOptions,
        includeUnbilled: input.includeUnbilled,
        includeSummary: input.includeSummary,
        terminalPages,
        billedRows,
        unbilledRows,
        statementSummaries,
      }).map((canonical) => ({
        capture: canonical,
        request: creditCardCommandRequestFromCanonicalCapture(
          yuantaCanonicalSpineCapture(canonical),
          yuantaNeutralCreditCardCapture(canonical),
        ),
      })));
    await stageCanonicalCreditCards(
      product,
      cards,
      currentUsedCredit && { snapshot: yuantaCurrentUsedCreditSnapshot, rows: currentUsedCredit },
    );
  }

  context.signal.throwIfAborted();
  return {
    sourceCaptureCount:
      selectedMonthOptions.length +
      (input.includeUnbilled ? 1 : 0) +
      (input.includeSummary ? 1 : 0),
    rowCount: billedRows.length + unbilledRows.length,
  };
}
