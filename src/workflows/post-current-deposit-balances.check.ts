import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS } from "../ledger/canonical/current-deposit-route-contracts.ts";
import {
  parsePostCurrentDepositBalanceSnapshot,
  postCurrentBalanceSnapshot,
  POST_CURRENT_DEPOSIT_RESPONSE,
  readPostCurrentDepositBalanceResponse,
  type ExistingPostCurrentDepositFinancialCapture,
  type PostCurrentDepositBalanceRow,
} from "./post-current-deposit-balances.ts";
import { captureCurrentStateSnapshots } from "./current-state-snapshot-capture.ts";
import { snapshotCheckProduct, stagedBalanceRequest } from "./current-state-snapshot-capture.fixtures.ts";
import type { Response } from "playwright";
import { type ProviderResponse, verifyProviderResponse } from "./provider-response.ts";
import { sourceReader } from "./provider-response-reader.ts";
import { fakeProviderReply } from "./provider-response-reader.fixtures.ts";
import { ProviderResponseCheckError } from "../lib/automation/provider-response-check.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";

const CONTRACT = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS["post/domestic-deposit/current-balance-v1"];

const observedAt = "2026-09-09T10:14:00+08:00";
const reader = sourceReader({
  now: () => "2026-09-09T02:14:00.000Z",
  text: strictSourceText,
});
const syntheticPostAccountNumber = ["0311", "5240", "5293", "95"].join("");
const conflictingPostAccountNumber = ["0311", "5240", "5293", "96"].join("");
const response: ProviderResponse = {
  url: `https://ipost.post.gov.tw${CONTRACT.endpointPath}`,
  status: 200,
  method: "POST",
  headers: {
    "content-type": "application/json; charset=UTF-8",
    "cache-control": "no-store,private,max-age=900",
    date: "Wed, 09 Sep 2026 02:13:03 GMT",
  },
};
const requestPostData = JSON.stringify({
  header: {
    TxnCode: CONTRACT.requestDiscriminant.txnCode,
    BizCode: CONTRACT.requestDiscriminant.bizCode,
    Authorization: "must-not-be-retained",
  },
  body: { pageCount: CONTRACT.requestDiscriminant.pageCount },
});

const psRow = {
  ACT_TYPE: "PS",
  ACT_NO: syntheticPostAccountNumber,
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
  responseOverrides: Partial<ProviderResponse> = {},
  requestBody: string | null = requestPostData,
): readonly PostCurrentDepositBalanceRow[] {
  const mergedResponse: ProviderResponse = {
    ...response,
    ...responseOverrides,
    headers: {
      ...response.headers,
      ...(responseOverrides.headers ?? {}),
    },
  };
  return parsePostCurrentDepositBalanceSnapshot({
    payload: candidate,
    response: verifyProviderResponse(POST_CURRENT_DEPOSIT_RESPONSE, mergedResponse, observedAt),
    requestPostData: requestBody,
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
    accountNo: syntheticPostAccountNumber,
    sourceAccountKey: syntheticPostAccountNumber,
    accountNumber: { value: syntheticPostAccountNumber },
    currency: "TWD",
  },
} as const;

test("Post parser keeps the PS BAL integer exact and preserves account zeroes", () => {
  const rows = parse();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.accountNumber, syntheticPostAccountNumber);
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
      parse(payload, {}, JSON.stringify({
        header: {
          TxnCode: "EB100104",
          BizCode: CONTRACT.requestDiscriminant.bizCode,
        },
        body: { pageCount: CONTRACT.requestDiscriminant.pageCount },
      })),
    /TxnCode/i,
  );
  assert.throws(
    () =>
      parse(payload, {}, JSON.stringify({
        header: {
          TxnCode: CONTRACT.requestDiscriminant.txnCode,
          BizCode: "otherOperation",
        },
        body: { pageCount: CONTRACT.requestDiscriminant.pageCount },
      })),
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

function postReply(bodyText: string, requestBody: string, headers: Record<string, string> = {}): Response {
  return fakeProviderReply({
    url: response.url,
    status: response.status,
    method: "POST",
    postData: requestBody,
    headers: { ...response.headers, ...headers },
    body: bodyText,
  });
}

class SequencedPostPage extends EventEmitter {
  selectedRequestBody: string | undefined;
  private readonly headers: Record<string, string>;

  constructor(headers: Record<string, string> = {}) {
    super();
    this.headers = headers;
  }
  private responsePredicate: ((candidate: Response) => boolean) | undefined;
  private responseResolve: ((candidate: Response) => void) | undefined;

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
            body: { pageCount: CONTRACT.requestDiscriminant.pageCount },
          });
          const correctRequest = JSON.stringify({
            header: {
              TxnCode: CONTRACT.requestDiscriminant.txnCode,
              BizCode: CONTRACT.requestDiscriminant.bizCode,
              Authorization: "RIGHT-AUTH-MUST-NOT-BE-RETAINED",
            },
            body: { pageCount: CONTRACT.requestDiscriminant.pageCount },
          });
          for (const candidate of [
            postReply(JSON.stringify(payload), wrongRequest, this.headers),
            postReply(JSON.stringify(payload), correctRequest, this.headers),
          ]) {
            if (!this.responsePredicate?.(candidate)) continue;
            this.selectedRequestBody = candidate.request().postData() ?? undefined;
            this.responseResolve?.(candidate);
            return;
          }
        },
      }),
    };
  }

  waitForResponse(
    predicate: (candidate: Response) => boolean,
  ): Promise<Response> {
    this.responsePredicate = predicate;
    return new Promise((resolve) => {
      this.responseResolve = resolve;
    });
  }
}

test("Post reader ignores earlier dispatcher responses until exact overview request", async () => {
  const page = new SequencedPostPage();
  const read = await readPostCurrentDepositBalanceResponse(page as never, {
    signal: new AbortController().signal,
    reader,
    timeoutMs: 100,
  });
  const selected = JSON.parse(page.selectedRequestBody ?? "{}");
  assert.equal(selected.header.TxnCode, CONTRACT.requestDiscriminant.txnCode);
  assert.equal(selected.header.BizCode, CONTRACT.requestDiscriminant.bizCode);
  assert.equal(read.evidence.kind, "json");
  const rows = parsePostCurrentDepositBalanceSnapshot({
    payload: JSON.parse(new TextDecoder().decode(read.evidence.bytes)),
    response: verifyProviderResponse(POST_CURRENT_DEPOSIT_RESPONSE, read.response, observedAt),
    requestPostData: read.requestPostData,
  });
  assert.equal(rows.length, 1);
  assert.doesNotMatch(JSON.stringify(rows), /AUTH-MUST-NOT-BE-RETAINED/u);
});

test("Post current deposit refuses a response that declares a charset other than UTF-8", async () => {
  const page = new SequencedPostPage({ "content-type": "application/json; charset=Big5" });
  const read = await readPostCurrentDepositBalanceResponse(page as never, {
    signal: new AbortController().signal,
    reader,
    timeoutMs: 100,
  });
  await assert.rejects(
    reader.accept(POST_CURRENT_DEPOSIT_RESPONSE, read),
    (error) => error instanceof ProviderResponseCheckError && error.check === "response-charset",
  );
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

/** Drive the declaration over this check's overview reply for the admitted captures. */
function snapshot(
  captures: readonly ExistingPostCurrentDepositFinancialCapture[],
  candidate = payload,
  responseHeaders: Record<string, string> = {},
) {
  return captureCurrentStateSnapshots(postCurrentBalanceSnapshot, {
    captures,
    acquire: async () => ({
      evidence: { kind: "json", bytes: new TextEncoder().encode(JSON.stringify(candidate)) },
      response: { ...response, headers: { ...response.headers, ...responseHeaders } },
      requestPostData,
    }),
    product: snapshotCheckProduct({ now: "2026-09-09T02:14:00.000Z" }),
  });
}

test("Post capture admission uses only BAL and the existing financial identity", async () => {
  const staged = await snapshot([financialCapture]);
  assert.equal(staged.matched[0]?.capture, financialCapture);
  assert.deepEqual(staged.items.map((item) => [item.product, item.itemKey]), [
    ["current-balance", `current-balance:domestic-deposit:${syntheticPostAccountNumber}`],
  ]);
  const request = stagedBalanceRequest(staged.items[0]);
  assert.equal(request.capture.routeKey, "post/domestic-deposit/current-balance-v1");
  assert.equal(request.capture.sourceConnectionKey, "post-user-existing-connection");
  assert.equal(request.capture.identityEpoch, "post-user-existing-epoch");
  assert.equal(request.capture.subjectDigest, token("post-subject"));
  assert.deepEqual([request.capture.scope.startDate, request.capture.scope.endDate], ["2026-09-09", "2026-09-09"]);
  assert.equal(request.account.sourceAccountKey, syntheticPostAccountNumber);
  assert.equal(request.account.currency, "TWD");
  assert.equal(request.observations.length, 1);
  assert.equal(request.observations[0]?.balanceKind, "ledger");
  assert.deepEqual(request.observations[0]?.balance, { coefficient: "12345", scale: 0 });
  assert.equal(request.observations[0]?.effectiveAt, "2026-09-09T02:13:03.000Z");
  assert.equal(request.observations[0]?.evidenceSourceField, "HTTP Date");
  assert.equal(request.observations[0]?.evidenceSourceValue, "Wed, 09 Sep 2026 02:13:03 GMT");
  assert.equal(request.capture.records[0]?.compact.sourceField, "BAL");
  assert.equal(request.capture.records[0]?.compact.balanceSourceLexeme, "0000012345");
  assert.deepEqual(
    [request.capture.pages[0]?.metadata.txnCode, request.capture.pages[0]?.metadata.bizCode],
    ["EB100103", "getOverViewById"],
  );
  assert.doesNotMatch(
    JSON.stringify(staged.items),
    /PBA_CUT_BAL|VISA_BAL|999999999999|777777|must-not-be-retained/u,
  );

  const serverTimestamp = stagedBalanceRequest((await snapshot([financialCapture], payload, { date: "" })).items[0]);
  assert.equal(serverTimestamp.observations[0]?.effectiveTimeBasis, "provider-system-time");
  assert.equal(serverTimestamp.observations[0]?.evidenceSourceField, "SERVER_TIMESTAMP");
  assert.equal(serverTimestamp.observations[0]?.evidenceSourceValue, "1788919984");

  await assert.rejects(
    snapshot([{
      identity: {
        ...financialCapture.identity,
        accountNo: conflictingPostAccountNumber,
        accountNumber: { value: conflictingPostAccountNumber },
      },
    }]),
    /does not exactly match/i,
    "a capture keyed to the row whose account evidence differs is refused",
  );
  await assert.rejects(
    snapshot([{ identity: { ...financialCapture.identity, currency: "USD" } }]),
    /not an admitted TWD domestic account/u,
  );
});

test("Post replay keys are stable while a changed BAL creates a new source record", async () => {
  const first = stagedBalanceRequest((await snapshot([financialCapture])).items[0]);
  const replay = stagedBalanceRequest((await snapshot([financialCapture])).items[0]);
  assert.notEqual(first.capture.captureId, replay.capture.captureId);
  assert.equal(first.observations[0]?.evidenceSourceRecordKey, replay.observations[0]?.evidenceSourceRecordKey);
  assert.equal(first.capture.records[0]?.contentHash, replay.capture.records[0]?.contentHash);
  assert.equal(first.observations[0]?.observationKey, replay.observations[0]?.observationKey);
  const changed = stagedBalanceRequest((await snapshot([financialCapture], [
    {
      ...payload[0],
      body: { itemList: [{ ...psRow, BAL: "0000012346" }] },
    },
    payload[1],
  ])).items[0]);
  assert.notEqual(first.observations[0]?.evidenceSourceRecordKey, changed.observations[0]?.evidenceSourceRecordKey);
  assert.equal(first.observations[0]?.observationKey, changed.observations[0]?.observationKey);
});

test("Post current balances fail closed when captures span more than one connection or epoch", async () => {
  const otherAccount = { accountNo: "post-other-account", sourceAccountKey: "post-other-account", accountNumber: { value: "post-other-account" } };
  for (const otherScope of [
    { sourceConnectionKey: "post-user-other-connection" },
    { identityEpochKey: "post-user-other-epoch" },
  ])
    await assert.rejects(
      snapshot([financialCapture, { identity: { ...financialCapture.identity, ...otherScope, ...otherAccount } }]),
      /^Error: Post current deposit captures span more than one source connection or identity epoch\.$/u,
    );
  const otherCapture = { identity: { ...financialCapture.identity, ...otherAccount } };
  assert.deepEqual(
    (await snapshot([otherCapture, financialCapture])).matched.map(({ capture }) => capture),
    [financialCapture],
    "captures in the run's one scope still match by their own key",
  );
  await assert.rejects(
    snapshot([otherCapture]),
    /^Error: Post current deposit snapshot contains an account without an existing admitted identity\.$/u,
    "a PS row without an admitted identity rejects the snapshot",
  );
});

test("Post BAL accepts only an ungrouped integer lexeme", () => {
  const withBal = (BAL: string) => [
    { ...payload[0], body: { itemList: [{ ...psRow, BAL }] } },
    payload[1],
  ];
  assert.deepEqual(parse(withBal("-000")).map((row) => row.ledger), [
    { coefficient: "0", scale: 0, sourceLexeme: "-000" },
  ]);
  assert.deepEqual(parse(withBal(" -0120 ")).map((row) => row.ledger), [
    { coefficient: "-120", scale: 0, sourceLexeme: "-0120" },
  ]);
  for (const BAL of ["1,234", "12 34", "12.0", "+12", ""])
    assert.throws(() => parse(withBal(BAL)), /BAL (must be an exact integer string|is blank)/u, BAL);
});
