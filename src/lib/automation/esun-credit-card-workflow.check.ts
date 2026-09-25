import assert from "node:assert/strict";
import test from "node:test";
import type { Page, Response } from "playwright";
import type { WorkflowContext } from "./workflow-executor.ts";
import { strictSourceText } from "./source-text.ts";
import { esunCreditCardStatementsWorkflow } from "./esun-credit-card-workflow.ts";
import { CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY } from "./server/config-files.ts";

const timelineEndpoint = "/GW/creditLastYear/getFilterResult";
const summaryEndpoint = "/GW/creditBill/getSummaryResult";

function monthAtOffset(now: Date, offset: number): { year: string; month: string; day: string } {
  const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
  const day = Math.min(now.getDate(), new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate());
  return {
    year: String(date.getFullYear()),
    month: String(date.getMonth() + 1).padStart(2, "0"),
    day: String(day).padStart(2, "0"),
  };
}

function jsonResponse(value: unknown, url: string): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return byteResponse(bytes, url);
}

function byteResponse(bytes: Uint8Array, url: string): Response {
  return {
    status: () => 200,
    url: () => url,
    request: () => ({ method: () => "POST" }),
    body: async () => Buffer.from(bytes),
    headers: () => ({}),
  } as unknown as Response;
}

function timelineValue(now: Date, monthCount = 13): unknown {
  return {
    body: {
      rtnCode: "S",
      cursor: 1,
      transList: Array.from({ length: monthCount }, (_, offset) => {
        const month = monthAtOffset(now, offset);
        return {
          year: month.year,
          month: month.month,
          transDetailList: [{
            merchantName: `Synthetic purchase ${offset}`,
            paymentCurrency: "TWD",
            paymentAmount: 100 + offset,
            transCurrency: "TWD",
            transAmount: 100 + offset,
            cardNo: "1234-****-****-5678",
            statusName: offset === 0 ? "已入帳" : "未入帳",
            transMonthDay: `${month.month}${month.day}`,
          }],
        };
      }),
    },
  };
}

function issuerSummary(period: string): unknown {
  const [year, month] = period.split("/").map(Number);
  const lastDay = new Date(year!, month!, 0).getDate();
  const dueDate = new Date(year!, month!, 20);
  return {
    body: {
      rtnCode: "S",
      billInfo: {
        billDate: `${year}${String(month).padStart(2, "0")}${String(lastDay).padStart(2, "0")}`,
        paymentDueDate: `${dueDate.getFullYear()}${String(dueDate.getMonth() + 1).padStart(2, "0")}20`,
        billTotalInfoList: [{ billTotalCurrency: "TWD", billTotalAmount: 3200 }],
        minimumPaymentInfoList: [{ minimumPaymentCurrency: "TWD", minimumPaymentAmount: 200 }],
      },
    },
  };
}

function createPage(options: {
  timelineBytes?: Uint8Array;
  monthCount?: number;
  initialSignedIn?: boolean;
} = {}): Page & { finishSignIn(): void } {
  const now = new Date();
  const newestPeriod = monthAtOffset(now, 1);
  const oldestPeriod = monthAtOffset(now, 2);
  const periods = [
    `${newestPeriod.year}/${newestPeriod.month}`,
    `${oldestPeriod.year}/${oldestPeriod.month}`,
  ];
  const responses = [
    options.timelineBytes
      ? byteResponse(options.timelineBytes, timelineEndpoint)
      : jsonResponse(timelineValue(now, options.monthCount), timelineEndpoint),
    jsonResponse(issuerSummary(periods[1]!), summaryEndpoint),
    jsonResponse(issuerSummary(periods[0]!), summaryEndpoint),
  ];
  const inputValues = new Map<string, string>();
  let signedIn = options.initialSignedIn ?? true;
  const makeLocator = (selector: string) => ({
    waitFor: async () => undefined,
    click: async () => undefined,
    fill: async (value: string) => { inputValues.set(selector, value); },
    inputValue: async () => inputValues.get(selector) ?? "",
    isVisible: async () => true,
    allTextContents: async () => selector === ".info-scrollable li" ? periods : [],
    first() { return this; },
    last() { return this; },
    nth() { return this; },
    evaluate: async () => undefined,
    boundingBox: async () => ({ x: 1, y: 1, width: 640, height: 480 }),
  });
  const popup = {
    waitForURL: async () => undefined,
    waitForResponse: async (predicate: (response: Response) => boolean) => {
      const index = responses.findIndex((response) => predicate(response));
      if (index < 0) throw new Error("Unexpected E.SUN response waiter.");
      return responses.splice(index, 1)[0]!;
    },
    locator: (selector: string) => makeLocator(selector),
    getByText: () => ({ click: async () => undefined, isVisible: async () => true }),
    close: async () => undefined,
  };
  const page = {
    url: () => "https://ebank.esunbank.com.tw/index.jsp",
    getByText: (text: string) => ({
      isVisible: async () => text !== "信用卡" || signedIn,
      waitFor: async () => {
        if (text === "信用卡" && !signedIn) throw new Error("E.SUN card page is not visible yet.");
      },
      click: async () => undefined,
    }),
    waitForEvent: async () => popup,
    waitForResponse: async (predicate: (response: Response) => boolean) => {
      const response = {
        url: () => "https://ebank.esunbank.com.tw/esb/mib-ccm-portal/ccmA1/ccmA1001/home/getCardSummary",
        status: () => 204,
      } as unknown as Response;
      if (predicate(response)) return response;
      throw new Error("Optional current-credit response not present.");
    },
    locator: (selector: string) => makeLocator(selector),
    getByRole: (_role: string, options: { name?: string } = {}) => ({
      click: async () => undefined,
      isVisible: async () => options.name !== "確定登入",
    }),
    goto: async () => undefined,
    on: () => undefined,
  };
  return Object.assign(page, { finishSignIn() { signedIn = true; } }) as unknown as Page & { finishSignIn(): void };
}

function createContext(page: Page, completeAssistance?: () => void) {
  const events: Array<{ stage: string; code: string; counts?: unknown }> = [];
  const committed: unknown[][] = [];
  let withPageCount = 0;
  let assistanceCount = 0;
  const context: WorkflowContext = {
    runId: "run-esun-check",
    signal: new AbortController().signal,
    now: () => "2026-09-25T12:00:00.000Z",
    browser: {
      async withPage(run) {
        withPageCount += 1;
        return run(page);
      },
    },
    text: strictSourceText,
    humanAssistance: {
      async request(contract) {
        assistanceCount += 1;
        assert.equal(contract.stageId, "esun-login-verification");
        completeAssistance?.();
        return "verified";
      },
    },
    financialCommit: {
      async execute(items) {
        const materialized: unknown[] = [];
        for await (const item of items) materialized.push(item);
        committed.push(materialized);
        return {
          status: "completed",
          items: materialized.map(() => ({ status: "committed" })),
          diagnostics: [],
        } as never;
      },
    },
    async event(stage, code, counts) {
      events.push({ stage, code, counts });
    },
  };
  return {
    context,
    events,
    committed,
    get withPageCount() { return withPageCount; },
    get assistanceCount() { return assistanceCount; },
  };
}

test("E.SUN typed workflow commits a complete in-memory source through the injected port", async () => {
  const previousSecret = process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY];
  process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY] = "synthetic-esun-managed-secret";
  try {
    const harness = createContext(createPage());
    const output = await esunCreditCardStatementsWorkflow.run(harness.context, {
      credentials: {
        esun_user_id: "synthetic-user",
        esun_account: "synthetic-account",
        esun_password: "synthetic-password",
      },
    });

    assert.equal(harness.committed.length, 1);
    assert.equal(harness.committed[0]?.length, 1);
    assert.equal((harness.committed[0]?.[0] as { provider?: string }).provider, "esun");
    assert.equal((output as { canonicalAdmission?: string }).canonicalAdmission, "admitted");
    assert.equal("files" in (output as object), false);
    assert.deepEqual(
      harness.events.map(({ stage, code }) => [stage, code]),
      [
        ["authentication", "authentication-started"],
        ["authentication", "authentication-completed"],
        ["collection", "collection-started"],
        ["decoding", "source-decoding-started"],
        ["collection", "timeline-collected"],
        ["collection", "bill-summaries-collected"],
        ["decoding", "source-decoding-completed"],
        ["validation", "source-validation-started"],
        ["validation", "source-validation-completed"],
        ["commit", "canonical-commit-started"],
        ["commit", "canonical-commit-completed"],
      ],
    );
  } finally {
    if (previousSecret === undefined) delete process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY];
    else process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY] = previousSecret;
  }
});

test("E.SUN typed workflow rejects malformed text and incomplete timelines before commit", async () => {
  const previousSecret = process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY];
  process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY] = "synthetic-esun-managed-secret";
  try {
    for (const page of [
      createPage({ timelineBytes: new Uint8Array([0xc3, 0x28]) }),
      createPage({ monthCount: 12 }),
    ]) {
      const harness = createContext(page);
      await assert.rejects(
        esunCreditCardStatementsWorkflow.run(harness.context, {
          credentials: {
            esun_user_id: "synthetic-user",
            esun_account: "synthetic-account",
            esun_password: "synthetic-password",
          },
        }),
      );
      assert.equal(harness.committed.length, 0);
    }
  } finally {
    if (previousSecret === undefined) delete process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY];
    else process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY] = previousSecret;
  }
});

test("E.SUN typed workflow honors cancellation before opening a page or committing", async () => {
  const harness = createContext(createPage());
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const context = { ...harness.context, signal: controller.signal };
  await assert.rejects(
    esunCreditCardStatementsWorkflow.run(context, {
      credentials: {
        esun_user_id: "synthetic-user",
        esun_account: "synthetic-account",
        esun_password: "synthetic-password",
      },
    }),
    /cancelled/u,
  );
  assert.equal(harness.withPageCount, 0);
  assert.equal(harness.committed.length, 0);
});

test("E.SUN typed workflow routes a sign-in challenge through injected human assistance", async () => {
  const previousSecret = process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY];
  process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY] = "synthetic-esun-managed-secret";
  try {
    const page = createPage({ initialSignedIn: false });
    const harness = createContext(page, () => page.finishSignIn());
    await esunCreditCardStatementsWorkflow.run(harness.context, {
      credentials: {
        esun_user_id: "synthetic-user",
        esun_account: "synthetic-account",
        esun_password: "synthetic-password",
      },
    });
    assert.equal(harness.assistanceCount, 1);
    assert.equal(harness.committed.length, 1);
  } finally {
    if (previousSecret === undefined) delete process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY];
    else process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY] = previousSecret;
  }
});
