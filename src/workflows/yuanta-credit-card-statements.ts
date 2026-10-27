import { createHash, createHmac, randomUUID } from "node:crypto";
import { errors, type Locator, type Page, type Response } from "playwright";
import { z } from "zod";
import {
  creditCardBalanceCommandRequest,
  creditCardCommandRequestFromCanonicalCapture,
} from "../ledger/pglite/credit-card-adapters.ts";
import {
  PGLITE_CANONICAL_CREDIT_CARD_BALANCE_COMMAND,
  PGLITE_CANONICAL_CREDIT_CARD_COMMIT_COMMAND,
} from "../ledger/pglite/workflow-client.ts";
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
  admitCreditCardCurrentBalanceCapture,
  canonicalCreditCardCurrentBalanceIdentity,
  creditCardCurrentBalanceSourceRecord,
  type CreditCardExactAmount,
  type CreditCardCurrentBalanceObservationInput,
} from "../ledger/canonical/credit-card-current-balance-admission.ts";
import { CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY } from "../lib/automation/server/config-files.ts";
import { hasAttachedLocator } from "./browser-interaction.js";
import {
  StatementComponentAbsentError,
  type ProductCollectionHandle,
  type ProductCollectionSummary,
  type ProductStageRequest,
} from "../lib/automation/product-collection.ts";
import type { WorkflowContext } from "../lib/automation/workflow-executor.ts";
import {
  deriveYuantaSourceConnectionKey,
  yuantaSourceConnectionScope,
  type YuantaCredentials,
} from "./yuanta-auth.ts";
import {
  FrameScopeTimeoutError,
  ifFound,
  type BrowserScope,
  type FrameScope,
} from "./frame-scope.ts";
import {
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
  YuantaCreditCardSummaryParseError,
  type YuantaCreditCardHistorySettledSummaryPage,
  type YuantaCreditCardIssuerSummary,
  type YuantaCreditCardMonthOption,
  type YuantaCreditCardStatementRow,
  type YuantaCreditCardSummaryTraversal,
  type YuantaCurrentUsedCreditSnapshot,
} from "./yuanta-credit-card-parser.ts";

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
  const normalized = cleanText(cardLabel)
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
  credentials: YuantaCredentials,
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

/** Resolve the generic application-managed identity secret without exposing it. */
export function yuantaCanonicalHumanAttestationFromEnvironment(
  credentials: YuantaCredentials,
): YuantaCanonicalHumanAttestation | undefined {
  const managedSecret = process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY];
  return managedSecret
    ? deriveYuantaCanonicalHumanAttestation(credentials, managedSecret)
    : undefined;
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isCreditCardProductAbsentText(
  value: string | null | undefined,
): boolean {
  return /未持有信用卡|目前(?:無|沒有)信用卡|無信用卡產品|尚未申請信用卡|查無信用卡|無可用信用卡|未持有卡片/.test(
    cleanText(value),
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

function isCreditCardBillsPageResponse(response: Response): boolean {
  const request = response.request();
  return (
    request.method() === "GET" &&
    request.isNavigationRequest() &&
    // A redirect carries no body; the bills read is the document it lands on.
    response.status() < 300 &&
    new URL(response.url()).pathname === "/nib/tx/creditcardbillsquery"
  );
}

type CreditCardBillsPage = Readonly<{
  /** The scope that shows the bills page and holds its month form. */
  scope: BrowserScope;
  /** The bills page as the provider served it. */
  html: string;
}>;

/** Open the bills route and read the document the provider served for it. */
async function openCreditCardBillsPage(
  site: YuantaEbankSite,
): Promise<CreditCardBillsPage> {
  const { frames } = site;
  const [html, scope] = await Promise.all([
    frames
      .race(frames.page.waitForResponse(isCreditCardBillsPageResponse))
      .then((response) => site.readHtml(response)),
    site.open(CREDIT_CARD_BILLS_ROUTE),
  ]);
  return { scope, html };
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

/** Resolve a Playwright wait that ran out of time to null; cancellation and every other failure still reject. */
async function unlessTimedOut<T>(wait: Promise<T>): Promise<T | null> {
  try {
    return await wait;
  } catch (error) {
    if (error instanceof errors.TimeoutError) return null;
    throw error;
  }
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
      const bodyText = cleanText(
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
      const bodyText = cleanText(
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
      await frames.race(homeLink.click({ force: true }));
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

  await frames.race(link.click({ force: true }));
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
 * Keep the current-used-credit read only when the reviewed table parsed and
 * the provider response carries its date and cache evidence.
 */
function currentYuantaCreditEvidence(
  html: string,
  response: Response | null,
): YuantaCurrentUsedCreditSnapshot | undefined {
  const headers = response?.headers() ?? {};
  let parsed: YuantaCurrentUsedCreditSnapshot | undefined;
  try {
    parsed = parseYuantaCurrentCreditCardUsedCreditSummaryHtml(html);
  } catch {
    parsed = undefined;
  }
  if (
    !parsed ||
    !response ||
    response.status() !== 200 ||
    !headers.date ||
    !headers["cache-control"]
  )
    return undefined;
  return {
    ...parsed,
    endpoint: response.url(),
    httpDate: headers.date,
    cacheControl: headers["cache-control"],
  };
}

export async function loadYuantaCreditCardSummaryPage(
  site: YuantaEbankSite,
  link?: Locator,
): Promise<{
  firstHtml: string;
  response: Response | null;
  currentUsedCredit?: YuantaCurrentUsedCreditSnapshot;
}> {
  const { frames } = site;
  const [response] = await Promise.all([
    unlessTimedOut(
      frames.race(
        frames.page.waitForResponse(
          (candidate) =>
            candidate.url().includes("/nib/tx/creditcardsummary") &&
            candidate.request().method() === "POST",
          { timeout: 30_000 },
        ),
      ),
    ),
    (async () => {
      if (link) await frames.race(link.click());
      else
        await site.menuAction("creditcardsummary", "menu_creditcardsummary", 60_000);
      await frames.settle();
    })(),
  ]);
  const responseHtml = response ? await site.readHtml(response) : "";
  if (hasYuantaCurrentCreditTable(responseHtml)) {
    return {
      firstHtml: responseHtml,
      response,
      currentUsedCredit: currentYuantaCreditEvidence(responseHtml, response),
    };
  }

  let firstHtml: string;
  try {
    firstHtml = await readYuantaSummaryHtml(frames);
  } catch (error) {
    if (!(error instanceof FrameScopeTimeoutError)) throw error;
    throw new YuantaCreditSummaryNavigationError();
  }
  return {
    firstHtml,
    response,
    currentUsedCredit: currentYuantaCreditEvidence(firstHtml, response),
  };
}

async function traverseYuantaSummaryWithCurrentEvidence(
  site: YuantaEbankSite,
  firstHtml: string,
  currentUsedCredit: YuantaCurrentUsedCreditSnapshot | undefined,
  sourceText: SourceTextPort,
): Promise<YuantaCreditCardSummaryTraversal> {
  const { frames } = site;
  sourceText.assertIntact(firstHtml);
  frames.signal.throwIfAborted();
  let currentHtml = firstHtml;
  const current = currentUsedCredit ? { currentUsedCredit } : {};
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
        await frames.race(pager.click({ force: true }));
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
    if (!(error instanceof YuantaCreditCardSummaryParseError)) throw error;
    // The settled-summary page is an optional cross-check.  Keep a valid
    // current-used-credit evidence read even when the bank changes that table
    // independently of the historical statement parser.
    return { summaries: [], pages: [], ...current };
  }
}

async function submitCreditCardSummary(
  site: YuantaEbankSite,
  sourceText: SourceTextPort,
): Promise<YuantaCreditCardSummaryTraversal> {
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
    loaded = await loadYuantaCreditCardSummaryPage(site, link ?? undefined);
  } catch (error) {
    if (
      error instanceof YuantaCreditSummaryNavigationError ||
      error instanceof SourceTextIntegrityError ||
      site.frames.signal.aborted
    )
      throw error;
    throw new YuantaCreditSummaryNavigationError();
  }
  return await traverseYuantaSummaryWithCurrentEvidence(
    site,
    loaded.firstHtml,
    loaded.currentUsedCredit,
    sourceText,
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
  return new Date(milliseconds).toISOString().slice(0, 10);
}

function yuantaCreditCurrentSnapshotCapture(
  capture: YuantaCreditCardValidatedCapture,
  snapshot: YuantaCurrentUsedCreditSnapshot,
): ReturnType<typeof admitCreditCardCurrentBalanceCapture> {
  if (!snapshot.endpoint || !snapshot.httpDate || !snapshot.cacheControl)
    throw new Error("Yuanta current credit snapshot is missing response evidence.");
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
    effectiveTimeRuleVersion: "yuanta/credit-card/current-used-credit-v1",
    sourceField: "HTTP Date" as const,
    sourceValue: snapshot.httpDate,
    contractVersion: "yuanta/credit-card/current-used-credit-v1",
  };
  const estimate = {
    kind: "estimate" as const,
    basis: "provider-used-credit" as const,
    formula: "provider-reported-used-credit",
  };
  const observation: CreditCardCurrentBalanceObservationInput = {
    observationKey: "issuer-aggregate",
    balanceKind: "credit_used",
    balance: used,
    currency: "TWD",
    time,
    sourceRecordKey,
    sourceField: snapshot.sourceField,
    estimate,
  };
  return admitCreditCardCurrentBalanceCapture({
    captureId: `${capture.captureId}:current-used-credit`,
    authorityRoute: "yuanta/credit-card/current-used-credit-v1",
    contractVersion: "yuanta/credit-card/current-used-credit-v1",
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
    pages: [{
      pageOrdinal: 0,
      responseCode: "200",
      rowCount: 1,
      terminal: true,
      metadata: { sourceField: snapshot.sourceField, table: "rwdTable:first-credit-limit" },
    }],
    records: [creditCardCurrentBalanceSourceRecord({
      sourceRecordKey,
      providerKey,
      sourceField: snapshot.sourceField,
      balanceKind: "credit_used",
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
    })],
    observations: [observation],
  });
}

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
  return cleanText(value)
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
    consumeDate: cleanText(row.consumeDate),
    postedDate: cleanText(row.postedDate),
    description: cleanText(row.description),
    countryCurrency: cleanText(row.countryCurrency),
    foreignExchangeDate: cleanText(row.foreignExchangeDate),
    foreignAmount: cleanText(row.foreignAmount),
    twdAmount: cleanText(row.twdAmount),
    paymentStatus: cleanText(row.paymentStatus),
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
  await frames.race(
    bills.waitForSelector(
      'form#mform [name="cdHistoryQuery"], form[name="mform"] [name="cdHistoryQuery"]',
      { state: "attached", timeout: 120_000 },
    ),
  );
}

async function submitCreditCardMonth(
  site: YuantaEbankSite,
  bills: BrowserScope,
  month: MonthOption,
): Promise<string> {
  const { frames } = site;
  await waitForCreditCardForm(frames, bills);
  const [response] = await Promise.all([
    frames.race(
      frames.page.waitForResponse(
        (response) =>
          response
            .url()
            .includes("/nib/tx/creditcardbillsquery?method=queryHistoryDetail") &&
          response.request().method() === "POST",
        { timeout: 120_000 },
      ),
    ),
    frames.race(
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
    ),
  ]);
  return await site.readHtml(response);
}

async function submitCreditCardUnbilled(
  site: YuantaEbankSite,
  bills: BrowserScope,
): Promise<string> {
  const { frames } = site;
  await waitForCreditCardForm(frames, bills);
  const [response] = await Promise.all([
    frames.race(
      frames.page.waitForResponse(
        (response) =>
          response.url().includes("/nib/tx/creditcardunbilled") &&
          response.request().method() === "POST",
        { timeout: 120_000 },
      ),
    ),
    frames.race(
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
    ),
  ]);
  return await site.readHtml(response);
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
  return stageYuantaCreditCard(snapshot, input, context, product);
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
  /** The optional current used-credit evidence from the summary page. */
  currentUsedCredit?: YuantaCurrentUsedCreditSnapshot;
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
  const bills = await openCreditCardBillsPage(site);
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
      return submitCreditCardMonth(site, bills.scope, month);
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
    const unbilledHtml = await submitCreditCardUnbilled(site, bills.scope);
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

  let currentUsedCredit: YuantaCurrentUsedCreditSnapshot | undefined;
  if (input.includeSummary) {
    try {
      await product.reportActivity("query");
      const summaryTraversal = await submitCreditCardSummary(site, context.text);
      context.text.assertIntact(JSON.stringify(summaryTraversal));
      currentUsedCredit = summaryTraversal.currentUsedCredit;
    } catch (error) {
      // The current used credit is optional evidence; only text corruption
      // and cancellation stop the read here.
      if (
        error instanceof SourceTextIntegrityError ||
        context.signal.aborted
      ) {
        throw error;
      }
    }
  }

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
export function stageYuantaCreditCard(
  snapshot: YuantaCreditCardSourceSnapshot,
  input: YuantaCreditCardCollectionInput,
  context: WorkflowContext,
  product: ProductCollectionHandle,
): ProductCollectionSummary {
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
    const canonicalCaptures = buildYuantaCanonicalCreditCardCaptures({
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
    });
    if (canonicalCaptures.length > 0) {
      const requests = canonicalCaptures.map((capture) =>
        creditCardCommandRequestFromCanonicalCapture(
          yuantaCanonicalSpineCapture(capture),
          yuantaNeutralCreditCardCapture(capture),
        ),
      );
      const items: ProductStageRequest[] = requests.map((request) => ({
        product: "credit-card",
        itemKey: request.capture.captureId,
        command: {
          kind: PGLITE_CANONICAL_CREDIT_CARD_COMMIT_COMMAND,
          request,
        },
      }));
      if (currentUsedCredit) {
        const balanceCapture = yuantaCreditCurrentSnapshotCapture(
          canonicalCaptures[0]!,
          currentUsedCredit,
        );
        items.push({
          product: "current-balance",
          itemKey: balanceCapture.captureId,
          command: {
            kind: PGLITE_CANONICAL_CREDIT_CARD_BALANCE_COMMAND,
            request: creditCardBalanceCommandRequest(
              balanceCapture,
              requests[0]!.identity,
            ),
          },
        });
      }
      context.signal.throwIfAborted();
      product.stage(...items);
    }
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
