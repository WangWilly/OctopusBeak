import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  POST_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
  POST_CURRENT_DEPOSIT_BALANCE_PAGE_COUNT,
  POST_CURRENT_DEPOSIT_BALANCE_TXN_CODE,
  POST_CURRENT_DEPOSIT_BALANCE_BIZ_CODE,
  buildPostCurrentDepositBalanceCapture,
  parsePostCurrentDepositBalanceSnapshot,
  readPostCurrentDepositBalances,
  type PostCurrentDepositBalanceRow,
  type PostCurrentDepositResponseMetadata,
} from "./post-current-deposit-balances.ts";
import { admitCurrentDepositBalanceCapture } from "../ledger/canonical/current-deposit-balance-writer.ts";
import { runPostStatements } from "./post-statements.ts";

const observedAt = "2026-09-09T10:14:00.123+08:00";
const response: PostCurrentDepositResponseMetadata = {
  url: `https://ipost.post.gov.tw${POST_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH}`,
  status: 200,
  method: "POST",
  headers: {
    "content-type": "application/json; charset=UTF-8",
    "cache-control": "no-store,private,max-age=900",
    date: "Wed, 09 Sep 2026 02:13:03 GMT",
  },
  requestPostData: JSON.stringify({
    header: {
      TxnCode: POST_CURRENT_DEPOSIT_BALANCE_TXN_CODE,
      BizCode: POST_CURRENT_DEPOSIT_BALANCE_BIZ_CODE,
      Authorization: "must-not-be-retained",
    },
    body: { pageCount: POST_CURRENT_DEPOSIT_BALANCE_PAGE_COUNT },
  }),
};

const psRow = {
  ACT_TYPE: "PS",
  ACT_NO: "03115240529395",
  BAL: "0000012345",
  PBA_CUT_BAL: "999999999999",
  VISA_BAL: "777777",
};

type TestEnvelope = {
  header: Record<string, unknown>;
  body: Record<string, unknown>;
};

const payload: TestEnvelope[] = [
  {
    header: { EndBracket: false, OutputType: "Screen" },
    body: {
      itemList: [
        psRow,
        // Unsupported product rows are ignored after their category is checked.
        { ACT_TYPE: "CC", VISA_BAL: "1000000" },
      ],
    },
  },
  {
    header: {
      EndBracket: false,
      OutputType: "EndBracket",
      OutputData: { SERVER_TIMESTAMP: "1788919984" },
    },
    body: { result: "success" },
  },
];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function parse(
  candidate = payload,
  responseOverrides: Partial<PostCurrentDepositResponseMetadata> = {},
): readonly PostCurrentDepositBalanceRow[] {
  const mergedResponse: PostCurrentDepositResponseMetadata = {
    ...response,
    ...responseOverrides,
    headers: {
      ...response.headers,
      ...(responseOverrides.headers ?? {}),
    },
  };
  return parsePostCurrentDepositBalanceSnapshot({
    payload: candidate,
    response: mergedResponse,
    observedAt,
  });
}

function token(label: string): string {
  return `sha256:${createHash("sha256").update(label).digest("base64url")}`;
}

const financialCapture = {
  identity: {
    integrationNamespace: "post",
    sourceConnectionKey: "post-user-existing-connection",
    identityEpochKey: "post-user-existing-epoch",
    stream: "domestic-deposit",
    subjectDigest: token("post-subject"),
    accountNo: "03115240529395",
    sourceAccountKey: "03115240529395",
    accountNumber: { value: "03115240529395" },
    currency: "TWD",
  },
} as const;

test("Post parser keeps the PS BAL integer exact and preserves account zeroes", () => {
  const rows = parse();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.accountNumber, "03115240529395");
  assert.deepEqual(rows[0]?.ledger, {
    coefficient: "12345",
    scale: 0,
    sourceLexeme: "0000012345",
  });
  assert.equal(rows[0]?.effectiveAt, "2026-09-09T02:13:03.000Z");
  assert.equal(rows[0]?.effectiveTimeBasis, "provider-http-date");
  assert.equal(rows[0]?.effectiveTimeSourceField, "HTTP Date");
  assert.equal(rows[0]?.providerServerTimestamp, "1788919984");
  assert.equal(rows[0]?.sourceEvidence.txnCode, "EB100103");
  assert.equal(rows[0]?.sourceEvidence.bizCode, "getOverViewById");
  assert.equal("PBA_CUT_BAL" in (rows[0] ?? {}), false);
  assert.equal("VISA_BAL" in (rows[0] ?? {}), false);
});

test("Post parser requires the exact request discriminants and generic endpoint", () => {
  assert.throws(
    () =>
      parse(payload, {
        requestPostData: JSON.stringify({
          header: {
            TxnCode: "EB100104",
            BizCode: POST_CURRENT_DEPOSIT_BALANCE_BIZ_CODE,
          },
          body: { pageCount: POST_CURRENT_DEPOSIT_BALANCE_PAGE_COUNT },
        }),
      }),
    /TxnCode/i,
  );
  assert.throws(
    () =>
      parse(payload, {
        requestPostData: JSON.stringify({
          header: {
            TxnCode: POST_CURRENT_DEPOSIT_BALANCE_TXN_CODE,
            BizCode: "otherOperation",
          },
          body: { pageCount: POST_CURRENT_DEPOSIT_BALANCE_PAGE_COUNT },
        }),
      }),
    /BizCode/i,
  );
  assert.throws(
    () =>
      parse(payload, {
        url: `${response.url}?unexpected=1`,
      }),
    /endpoint/i,
  );
});

class FakePostResponse {
  private readonly bodyText: string;
  private readonly requestBody: string;

  constructor(
    bodyText: string,
    requestBody: string,
  ) {
    this.bodyText = bodyText;
    this.requestBody = requestBody;
  }

  url(): string {
    return response.url;
  }

  status(): number {
    return response.status;
  }

  request(): { method(): string; postData(): string } {
    return {
      method: () => "POST",
      postData: () => this.requestBody,
    };
  }

  async allHeaders(): Promise<Record<string, string>> {
    return { ...response.headers };
  }

  async body(): Promise<Buffer> {
    return Buffer.from(this.bodyText, "utf8");
  }
}

class SequencedPostPage extends EventEmitter {
  selectedRequestBody: string | undefined;
  private responsePredicate:
    | ((candidate: FakePostResponse) => boolean)
    | undefined;
  private responseResolve: ((candidate: FakePostResponse) => void) | undefined;

  url(): string {
    return "https://ipost.post.gov.tw/pst/index.html";
  }

  getByText(text: string): {
    first(): { waitFor(): Promise<void>; click(): Promise<void> };
  } {
    assert.equal(text, "資產總覽");
    return {
      first: () => ({
        waitFor: async () => {},
        click: async () => {
          const wrongRequest = JSON.stringify({
            header: {
              TxnCode: "EB100104",
              BizCode: "otherDispatcher",
              Authorization: "WRONG-AUTH-MUST-NOT-BE-RETAINED",
            },
            body: { pageCount: POST_CURRENT_DEPOSIT_BALANCE_PAGE_COUNT },
          });
          const correctRequest = JSON.stringify({
            header: {
              TxnCode: POST_CURRENT_DEPOSIT_BALANCE_TXN_CODE,
              BizCode: POST_CURRENT_DEPOSIT_BALANCE_BIZ_CODE,
              Authorization: "RIGHT-AUTH-MUST-NOT-BE-RETAINED",
            },
            body: { pageCount: POST_CURRENT_DEPOSIT_BALANCE_PAGE_COUNT },
          });
          for (const candidate of [
            new FakePostResponse(JSON.stringify(payload), wrongRequest),
            new FakePostResponse(JSON.stringify(payload), correctRequest),
          ]) {
            if (!this.responsePredicate?.(candidate)) continue;
            this.selectedRequestBody = candidate.request().postData();
            this.responseResolve?.(candidate);
            return;
          }
        },
      }),
    };
  }

  waitForResponse(
    predicate: (candidate: FakePostResponse) => boolean,
  ): Promise<FakePostResponse> {
    this.responsePredicate = predicate;
    return new Promise((resolve) => {
      this.responseResolve = resolve;
    });
  }
}

test("Post reader ignores earlier dispatcher responses until exact overview request", async () => {
  const page = new SequencedPostPage();
  const rows = await readPostCurrentDepositBalances(page as never, {
    observedAt,
    timeoutMs: 100,
  });
  assert.equal(rows.length, 1);
  assert.equal(
    JSON.parse(page.selectedRequestBody ?? "{}").header.TxnCode,
    POST_CURRENT_DEPOSIT_BALANCE_TXN_CODE,
  );
  assert.equal(
    JSON.parse(page.selectedRequestBody ?? "{}").header.BizCode,
    POST_CURRENT_DEPOSIT_BALANCE_BIZ_CODE,
  );
  assert.doesNotMatch(JSON.stringify(rows), /AUTH-MUST-NOT-BE-RETAINED/u);
});

test("Post parser rejects malformed or incomplete response envelopes and rows", () => {
  assert.throws(() => parse([payload[0]]), /Screen and EndBracket/i);
  assert.throws(
    () =>
      parse([
        { ...payload[0], body: { itemList: [null] } },
        payload[1],
      ]),
    /malformed row/i,
  );
  assert.throws(
    () =>
      parse([
        payload[0],
        { ...payload[1], body: { result: "failure" } },
      ]),
    /EndBracket.*success/i,
  );
  assert.throws(
    () =>
      parse([
        {
          ...payload[0],
          body: { itemList: [{ ...psRow, BAL: "" }] },
        },
        payload[1],
      ]),
    /BAL.*blank/i,
  );
  assert.throws(
    () =>
      parse([
        {
          ...payload[0],
          body: { itemList: [psRow, { ...psRow }] },
        },
        payload[1],
      ]),
    /duplicate/i,
  );
  assert.throws(
    () =>
      parse([
        {
          ...payload[0],
          body: { itemList: [{ ACT_TYPE: "CC" }] },
        },
        payload[1],
      ]),
    /no PS account/i,
  );
});

test("Post parser accepts a validated provider epoch when HTTP Date is absent", () => {
  const rows = parse(payload, {
    headers: {
      "date": "",
    },
  });
  assert.equal(rows[0]?.effectiveTimeBasis, "provider-system-time");
  assert.equal(rows[0]?.effectiveTimeSourceField, "SERVER_TIMESTAMP");
  assert.equal(rows[0]?.effectiveAt, "2026-09-09T02:13:04.000Z");
  assert.equal(rows[0]?.effectiveTimeSourceValue, "1788919984");
});

test("Post parser rejects unsupported or disagreeing provider timestamps", () => {
  assert.throws(
    () =>
      parse(payload, {
        headers: { date: "Wed, 09 Sep 2026 03:00:00 GMT" },
      }),
    /timestamps disagree/i,
  );
  const missingBoth = clone(payload) as typeof payload;
  delete (missingBoth[1].header as { OutputData?: unknown }).OutputData;
  assert.throws(
    () => parse(missingBoth, { headers: { date: "" } }),
    /no supported provider timestamp/i,
  );
  const invalidServerTime = clone(payload) as typeof payload;
  (invalidServerTime[1].header.OutputData as { SERVER_TIMESTAMP: string }).SERVER_TIMESTAMP =
    "1788919984.0";
  assert.throws(() => parse(invalidServerTime), /SERVER_TIMESTAMP.*epoch/i);
});

test("Post capture admission uses only BAL and the existing financial identity", () => {
  const row = parse()[0]!;
  const capture = buildPostCurrentDepositBalanceCapture(row, financialCapture);
  assert.equal(capture.providerResponse.requestDiscriminant?.txnCode, "EB100103");
  assert.equal(capture.providerResponse.requestDiscriminant?.bizCode, "getOverViewById");
  assert.equal(capture.observations[0]?.sourceField, "BAL");
  assert.deepEqual(capture.observations[0]?.balance, {
    coefficient: "12345",
    scale: 0,
  });
  assert.equal(capture.records[0]?.compact.balanceSourceLexeme, "0000012345");
  assert.equal("PBA_CUT_BAL" in (capture.records[0]?.compact ?? {}), false);
  assert.equal("VISA_BAL" in (capture.records[0]?.compact ?? {}), false);
  assert.doesNotThrow(() => admitCurrentDepositBalanceCapture(capture));
  const serverTimestampRow = parse(payload, { headers: { date: "" } })[0]!;
  assert.equal(serverTimestampRow.effectiveTimeBasis, "provider-system-time");
  assert.doesNotThrow(() =>
    admitCurrentDepositBalanceCapture(
      buildPostCurrentDepositBalanceCapture(serverTimestampRow, financialCapture),
    ),
  );
  assert.throws(
    () =>
      buildPostCurrentDepositBalanceCapture(row, {
        identity: {
          ...financialCapture.identity,
          accountNo: "03115240529396",
          accountNumber: { value: "03115240529396" },
        },
      }),
    /does not exactly match/i,
  );
});

test("Post replay keys are stable while a changed BAL creates a new source record", () => {
  const row = parse()[0]!;
  const first = buildPostCurrentDepositBalanceCapture(row, financialCapture);
  const replay = buildPostCurrentDepositBalanceCapture(row, financialCapture);
  assert.notEqual(first.captureId, replay.captureId);
  assert.equal(first.records[0]?.sourceRecordKey, replay.records[0]?.sourceRecordKey);
  assert.equal(first.records[0]?.contentHash, replay.records[0]?.contentHash);
  assert.equal(first.observations[0]?.observationKey, replay.observations[0]?.observationKey);
  const changed = buildPostCurrentDepositBalanceCapture(
    parse([
      {
        ...payload[0],
        body: { itemList: [{ ...psRow, BAL: "0000012346" }] },
      },
      payload[1],
    ])[0]!,
    financialCapture,
  );
  assert.notEqual(first.records[0]?.sourceRecordKey, changed.records[0]?.sourceRecordKey);
  assert.equal(first.observations[0]?.observationKey, changed.observations[0]?.observationKey);
});

test("Post financial workflow commits the current balance after account admission", async () => {
  const ledgerDir = await mkdtemp(join(tmpdir(), "post-current-workflow-check-"));
  try {
    const output = await runPostStatements({} as never, false, {
      canonicalSourceLedgerDir: ledgerDir,
      canonicalFinancialLedgerDir: ledgerDir,
      observedAt: "2026-09-09T10:14:00+08:00",
      readCurrentDepositBalances: async () => parse(),
      collectStatements: async () => [
        {
          accountId: "03115240529395",
          queryPeriods: ["2026/02/01~2026/08/24"],
          queryRange: { startDate: "2026/02/01", endDate: "2026/08/24" },
          httpStatus: 200,
          itemShape: "array" as const,
          rows: [
            {
              accountId: "03115240529395",
              sortKey: "20260824-101502-0",
              values: [
                "2026/08/24",
                "2026/08/24",
                "10:15:02",
                "薪資",
                "",
                "123.45",
                "1000.00",
                "",
              ],
              directionFlag: "inflow" as const,
            },
          ],
          download: {
            account: "03115240529395 郵局",
            accountId: "03115240529395",
            queryPeriods: ["2026/02/01~2026/08/24"],
            baseName: "post-current-workflow",
            csvFilename: "post-current-workflow.csv",
            csvPath: "/tmp/post-current-workflow.csv",
            csvBytes: 1,
            jsonFilename: "post-current-workflow.json",
            jsonPath: "/tmp/post-current-workflow.json",
            jsonBytes: 1,
            rowCount: 1,
          },
        },
      ],
    });
    assert.equal(output.status, "financial-admitted");
    const db = new DatabaseSync(join(ledgerDir, "canonical.sqlite"), {
      readOnly: true,
    });
    const currentCaptureCount = Number(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM source_captures WHERE authority_route = 'post/domestic-deposit/current-balance-v1'",
          )
          .get() as { count: number }
      ).count,
    );
    assert.equal(currentCaptureCount, 1);
    const revision = db
      .prepare(
        "SELECT balance_coefficient, balance_scale FROM balance_observation_revisions",
      )
      .get() as { balance_coefficient: string; balance_scale: number };
    assert.equal(revision.balance_coefficient, "12345");
    assert.equal(revision.balance_scale, 0);
    const account = db
      .prepare(
        "SELECT source_account_key, account_no FROM financial_accounts WHERE stream = 'domestic-deposit'",
      )
      .get() as { source_account_key: string; account_no: string };
    assert.equal(account.source_account_key, "03115240529395");
    assert.equal(account.account_no, "03115240529395");
    db.close();
  } finally {
    await rm(ledgerDir, { recursive: true, force: true });
  }
});
