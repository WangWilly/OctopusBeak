import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  admitForeignCurrencyDepositCapture,
  commitForeignCurrencyDepositCapture,
} from "../ledger/canonical/foreign-currency-deposit.ts";
import { createCanonicalSourceStore } from "../ledger/canonical/canonical-source-store.ts";
import { deriveYuantaForeignSettlementLinkageKey } from "../ledger/canonical/investment-funding-relations.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./browser-interaction.js") {
      return nextResolve("./browser-interaction.ts", context);
    }
    if (specifier === "./yuanta-statements.js") {
      return nextResolve("./yuanta-statements.ts", context);
    }
    return nextResolve(specifier, context);
  },
});

const {
  readYuantaForeignCurrencyAccountOptions,
  readYuantaForeignCurrencyOptions,
  buildYuantaForeignCurrencyCaptureInput,
  classifyYuantaForeignCurrencyResultMarkup,
  classifyYuantaForeignCurrencyFrameRoute,
  diagnoseYuantaForeignCurrencyResultMarkup,
  clickYuantaForeignCurrencyCsvDownloadControl,
  findYuantaForeignCurrencyCsvDownloadControl,
  isYuantaForeignCurrencyCsvControl,
} = await import("./yuanta-foreign-currency-statements.ts");
const { StatementComponentAbsentError } =
  await import("./run-selected-statements.ts");

const foreignWorkflowSource = await readFile(
  new URL("./yuanta-foreign-currency-statements.ts", import.meta.url),
  "utf8",
);
assert.match(foreignWorkflowSource, /resolveCanonicalInvestmentFundingRelations/);
assert.match(
  foreignWorkflowSource,
  /await commitForeignCurrencyDepositCaptureBatch\([\s\S]*?resolveCanonicalInvestmentFundingRelations\(financialStore\)/,
);

const fixedForeignDateRange = {
  startDate: "2026-08-14",
  endDate: "2026-08-24",
};

assert.equal(
  classifyYuantaForeignCurrencyFrameRoute(
    "/nib/tx/fxtransactiondetails",
  ),
  "fxtransactiondetails",
);
assert.equal(
  classifyYuantaForeignCurrencyFrameRoute("/nib/login"),
  "login",
);
assert.equal(
  classifyYuantaForeignCurrencyFrameRoute("/nib/mainmenu"),
  "menu",
);
assert.equal(classifyYuantaForeignCurrencyFrameRoute("/"), "other");

function locatorForOptions(options: Array<{ value: string; label: string }>) {
  return {
    first: () => ({
      waitFor: async ({ state }: { state: "attached" }) => {
        assert.equal(state, "attached");
      },
    }),
    count: async () => options.length,
    nth: (index: number) => ({
      getAttribute: async (name: string) =>
        name === "value" ? (options[index]?.value ?? null) : null,
      textContent: async () => options[index]?.label ?? null,
    }),
  };
}

function foreignOptionsPage(
  accounts: Array<{ value: string; label: string }>,
  currencies: Array<{ value: string; label: string }>,
): never {
  return {
    frames: () => [],
    waitForTimeout: async () => {},
    locator: (selector: string) => {
      if (selector === "#acctno") return locatorForOptions(accounts);
      if (selector === "#acctno option") return locatorForOptions(accounts);
      if (selector === 'select[name="currency"] option') {
        return locatorForOptions(currencies);
      }
      throw new Error(`Unexpected selector ${selector}`);
    },
  } as never;
}

const yuantaForeignResultFixtures = {
  legacyLink:
    '<div id="resultdiv"><a class="order_2 m_color_check" href="/download">下載CSV檔</a></div>',
  changedButton:
    '<section id="resultDiv"><button type="button" aria-label="下載 CSV 檔案">下載 CSV 檔案</button></section>',
  normalizedExportLink:
    '<div class="result-container"><a title="匯出 CSV 檔"> CSV\u3000匯出 </a></div>',
  formDownload:
    '<div data-result-container="true"><form action="/fx/downloadCsv"><input type="submit" value="下載 CSV" /></form></div>',
  downloadAttribute:
    '<div id="result"><a download="statement.csv" aria-label="下載"></a></div>',
  delayedNestedControl:
    '<div id="resultdiv"><div><span><button role="button">Download CSV file</button></span></div></div>',
  nonNativeRoleButton:
    '<div id="resultdiv"><div role="button" data-action="downloadCsv">Download CSV file</div></div>',
  transactionTextContainsError:
    '<div id="resultdiv"><table><tbody><tr><td>交易說明</td><td>error text from transaction</td></tr></tbody></table><a href="/download">Download CSV file</a></div>',
  staleFirstResult:
    '<div id="resultdiv"><div class="loading">處理中</div></div><div class="result-container"><a href="/download">Download CSV file</a></div>',
  providerNoData:
    '<div id="resultdiv"><div class="notice">查無交易資料</div></div>',
  providerError:
    '<div id="resultdiv"><div class="error">查詢失敗，請稍後再試</div></div>',
  pendingResult: '<div id="resultdiv"><div class="loading">處理中</div></div>',
  noResult: '<main><p>查詢條件</p></main>',
  timestampOnlyResult:
    '<div id="resultdiv"><h2>查詢結果：</h2><p>查詢時間：2026/09/03 10:40:00</p></div>',
  unrelatedCsvOutsideResult:
    '<section id="resultDiv"><p>查詢結果</p></section><a href="/unrelated.csv">Download CSV file</a>',
  timestampOnlyWithExternalStatement:
    '<div id="resultdiv"><h2>查詢結果：</h2><p>查詢時間：2026/09/03 10:40:00</p></div><section id="statement-area"><table id="foreign-statement"><thead><tr><th>日期</th><th>金額</th></tr></thead><tbody><tr><td>20260903</td><td>12345</td></tr></tbody></table><a aria-label="下載 CSV 檔" href="/download">下載 CSV 檔</a></section>',
  liveFrameShape: `<div class="query-page">
    <div id="resultdiv"><h2>查詢結果：</h2><p>查詢時間：2026/09/03 10:40:00</p></div>
    <div class="summary-panel"><table id="summary-table"><thead><tr><th>摘要</th><th>幣別</th><th>狀態</th><th>時間</th></tr></thead><tbody></tbody></table></div>
    <div id="wide-table"><table><thead><tr><th>一</th><th>二</th><th>三</th><th>四</th><th>五</th><th>六</th><th>七</th><th>八</th><th>九</th><th>十</th><th>十一</th><th>十二</th></tr></thead><tbody>${Array.from({ length: 11 }, (_, index) => `<tr><td>${index}</td><td>資料</td></tr>`).join("")}</tbody></table></div>
    <div class="foreign-transaction-panel"><div class="foreign-table-wrap">
      <table class="normalTable"><thead><tr><th>日期</th><th>交易日</th><th>時間</th><th>幣別</th><th>說明</th><th>金額</th><th>餘額</th></tr></thead><tbody><tr><td>20260902</td><td>20260902</td><td>10:00</td><td>USD</td><td>買入</td><td>100</td><td>900</td></tr><tr><td>20260901</td><td>20260901</td><td>09:00</td><td>USD</td><td>賣出</td><td>50</td><td>950</td></tr></tbody></table>
      <form action="/statement-export"></form><div class="foreign-export"><a aria-label="下載 CSV 檔" href="/download">下載 CSV 檔</a></div>
    </div></div>
  </div>`,
} as const;

assert.equal(
  classifyYuantaForeignCurrencyResultMarkup(
    yuantaForeignResultFixtures.legacyLink,
  ).state,
  "download-ready",
);
assert.equal(
  classifyYuantaForeignCurrencyResultMarkup(
    yuantaForeignResultFixtures.legacyLink,
  ).csvControlCount,
  1,
);
assert.equal(
  isYuantaForeignCurrencyCsvControl(
    '<a class="order_2 m_color_check" href="/download">下載 CSV 檔</a>',
  ),
  true,
);
for (const fixture of [
  yuantaForeignResultFixtures.changedButton,
  yuantaForeignResultFixtures.normalizedExportLink,
  yuantaForeignResultFixtures.formDownload,
  yuantaForeignResultFixtures.downloadAttribute,
  yuantaForeignResultFixtures.delayedNestedControl,
]) {
  const classification = classifyYuantaForeignCurrencyResultMarkup(fixture);
  assert.equal(classification.state, "download-ready");
  assert.ok(classification.csvControlCount > 0);
  assert.doesNotMatch(JSON.stringify(classification), /downloadCsv|查無交易|account|123/iu);
}
assert.equal(
  classifyYuantaForeignCurrencyResultMarkup(
    yuantaForeignResultFixtures.nonNativeRoleButton,
  ).state,
  "download-ready",
);
assert.equal(
  isYuantaForeignCurrencyCsvControl(
    '<div role="button">Download CSV file</div>',
  ),
  true,
);
assert.equal(
  classifyYuantaForeignCurrencyResultMarkup(
    yuantaForeignResultFixtures.transactionTextContainsError,
  ).state,
  "download-ready",
);
assert.deepEqual(
  classifyYuantaForeignCurrencyResultMarkup(
    yuantaForeignResultFixtures.transactionTextContainsError,
  ).noticeKinds,
  [],
);
const transactionDiagnostics = diagnoseYuantaForeignCurrencyResultMarkup(
  yuantaForeignResultFixtures.transactionTextContainsError,
);
const adversarialUniqueTagMarkup = `<div id="resultdiv">${Array.from(
  { length: 2_000 },
  (_, index) => `<custom-tag-${index}></custom-tag-${index}>`,
).join("")}</div>`;
const adversarialResultContainerMarkup = Array.from(
  { length: 200 },
  (_, index) => `<div id="resultdiv"><span>result-${index}</span></div>`,
).join("");
assert.equal(transactionDiagnostics.resultContainers.length, 1);
assert.equal(transactionDiagnostics.resultContainers[0]!.containerTag, "div");
assert.equal(transactionDiagnostics.resultContainers[0]!.tableCount, 1);
assert.equal(transactionDiagnostics.resultContainers[0]!.headerCount, 0);
assert.equal(transactionDiagnostics.resultContainers[0]!.dataRowCountBucket, "1");
assert.match(transactionDiagnostics.resultContainers[0]!.textHash, /^[a-f0-9]{16}$/u);
assert.doesNotMatch(
  JSON.stringify(transactionDiagnostics),
  /error text from transaction|交易說明|account|123/iu,
);
const uniqueTagDiagnostics = diagnoseYuantaForeignCurrencyResultMarkup(
  adversarialUniqueTagMarkup,
);
assert.equal(uniqueTagDiagnostics.resultContainers.length, 1);
assert.equal(
  uniqueTagDiagnostics.resultContainers[0]!.descendantTagCounts.other,
  2_000,
);
assert.doesNotMatch(JSON.stringify(uniqueTagDiagnostics), /custom-tag-1999/iu);

const manyResultContainerDiagnostics = diagnoseYuantaForeignCurrencyResultMarkup(
  adversarialResultContainerMarkup,
);
assert.equal(manyResultContainerDiagnostics.resultContainers.length, 32);
assert.equal(manyResultContainerDiagnostics.resultContainerOverflowCount, 168);
assert.equal(
  manyResultContainerDiagnostics.resultContainerOverflowBucket,
  "51+",
);
assert.doesNotMatch(
  JSON.stringify(manyResultContainerDiagnostics),
  /result-199/iu,
);
assert.equal(
  classifyYuantaForeignCurrencyResultMarkup(
    yuantaForeignResultFixtures.staleFirstResult,
  ).state,
  "download-ready",
);
assert.equal(
  classifyYuantaForeignCurrencyResultMarkup(
    yuantaForeignResultFixtures.providerNoData,
  ).state,
  "provider-no-data",
);
assert.equal(
  classifyYuantaForeignCurrencyResultMarkup(
    yuantaForeignResultFixtures.providerError,
  ).state,
  "provider-error",
);
assert.equal(
  classifyYuantaForeignCurrencyResultMarkup(
    yuantaForeignResultFixtures.pendingResult,
  ).state,
  "pending",
);
assert.equal(
  classifyYuantaForeignCurrencyResultMarkup(yuantaForeignResultFixtures.noResult)
    .hasResult,
  false,
);
const timestampOnlyClassification = classifyYuantaForeignCurrencyResultMarkup(
  yuantaForeignResultFixtures.timestampOnlyWithExternalStatement,
);
assert.equal(timestampOnlyClassification.state, "pending");
assert.equal(timestampOnlyClassification.csvControlCount, 0);
assert.deepEqual(timestampOnlyClassification.noticeKinds, []);

type FakeElement = {
  tagName: string;
  outerHTML: string;
  textContent: string;
  attributes: Array<{ name: string; value: string }>;
  attrs: Record<string, string>;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  closest(selector: string): FakeElement | null;
  click(): void;
};

function fakeElement(markup: string): FakeElement {
  const opening = markup.match(/^<([a-z][\w:-]*)\b([^>]*)>/iu);
  const tagName = opening?.[1]?.toLowerCase() ?? "div";
  const attrs: Record<string, string> = {};
  for (const match of opening?.[2]?.matchAll(
    /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gu,
  ) ?? []) {
    attrs[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return {
    tagName,
    outerHTML: markup,
    textContent: markup
      .replace(/<[^>]*>/gu, " ")
      .replace(/\s+/gu, " ")
      .trim(),
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    attrs,
    getAttribute(name) {
      return this.attrs[name.toLowerCase()] ?? null;
    },
    hasAttribute(name) {
      return name.toLowerCase() in this.attrs;
    },
    closest() {
      return null;
    },
    click() {},
  };
}

function fakeControlElements(html: string): FakeElement[] {
  return [
    ...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/giu),
    ...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/giu),
    ...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/giu),
    ...html.matchAll(/<input\b[^>]*>/giu),
    ...html.matchAll(
      /<(?:div|span|li)\b[^>]*\brole\s*=\s*["']button["'][^>]*>[\s\S]*?<\/(?:div|span|li)>/giu,
    ),
  ].map((match) => fakeElement(match[0]));
}

function fakeElementsByTag(html: string, tagName: string): FakeElement[] {
  const pattern = new RegExp(
    `<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`,
    "giu",
  );
  return [...html.matchAll(pattern)].map((match) => fakeElement(match[0]!));
}

function fakeResultOpenings(html: string): RegExpMatchArray[] {
  return [
    ...html.matchAll(
      /<([a-z][\w:-]*)\b[^>]*\bid\s*=\s*["']result(?:div|container|area)?["'][^>]*>/giu,
    ),
    ...html.matchAll(
      /<([a-z][\w:-]*)\b[^>]*\bclass\s*=\s*["'][^"']*\bresult(?:div|container|area)?(?:[-\s"']|$)[^"']*["'][^>]*>/giu,
    ),
  ].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
}

function fakeResultMarkup(html: string, startAt = 0): string {
  const opening = fakeResultOpenings(html).find(
    (match) => (match.index ?? -1) >= startAt,
  );
  if (!opening || opening.index === undefined) return html;

  const tagName = opening[1]!;
  const tagPattern = new RegExp(`<\\/?${tagName}\\b[^>]*>`, "giu");
  tagPattern.lastIndex = opening.index;
  let depth = 0;
  for (const match of html.matchAll(tagPattern)) {
    const token = match[0];
    if (token.startsWith("</")) depth -= 1;
    else depth += 1;
    if (depth === 0) {
      return html.slice(opening.index, match.index! + token.length);
    }
  }
  return html.slice(opening.index);
}

function fakeResultMarkups(html: string): string[] {
  const openings = fakeResultOpenings(html);
  return openings.map((opening) => {
    const startAt = opening.index ?? 0;
    return fakeResultMarkup(html, startAt);
  });
}

type FakeElementResolver = () => FakeElement[];

class FakeLocator {
  private readonly resolveElements: FakeElementResolver;

  constructor(elements: FakeElement[], resolveElements?: FakeElementResolver) {
    this.resolveElements = resolveElements ?? (() => elements);
  }

  private elements(): FakeElement[] {
    return this.resolveElements();
  }

  first(): FakeLocator {
    return new FakeLocator([], () => this.elements().slice(0, 1));
  }

  nth(index: number): FakeLocator {
    return new FakeLocator([], () => this.elements().slice(index, index + 1));
  }

  async count(): Promise<number> {
    return this.elements().length;
  }

  async isVisible(): Promise<boolean> {
    const element = this.elements()[0];
    if (!element) return false;
    if (element.hasAttribute("hidden")) return false;
    if (element.getAttribute("aria-hidden")?.trim().toLowerCase() === "true") {
      return false;
    }
    const style = element.getAttribute("style")?.replace(/\/\*[\s\S]*?\*\//gu, "") ?? "";
    return !/(?:display\s*:\s*none|visibility\s*:\s*hidden)/iu.test(style);
  }

  async evaluate(callback: (element: FakeElement) => unknown): Promise<unknown> {
    const element = this.elements()[0];
    if (!element) throw new Error("missing fake element");
    return callback(element);
  }

  locator(selector: string): FakeLocator {
    return new FakeLocator([], () => {
      const element = this.elements()[0];
      if (!element) return [];
      return fakeScopeElements(element.outerHTML, selector);
    });
  }

  async waitFor(): Promise<void> {}

  async scrollIntoViewIfNeeded(): Promise<void> {}

  async click(): Promise<void> {
    const element = this.elements()[0];
    if (!element) throw new Error("missing fake element");
    element.click();
  }

  async innerText(): Promise<string> {
    return this.elements()[0]?.textContent ?? "";
  }

  async getAttribute(name: string): Promise<string | null> {
    return this.elements()[0]?.getAttribute(name) ?? null;
  }
}

function unescapeFakeCssAttributeValue(value: string): string {
  return value.replace(/\\([\\"])/gu, "$1");
}

function fakeStableAnchorElements(
  html: string,
  selector: string,
): FakeElement[] {
  const attributes = [
    ...selector.matchAll(
      /\[([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"((?:\\.|[^"])*)"\]/gu,
    ),
  ].map((match) => [
    match[1]!.toLowerCase(),
    unescapeFakeCssAttributeValue(match[2]!),
  ] as const);
  if (attributes.length === 0) return [];
  return fakeElementsByTag(html, "a").filter((element) =>
    attributes.every(
      ([name, value]) => element.getAttribute(name) === value,
    ),
  );
}

function fakeScopeElements(html: string, selector: string): FakeElement[] {
  if (selector === "body" || selector === "html") {
    return [fakeElement(html)];
  }
  if (selector === "table" || selector === "a") {
    return fakeElementsByTag(html, selector);
  }
  if (selector.startsWith("a[")) {
    return fakeStableAnchorElements(html, selector);
  }
  const resultSelector =
    selector.includes("#resultdiv") && selector.includes(".result-container");
  if (resultSelector) {
    const hasResult =
      /id\s*=\s*["']resultdiv["']/iu.test(html) ||
      /id\s*=\s*["']result["']/iu.test(html) ||
      /id\s*=\s*["']result(?:container|area)["']/iu.test(html) ||
      /class\s*=\s*["'][^"']*\bresult(?:div|container|area)?[^"']*["']/iu.test(
        html,
      ) ||
      /data-result-container(?:\s*=|\s|>)/iu.test(html);
    const hasDataResult = /data-result(?:\s*=|\s|>)/iu.test(html);
    return hasResult || hasDataResult
      ? fakeResultMarkups(html).map((markup) => fakeElement(markup))
      : [];
  }
  return fakeControlElements(html);
}

class FakeScope {
  private frameUrl: string;
  public html: string;
  public nativeClickCount = 0;
  public beforeNextNativeClick: (() => void) | undefined;
  public downloadWaitCount = 0;
  public pendingDownloadResolve: ((value: unknown) => void) | undefined;

  constructor(frameUrl: string, html: string) {
    this.frameUrl = frameUrl;
    this.html = html;
  }

  url(): string {
    return this.frameUrl;
  }

  setFrameUrl(frameUrl: string): void {
    this.frameUrl = frameUrl;
  }

  instrument(elements: FakeElement[]): FakeElement[] {
    return elements.map((element) => {
      element.click = () => {
        const beforeClick = this.beforeNextNativeClick;
        if (beforeClick) {
          this.beforeNextNativeClick = undefined;
          beforeClick();
          throw new Error("fake CSV control detached before native click");
        }
        this.nativeClickCount += 1;
        const resolveDownload = this.pendingDownloadResolve;
        this.pendingDownloadResolve = undefined;
        resolveDownload?.({ fake: "download" });
      };
      return element;
    });
  }

  locator(selector: string): FakeLocator {
    return new FakeLocator([], () =>
      this.instrument(fakeScopeElements(this.html, selector)),
    );
  }
}

class FakePage extends FakeScope {
  private readonly childFrames: FakeScope[];
  onWait: (() => void) | undefined;

  constructor(
    html: string,
    childFrames: FakeScope[] = [],
    frameUrl = "https://ebank.yuantabank.com.tw/nib/tx/fxtransactiondetails",
  ) {
    super(frameUrl, html);
    this.childFrames = childFrames;
  }

  frames(): FakeScope[] {
    return this.childFrames;
  }

  async waitForTimeout(_milliseconds?: number): Promise<void> {
    this.onWait?.();
  }

  waitForEvent(
    event: "download",
    _options: { timeout: number },
  ): Promise<unknown> {
    assert.equal(event, "download");
    this.downloadWaitCount += 1;
    return new Promise((resolve) => {
      this.pendingDownloadResolve = resolve;
    });
  }
}

const timestampOnlyTarget = await findYuantaForeignCurrencyCsvDownloadControl(
  new FakePage(yuantaForeignResultFixtures.timestampOnlyWithExternalStatement) as never,
  500,
);
assert.equal(await timestampOnlyTarget.control.innerText(), "下載 CSV 檔");

const liveFrameTarget = await findYuantaForeignCurrencyCsvDownloadControl(
  new FakePage(yuantaForeignResultFixtures.liveFrameShape) as never,
  500,
);
assert.equal(await liveFrameTarget.control.innerText(), "下載 CSV 檔");

// A page re-render can insert datepicker anchors before the CSV control. A
// global nth() locator follows the new position and would click the date, but
// the returned identity locator must re-find only the same CSV control.
const liveCsvAnchor = '<a aria-label="下載 CSV 檔" href="/download">下載 CSV 檔</a>';
const reorderedLivePage = new FakePage(yuantaForeignResultFixtures.liveFrameShape);
const unstableGlobalAnchors = reorderedLivePage.locator("a");
const reorderedTarget = await findYuantaForeignCurrencyCsvDownloadControl(
  reorderedLivePage as never,
  500,
);
reorderedLivePage.html = yuantaForeignResultFixtures.liveFrameShape.replace(
  liveCsvAnchor,
  '<a href="#" data-date="2">2</a>' + liveCsvAnchor,
);
assert.equal(await unstableGlobalAnchors.nth(0).innerText(), "2");
assert.equal(await reorderedTarget.control.innerText(), "下載 CSV 檔");
const refreshedReorderedControl = await reorderedTarget.refresh();
assert.ok(refreshedReorderedControl);
assert.equal(await refreshedReorderedControl.innerText(), "下載 CSV 檔");

// Detaching/replacing the control must fail closed rather than falling back to
// the newly inserted datepicker anchor.
reorderedLivePage.html = yuantaForeignResultFixtures.liveFrameShape.replace(
  liveCsvAnchor,
  '<a href="#" data-date="2">2</a>',
);
assert.equal(await reorderedTarget.refresh(), null);
reorderedLivePage.html = yuantaForeignResultFixtures.liveFrameShape;
reorderedLivePage.setFrameUrl(
  "https://ebank.yuantabank.com.tw/nib/mainmenu",
);
assert.equal(await reorderedTarget.refresh(), null);
reorderedLivePage.setFrameUrl(
  "https://ebank.yuantabank.com.tw/nib/tx/fxtransactiondetails",
);
reorderedLivePage.html = yuantaForeignResultFixtures.timestampOnlyResult;
assert.equal(await reorderedTarget.refresh(), null);
reorderedLivePage.html =
  yuantaForeignResultFixtures.liveFrameShape.replace(
    /<table class="normalTable">[\s\S]*?<\/table>/u,
    "",
  );
assert.equal(await reorderedTarget.refresh(), null);

// RED regression for the former refresh -> scroll -> click sequence: the
// already-resolved control becomes detached before the action and cannot be
// clicked, even though this is a transient provider re-render.
const staleActionPage = new FakePage(yuantaForeignResultFixtures.liveFrameShape);
const staleActionTarget = await findYuantaForeignCurrencyCsvDownloadControl(
  staleActionPage as never,
  500,
);
const staleActionControl = await staleActionTarget.refresh();
assert.ok(staleActionControl);
staleActionPage.onWait = () => {
  staleActionPage.html =
    yuantaForeignResultFixtures.timestampOnlyResult +
    '<a href="#" data-date="2">2</a>';
};
await staleActionControl!.scrollIntoViewIfNeeded();
await staleActionPage.waitForTimeout(500);
await assert.rejects(
  staleActionControl!.click(),
  /missing fake element/,
);

// GREEN: retry the complete finder after a detached native click. The second
// render is legitimate and must result in exactly one download-triggering
// native click.
const retryPage = new FakePage(yuantaForeignResultFixtures.liveFrameShape);
retryPage.beforeNextNativeClick = () => {
  retryPage.html = yuantaForeignResultFixtures.liveFrameShape.replace(
    liveCsvAnchor,
    '<a href="#" data-date="2">2</a>' + liveCsvAnchor,
  );
};
const retryDownload = await clickYuantaForeignCurrencyCsvDownloadControl(
  retryPage as never,
  500,
);
assert.deepEqual(retryDownload, { fake: "download" });
assert.equal(retryPage.nativeClickCount, 1);
assert.equal(retryPage.downloadWaitCount, 2);

// If the control is replaced with an unrelated datepicker, bounded retries
// fail closed and never click it or issue a second download request.
const failedRetryPage = new FakePage(yuantaForeignResultFixtures.liveFrameShape);
failedRetryPage.beforeNextNativeClick = () => {
  failedRetryPage.html =
    yuantaForeignResultFixtures.timestampOnlyResult +
    '<a href="#" data-date="2">2</a>';
};
await assert.rejects(
  clickYuantaForeignCurrencyCsvDownloadControl(failedRetryPage as never, 25),
  /Could not safely click YuanTa foreign-currency CSV download control/,
);
assert.equal(failedRetryPage.nativeClickCount, 0);

const hiddenWideTableFrame = yuantaForeignResultFixtures.liveFrameShape.replace(
  '<div id="wide-table"><table>',
  '<div id="wide-table"><table style="display: none">',
);
const hiddenWideTableTarget = await findYuantaForeignCurrencyCsvDownloadControl(
  new FakePage(hiddenWideTableFrame) as never,
  500,
);
assert.equal(await hiddenWideTableTarget.control.innerText(), "下載 CSV 檔");

const hiddenStatementTableFrame = yuantaForeignResultFixtures.liveFrameShape.replace(
  '<table class="normalTable">',
  '<table class="normalTable" style="display: none">',
);
await assert.rejects(
  findYuantaForeignCurrencyCsvDownloadControl(
    new FakePage(hiddenStatementTableFrame) as never,
    25,
  ),
  /Could not find YuanTa foreign-currency CSV download link in any frame\./,
);

const ambiguousLiveFrame = yuantaForeignResultFixtures.liveFrameShape.replace(
  '<div class="foreign-export">',
  '<table class="second-provider-table"><thead><tr><th>日期</th><th>說明</th></tr></thead><tbody><tr><td>20260903</td><td>另一張表</td></tr></tbody></table><div class="foreign-export">',
);
await assert.rejects(
  findYuantaForeignCurrencyCsvDownloadControl(
    new FakePage(ambiguousLiveFrame) as never,
    25,
  ),
  /Could not find YuanTa foreign-currency CSV download link in any frame\./,
);

const ambiguousLiveLinks = yuantaForeignResultFixtures.liveFrameShape.replace(
  "</a>",
  '</a><a aria-label="下載 CSV 檔" href="/download-2">第二個 CSV</a>',
);
await assert.rejects(
  findYuantaForeignCurrencyCsvDownloadControl(
    new FakePage(ambiguousLiveLinks) as never,
    25,
  ),
  /Could not find YuanTa foreign-currency CSV download link in any frame\./,
);

await assert.rejects(
  findYuantaForeignCurrencyCsvDownloadControl(
    new FakePage(
      yuantaForeignResultFixtures.liveFrameShape,
      [],
      "https://ebank.yuantabank.com.tw/nib/mainmenu",
    ) as never,
    25,
  ),
  /Could not find YuanTa foreign-currency CSV download link in any frame\./,
);

const providerNoDataPage = new FakePage(yuantaForeignResultFixtures.providerNoData);
await assert.rejects(
  findYuantaForeignCurrencyCsvDownloadControl(providerNoDataPage as never, 500),
  (error: unknown) => {
    assert.ok(error instanceof StatementComponentAbsentError);
    assert.match((error as Error).message, /no transaction data/i);
    return true;
  },
);

const providerErrorPage = new FakePage(yuantaForeignResultFixtures.providerError);
await assert.rejects(
  findYuantaForeignCurrencyCsvDownloadControl(providerErrorPage as never, 500),
  /explicit result error/i,
);

const diagnosticLogPage = new FakePage(
  yuantaForeignResultFixtures.timestampOnlyResult,
  [],
  "https://ebank.yuantabank.com.tw/nib/tx/fxtransactiondetails/account-1234567890/date-2026-09-03/event-transfer-abc/amount-12345/balance-67890?account=99887766#event=private-note",
);
const capturedDiagnosticLogs: unknown[][] = [];
const originalConsoleLog = console.log;
console.log = (...args: unknown[]) => {
  capturedDiagnosticLogs.push(args);
};
try {
  await assert.rejects(
    findYuantaForeignCurrencyCsvDownloadControl(diagnosticLogPage as never, 500),
    /Could not find YuanTa foreign-currency CSV download link in any frame\./,
  );
} finally {
  console.log = originalConsoleLog;
}
const diagnosticLog = capturedDiagnosticLogs.find(
  ([label]) => label === "yuanta-foreign-currency-result-observation",
);
assert.ok(diagnosticLog);
assert.equal(typeof diagnosticLog[1], "string");
const serializedDiagnostic = diagnosticLog[1] as string;
assert.doesNotMatch(serializedDiagnostic, /\[Array\]|\[Object\]/u);
assert.match(serializedDiagnostic, /"resultContainers":\[/u);
const parsedDiagnostic = JSON.parse(serializedDiagnostic) as {
  observations: Array<{
    framePath: string;
    framePathHash: string;
  }>;
};
assert.equal(parsedDiagnostic.observations[0]!.framePath, "fxtransactiondetails");
assert.match(parsedDiagnostic.observations[0]!.framePathHash, /^[a-f0-9]{16}$/u);
assert.doesNotMatch(
  serializedDiagnostic,
  /1234567890|2026-09-03|event-transfer-abc|12345|67890|99887766|private-note/iu,
);
assert.equal(
  serializedDiagnostic,
  JSON.stringify(JSON.parse(serializedDiagnostic)),
);
assert.doesNotMatch(
  JSON.stringify(capturedDiagnosticLogs),
  /20260903|12345|statement-area|foreign-statement|download\.csv|\/download/iu,
);

const timeoutPage = new FakePage(yuantaForeignResultFixtures.pendingResult);
await assert.rejects(
  findYuantaForeignCurrencyCsvDownloadControl(timeoutPage as never, 25),
  /Could not find YuanTa foreign-currency CSV download link in any frame\./,
);

const unrelatedCsvOutsideResultPage = new FakePage(
  yuantaForeignResultFixtures.unrelatedCsvOutsideResult,
);
await assert.rejects(
  findYuantaForeignCurrencyCsvDownloadControl(
    unrelatedCsvOutsideResultPage as never,
    25,
  ),
  /Could not find YuanTa foreign-currency CSV download link in any frame\./,
);

await assert.rejects(
  readYuantaForeignCurrencyAccountOptions(
    foreignOptionsPage([{ value: "", label: "請選擇帳戶" }], []),
  ),
  (error: unknown) => {
    assert.ok(error instanceof StatementComponentAbsentError);
    assert.equal(error.skipReason, "absent");
    return true;
  },
);

assert.deepEqual(
  await readYuantaForeignCurrencyAccountOptions(
    foreignOptionsPage(
      [
        { value: "", label: "請選擇帳戶" },
        { value: "fx-1", label: "外幣綜合存款" },
        { value: "fx-2", label: "外幣活期存款" },
      ],
      [],
    ),
  ),
  [
    { value: "fx-1", label: "外幣綜合存款" },
    { value: "fx-2", label: "外幣活期存款" },
  ],
);

assert.deepEqual(
  await readYuantaForeignCurrencyAccountOptions(
    foreignOptionsPage(
      [
        { value: "fx-1", label: "外幣綜合存款" },
        { value: "fx-2", label: "外幣活期存款" },
      ],
      [],
    ),
    ["missing"],
  ),
  [
    { value: "fx-1", label: "外幣綜合存款" },
    { value: "fx-2", label: "外幣活期存款" },
  ],
);

await assert.rejects(
  readYuantaForeignCurrencyOptions(
    foreignOptionsPage(
      [{ value: "fx-1", label: "外幣綜合存款" }],
      [{ value: "", label: "請選擇幣別" }],
    ),
  ),
  (error: unknown) => {
    assert.ok(error instanceof StatementComponentAbsentError);
    assert.equal(error.skipReason, "absent");
    return true;
  },
);

assert.deepEqual(
  await readYuantaForeignCurrencyOptions(
    foreignOptionsPage(
      [{ value: "fx-1", label: "外幣綜合存款" }],
      [
        { value: "ALL", label: "全部幣別" },
        { value: "USD", label: "美元" },
      ],
    ),
  ),
  [{ value: "ALL", label: "全部幣別" }],
);

const yuantaForeignCapture = buildYuantaForeignCurrencyCaptureInput(
  [
    {
      accountLabel: "外幣綜合存款",
      accountValue: "fx-1",
      queryCurrencyLabel: "全部幣別",
      queryCurrencyValue: "ALL",
      values: [
        "1",
        "20260823",
        "20260823",
        "09:10",
        "USD",
        "外幣存入",
        "",
        "10.00",
        "110.00",
        "交易資訊",
        "31.50",
      ],
      sortTime: null,
    },
  ],
  { dateRange: "one_week", customDateRange: fixedForeignDateRange, accountFilters: [], currencyFilters: [], channelType: "all", replaceActiveSession: true },
  "fx-1",
  "2026-08-24T12:00:00+08:00",
  "yuanta-foreign-check-observation-1",
  undefined,
  "synthetic-yuanta-login",
);
assert.equal(yuantaForeignCapture.accountType, "depository");
assert.equal(yuantaForeignCapture.records[0]!.currencyEvidence.currency, "USD");
assert.equal(
  (yuantaForeignCapture.records[0]!.sourcePayload as Record<string, unknown>)
    .settlementLinkageKey,
  deriveYuantaForeignSettlementLinkageKey("synthetic-yuanta-login", "USD"),
);
assert.equal(
  yuantaForeignCapture.records[0]!.sourceReportedRate?.rate,
  "31.5",
);
assert.deepEqual(
  admitForeignCurrencyDepositCapture(yuantaForeignCapture).records[0]!
    .conversionEvidence?.sourceReportedRate?.amount,
  { coefficient: "315", scale: 1 },
);

const yuantaMultipleRowsFromOneAccount =
  buildYuantaForeignCurrencyCaptureInput(
    [
      {
        accountLabel: "foreign account",
        accountValue: "foreign-account-1",
        queryCurrencyLabel: "all currencies",
        queryCurrencyValue: "ALL",
        values: [
          "foreign-account-1",
          "20260823",
          "20260823",
          "09:10:00",
          "USD",
          "deposit",
          "0",
          "10.00",
          "110.00",
          "first transaction",
          "31.50",
        ],
        sortTime: null,
      },
      {
        accountLabel: "foreign account",
        accountValue: "foreign-account-1",
        queryCurrencyLabel: "all currencies",
        queryCurrencyValue: "ALL",
        values: [
          "foreign-account-1",
          "20260822",
          "20260822",
          "08:20:00",
          "USD",
          "withdrawal",
          "5.00",
          "0",
          "105.00",
          "second transaction",
          "31.40",
        ],
        sortTime: null,
      },
    ],
    {
      dateRange: "three_months",
      customDateRange: fixedForeignDateRange,
      accountFilters: [],
      currencyFilters: [],
      channelType: "all",
      replaceActiveSession: true,
    },
    "foreign-account-1",
    "2026-08-24T12:00:00+08:00",
    "yuanta-foreign-check-multiple-rows-one-account",
  );
const admittedYuantaMultipleRowsFromOneAccount =
  admitForeignCurrencyDepositCapture(yuantaMultipleRowsFromOneAccount);
assert.equal(admittedYuantaMultipleRowsFromOneAccount.records.length, 2);
assert.notEqual(
  admittedYuantaMultipleRowsFromOneAccount.records[0]!.occurrenceKey,
  admittedYuantaMultipleRowsFromOneAccount.records[1]!.occurrenceKey,
);

const yuantaZeroPaddedInflow = buildYuantaForeignCurrencyCaptureInput(
  [
    {
      accountLabel: "外幣綜合存款",
      accountValue: "fx-1",
      queryCurrencyLabel: "全部幣別",
      queryCurrencyValue: "ALL",
      values: [
        "2",
        "20260818",
        "20260818",
        "10:51:56",
        "USD",
        "複委託入",
        "000000000000.00",
        "000000000126.3800",
        "000000000833.2000",
        "淨額入",
        "000001.000000",
      ],
      sortTime: null,
    },
  ],
  { dateRange: "three_months", customDateRange: fixedForeignDateRange, accountFilters: [], currencyFilters: [], channelType: "all", replaceActiveSession: true },
  "fx-1",
  "2026-08-24T12:00:00+08:00",
  "yuanta-foreign-check-zero-padded-inflow",
);
assert.equal(yuantaZeroPaddedInflow.records[0]!.direction, "inflow");
assert.equal(yuantaZeroPaddedInflow.records[0]!.amount, "126.38");
assert.equal(yuantaZeroPaddedInflow.records[0]!.balanceAfter, "833.2");
assert.equal(yuantaZeroPaddedInflow.records[0]!.originalAmount?.amount, "126.38");
assert.equal(yuantaZeroPaddedInflow.records[0]!.sourceReportedRate?.rate, "1");
assert.deepEqual(
  admitForeignCurrencyDepositCapture(yuantaZeroPaddedInflow).records[0]!.amount,
  { coefficient: "12638", scale: 2 },
);
assert.deepEqual(
  admitForeignCurrencyDepositCapture(yuantaZeroPaddedInflow).records[0]!
    .balanceAfter,
  { coefficient: "8332", scale: 1 },
);

const yuantaZeroPaddedOutflow = buildYuantaForeignCurrencyCaptureInput(
  [
    {
      accountLabel: "外幣綜合存款",
      accountValue: "fx-1",
      queryCurrencyLabel: "全部幣別",
      queryCurrencyValue: "ALL",
      values: [
        "3",
        "20260814",
        "20260814",
        "11:07:44",
        "USD",
        "複委託扣",
        "000000004603.5200",
        "000000000000.00",
        "000000000706.8200",
        "淨額扣",
        "000001.000000",
      ],
      sortTime: null,
    },
  ],
  { dateRange: "three_months", customDateRange: fixedForeignDateRange, accountFilters: [], currencyFilters: [], channelType: "all", replaceActiveSession: true },
  "fx-1",
  "2026-08-24T12:00:00+08:00",
  "yuanta-foreign-check-zero-padded-outflow",
);
assert.equal(yuantaZeroPaddedOutflow.records[0]!.direction, "outflow");
assert.equal(yuantaZeroPaddedOutflow.records[0]!.amount, "4603.52");
assert.deepEqual(
  admitForeignCurrencyDepositCapture(yuantaZeroPaddedOutflow).records[0]!.amount,
  { coefficient: "460352", scale: 2 },
);

const yuantaUnpaddedInflow = buildYuantaForeignCurrencyCaptureInput(
  [
    {
      accountLabel: "外幣綜合存款",
      accountValue: "fx-1",
      queryCurrencyLabel: "全部幣別",
      queryCurrencyValue: "ALL",
      values: [
        "2",
        "20260818",
        "20260818",
        "10:51:56",
        "USD",
        "複委託入",
        "0",
        "126.38",
        "833.2",
        "淨額入",
        "1",
      ],
      sortTime: null,
    },
  ],
  { dateRange: "three_months", customDateRange: fixedForeignDateRange, accountFilters: [], currencyFilters: [], channelType: "all", replaceActiveSession: true },
  "fx-1",
  "2026-08-24T12:00:00+08:00",
  "yuanta-foreign-check-unpadded-inflow",
);
assert.equal(
  admitForeignCurrencyDepositCapture(yuantaZeroPaddedInflow).records[0]!.contentHash,
  admitForeignCurrencyDepositCapture(yuantaUnpaddedInflow).records[0]!.contentHash,
);

const yuantaDifferentForeignAmount = buildYuantaForeignCurrencyCaptureInput(
  [
    {
      accountLabel: "外幣綜合存款",
      accountValue: "fx-1",
      queryCurrencyLabel: "全部幣別",
      queryCurrencyValue: "ALL",
      values: [
        "2",
        "20260818",
        "20260818",
        "10:51:56",
        "USD",
        "複委託入",
        "0",
        "126.39",
        "833.2",
        "淨額入",
        "1",
      ],
      sortTime: null,
    },
  ],
  { dateRange: "three_months", customDateRange: fixedForeignDateRange, accountFilters: [], currencyFilters: [], channelType: "all", replaceActiveSession: true },
  "fx-1",
  "2026-08-24T12:00:00+08:00",
  "yuanta-foreign-check-different-amount",
);
assert.notEqual(
  admitForeignCurrencyDepositCapture(yuantaDifferentForeignAmount).records[0]!.contentHash,
  admitForeignCurrencyDepositCapture(yuantaUnpaddedInflow).records[0]!.contentHash,
);

assert.throws(
  () =>
    buildYuantaForeignCurrencyCaptureInput(
      [
        {
          accountLabel: "外幣綜合存款",
          accountValue: "fx-1",
          queryCurrencyLabel: "全部幣別",
          queryCurrencyValue: "ALL",
          values: [
            "4",
            "20260818",
            "20260818",
            "10:51:56",
            "USD",
            "雙向",
            "1.00",
            "2.00",
            "833.20",
            "",
            "1.000000",
          ],
          sortTime: null,
        },
      ],
      { dateRange: "three_months", customDateRange: fixedForeignDateRange, accountFilters: [], currencyFilters: [], channelType: "all", replaceActiveSession: true },
      "fx-1",
      "2026-08-24T12:00:00+08:00",
      "yuanta-foreign-check-both-nonzero",
    ),
  /exactly one amount direction/i,
);

assert.throws(
  () =>
    buildYuantaForeignCurrencyCaptureInput(
      [
        {
          accountLabel: "外幣綜合存款",
          accountValue: "fx-1",
          queryCurrencyLabel: "全部幣別",
          queryCurrencyValue: "ALL",
          values: [
            "5",
            "20260818",
            "20260818",
            "10:51:56",
            "USD",
            "雙零",
            "000000000000.00",
            "000000000000.00",
            "833.20",
            "",
            "1.000000",
          ],
          sortTime: null,
        },
      ],
      { dateRange: "three_months", customDateRange: fixedForeignDateRange, accountFilters: [], currencyFilters: [], channelType: "all", replaceActiveSession: true },
      "fx-1",
      "2026-08-24T12:00:00+08:00",
      "yuanta-foreign-check-both-zero",
    ),
  /exactly one amount direction/i,
);

assert.throws(
  () =>
    buildYuantaForeignCurrencyCaptureInput(
      [
        {
          accountLabel: "外幣綜合存款",
          accountValue: "fx-1",
          queryCurrencyLabel: "全部幣別",
          queryCurrencyValue: "ALL",
          values: [
            "6",
            "20260818",
            "20260818",
            "10:51:56",
            "USD",
            "無效金額",
            "not-a-number",
            "0",
            "833.20",
            "",
            "1.000000",
          ],
          sortTime: null,
        },
      ],
      { dateRange: "three_months", customDateRange: fixedForeignDateRange, accountFilters: [], currencyFilters: [], channelType: "all", replaceActiveSession: true },
      "fx-1",
      "2026-08-24T12:00:00+08:00",
      "yuanta-foreign-check-invalid-amount",
    ),
  /exact decimal/i,
);

const yuantaCorrectedMutableFacts = buildYuantaForeignCurrencyCaptureInput(
  [
    {
      accountLabel: "外幣綜合存款",
      accountValue: "fx-1",
      queryCurrencyLabel: "全部幣別",
      queryCurrencyValue: "ALL",
      values: [
        "1",
        "20260824",
        "20260824",
        "10:30",
        "USD",
        "更正後說明",
        "10.00",
        "",
        "100.00",
        "更正後交易資訊",
        "31.60",
      ],
      sortTime: null,
    },
  ],
  { dateRange: "one_week", customDateRange: fixedForeignDateRange, accountFilters: [], currencyFilters: [], channelType: "all", replaceActiveSession: true },
  "fx-1",
  "2026-08-24T13:00:00+08:00",
  "yuanta-foreign-check-observation-2",
);
assert.notEqual(
  yuantaCorrectedMutableFacts.records[0]!.sourceKey,
  yuantaForeignCapture.records[0]!.sourceKey,
);
assert.throws(
  () =>
    buildYuantaForeignCurrencyCaptureInput(
      [
        {
          accountLabel: "外幣綜合存款",
          accountValue: "fx-1",
          queryCurrencyLabel: "全部幣別",
          queryCurrencyValue: "ALL",
          values: ["1", "20260823", "20260823", "09:10", "", "存入", "", "10", "110", "", "31.5"],
          sortTime: null,
        },
      ],
      { dateRange: "one_week", customDateRange: fixedForeignDateRange, accountFilters: [], currencyFilters: [], channelType: "all", replaceActiveSession: true },
      "fx-1",
      "2026-08-24T12:00:00+08:00",
      "yuanta-foreign-check-observation-invalid",
    ),
  /source currency/i,
);

const emptyYuantaCapture = buildYuantaForeignCurrencyCaptureInput(
  [],
  { dateRange: "one_week", customDateRange: fixedForeignDateRange, accountFilters: [], currencyFilters: [], channelType: "all", replaceActiveSession: true },
  "fx-empty-133",
  "2026-08-24T12:00:00+08:00",
  "yuanta-foreign-check-empty-observation",
  "provider-explicit-no-data",
);
const yuantaEmptyDirectory = await mkdtemp(join(tmpdir(), "yuanta-foreign-empty-133-"));
try {
  const store = createCanonicalSourceStore(join(yuantaEmptyDirectory, "canonical.sqlite"));
  const result = await commitForeignCurrencyDepositCapture(
    store,
    admitForeignCurrencyDepositCapture(emptyYuantaCapture),
  );
  assert.equal(result.transactionCount, 0);
  assert.equal(
    Number((store.db.prepare("SELECT COUNT(*) AS count FROM source_captures").get() as { count?: number }).count ?? 0),
    1,
  );
  assert.equal(
    Number((store.db.prepare("SELECT COUNT(*) AS count FROM source_sync_states").get() as { count?: number }).count ?? 0),
    1,
  );
  store.close();
} finally {
  await rm(yuantaEmptyDirectory, { recursive: true, force: true });
}
