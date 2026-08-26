import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { DatabaseSync } from "node:sqlite";
import { emitHumanAssistanceStage } from "./human-assistance.ts";
import {
  buildPostDomesticDepositCapture,
  dismissPostNoticeIfPresent,
  postCaptchaAssistanceStage,
  postCaptchaGenerationUnchanged,
  postDetailLinkSelector,
  postLoginEntryUrl,
  postLoginFieldValues,
  postManualAuthMessage,
  postProviderDate,
  postProviderDateShape,
  postRowsToStatementRows,
  postStatementRowsToCsv,
  runPostStatements,
  withPostAssistanceDeadline,
} from "./post-statements.ts";

function fakeNoticePage(visible: boolean) {
  let clicks = 0;
  const page = {
    getByRole(role: string, options: { name: string; exact: boolean }) {
      assert.equal(role, "button");
      assert.deepEqual(options, { name: "關閉", exact: true });
      return {
        first() {
          return this;
        },
        async isVisible() {
          return visible;
        },
        async click() {
          clicks += 1;
        },
      };
    },
    async waitForTimeout() {},
  };
  return { page, clicks: () => clicks };
}

{
  const present = fakeNoticePage(true);
  assert.equal(await dismissPostNoticeIfPresent(present.page as never), true);
  assert.equal(present.clicks(), 1);

  const absent = fakeNoticePage(false);
  assert.equal(await dismissPostNoticeIfPresent(absent.page as never), false);
  assert.equal(absent.clicks(), 0);
}

assert.equal(
  postManualAuthMessage("ses-1p4q"),
  "manual-auth-required: enter the iPost CAPTCHA in the browser, then run `npx libretto resume --session ses-1p4q`.",
);

assert.deepEqual(
  postLoginFieldValues({
    post_user_id: "post-user-id",
    post_account: "user-code",
    post_password: "pw",
  }),
  { cifId: "post-user-id", userCode: "user-code", password: "pw" },
);

assert.equal(postDetailLinkSelector(true), "a.btn_td_orange_dtl:visible");
assert.equal(postProviderDate("1150704"), "2026/07/04");
assert.equal(postProviderDate("20260704"), "2026/07/04");
assert.equal(postProviderDate("115/07/04"), "2026/07/04");
assert.equal(postProviderDate("2026-07-04"), "2026/07/04");
assert.equal(postProviderDateShape("20260704"), "gregorian-compact");
assert.equal(postProviderDateShape("115/07/04"), "roc-slash");
assert.equal(
  postLoginEntryUrl("https://ipost.post.gov.tw/pst/home.html"),
  true,
);
assert.equal(
  postLoginEntryUrl("https://ipost.post.gov.tw/pst/index.html"),
  false,
);
assert.equal(
  postCaptchaGenerationUnchanged(
    "https://ipost.post.gov.tw/pst/home.html",
    "https://ipost.post.gov.tw/pst/home.html",
    true,
  ),
  true,
);
assert.equal(
  postCaptchaGenerationUnchanged(
    "https://ipost.post.gov.tw/pst/home.html",
    "https://ipost.post.gov.tw/pst/home.html",
    false,
  ),
  false,
);

const browser = await chromium.launch();
try {
  const captchaPage = await browser.newPage();
  await captchaPage.setContent(`
    <input name="captcha" style="width: 92px; height: 32px" />
    <div class="codes_img">
      <img
        src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="
        style="width: 142px; height: 48px"
        alt="iPost CAPTCHA"
      />
    </div>
  `);
  const captchaContract = await emitHumanAssistanceStage(
    postCaptchaAssistanceStage(captchaPage),
    (contract) => contract,
  );
  assert.equal(captchaContract.stageId, "ipost-login-captcha");
  assert.equal(captchaContract.challengeKind, "text-captcha");
  assert.equal(captchaContract.charset, "digits");
  assert.deepEqual(captchaContract.imagePreprocessing, ["remove-interference-lines"]);
  assert.deepEqual(captchaContract.ocrAttemptPlan, [
    { ocrPageSegmentationMode: "single-line" },
    { ocrPageSegmentationMode: "single-word" },
  ]);
  assert.deepEqual(captchaContract.solveAcceptancePolicy, {
    mode: "confidence-or-agreement",
    conflictResolution: "reject",
  });
  assert.equal(captchaContract.expectedAnswerLength, 4);
  assert.equal(
    captchaContract.targets[0]?.semanticId,
    "post.login.captcha-input",
  );
  assert.equal(
    captchaContract.challengeImageRegion?.semanticId,
    "post.login.captcha-image",
  );
  assert.equal(captchaContract.challengeImageRegion?.rect?.width, 142);
  assert.equal(captchaContract.challengeImageRegion?.rect?.height, 48);
  await captchaPage.close();
} finally {
  await browser.close();
}

assert.equal(
  await withPostAssistanceDeadline(
    "the signed-in state probe",
    Promise.resolve("ready"),
    10,
  ),
  "ready",
);
await assert.rejects(
  withPostAssistanceDeadline(
    "the signed-in state probe",
    new Promise<never>(() => undefined),
    5,
  ),
  /iPost browser stopped responding during the signed-in state probe; start a fresh CAPTCHA assistance session\./,
);

const rows = postRowsToStatementRows("123456", [
  {
    PRS_DATE: "1150704",
    TX_TIME: "091502",
    MEM: "薪資",
    TX_AMT: "123.45",
    BAL_AMT: "1000.00",
    DR_FLG: "+",
    ATTACH_COMMENT: "備註",
  },
]);

assert.deepEqual(
  rows.map((row) => row.values),
  [
    [
      "2026/07/04",
      "2026/07/04",
      "09:15:02",
      "薪資",
      "",
      "123.45",
      "1000.00",
      "備註",
    ],
  ],
);

assert.equal(
  postStatementRowsToCsv(rows),
  "帳務日期,交易日期,交易時間,摘要,支出金額,存入金額,即時餘額,附註\n2026/07/04,2026/07/04,09:15:02,薪資,,123.45,1000.00,備註\n",
);

const builtCapture = buildPostDomesticDepositCapture(
  {
    accountId: "PRIVATE-ACCOUNT",
    queryPeriods: ["2026/02/01~2026/08/24"],
    queryRange: { startDate: "2026/02/01", endDate: "2026/08/24" },
    httpStatus: 200,
    itemShape: "array",
    rows,
  },
  "2026-08-24T10:11:12+08:00",
);
assert.equal(builtCapture.response.rows[0]?.directionFlag, "inflow");

const runDir = await mkdtemp(join(tmpdir(), "post-workflow-check-"));
try {
  const output = await runPostStatements({} as never, true, {
    canonicalSourceLedgerDir: runDir,
    observedAt: "2026-08-24T10:11:12+08:00",
    collectStatements: async () => [
      {
        accountId: "PRIVATE-ACCOUNT",
        queryPeriods: ["2026/02/01~2026/08/24"],
        queryRange: { startDate: "2026/02/01", endDate: "2026/08/24" },
        httpStatus: 200,
        itemShape: "array",
        rows,
        download: {
          account: "PRIVATE-ACCOUNT 郵局",
          accountId: "PRIVATE-ACCOUNT",
          queryPeriods: ["2026/02/01~2026/08/24"],
          baseName: "private",
          csvFilename: "private.csv",
          csvPath: "/private/private.csv",
          csvBytes: 1,
          jsonFilename: "private.json",
          jsonPath: "/private/private.json",
          jsonBytes: 1,
          rowCount: 1,
        },
      },
    ],
  });
  assert.deepEqual(
    {
      count: output.count,
      rowCount: output.rowCount,
      sourceCaptureCount: output.sourceCaptureCount,
      status: output.status,
    },
    { count: 1, rowCount: 1, sourceCaptureCount: 1, status: "source-only" },
  );
  const db = new DatabaseSync(join(runDir, "canonical.sqlite"), {
    readOnly: true,
  });
  assert.equal(
    Number(
      (
        db.prepare("SELECT COUNT(*) AS count FROM source_records").get() as {
          count: number;
        }
      ).count,
    ),
    1,
  );
  assert.equal(
    Number(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM financial_transactions")
          .get() as { count: number }
      ).count,
    ),
    0,
  );
  const payload = String(
    (
      db
        .prepare("SELECT payload_json AS payload FROM source_records")
        .get() as {
        payload: string;
      }
    ).payload,
  );
  for (const privateToken of ["PRIVATE-ACCOUNT", "薪資", "123.45"])
    assert.equal(payload.includes(privateToken), false, privateToken);
  db.close();
} finally {
  await rm(runDir, { recursive: true, force: true });
}

const financialRunDir = await mkdtemp(
  join(tmpdir(), "post-workflow-financial-check-"),
);
try {
  const output = await runPostStatements({} as never, false, {
    canonicalSourceLedgerDir: financialRunDir,
    canonicalFinancialLedgerDir: financialRunDir,
    observedAt: "2026-08-24T10:12:13+08:00",
    collectStatements: async () => [
      {
        accountId: "PRIVATE-ACCOUNT-FINANCIAL",
        queryPeriods: ["2026/02/01~2026/08/24"],
        queryRange: { startDate: "2026/02/01", endDate: "2026/08/24" },
        httpStatus: 200,
        itemShape: "array",
        rows,
        download: {
          account: "PRIVATE-ACCOUNT-FINANCIAL 郵局",
          accountId: "PRIVATE-ACCOUNT-FINANCIAL",
          queryPeriods: ["2026/02/01~2026/08/24"],
          baseName: "private-financial",
          csvFilename: "private-financial.csv",
          csvPath: "/private/private-financial.csv",
          csvBytes: 1,
          jsonFilename: "private-financial.json",
          jsonPath: "/private/private-financial.json",
          jsonBytes: 1,
          rowCount: 1,
        },
      },
    ],
  });
  assert.equal(output.status, "financial-admitted");
  const db = new DatabaseSync(join(financialRunDir, "canonical.sqlite"), {
    readOnly: true,
  });
  assert.equal(
    Number(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM financial_transactions")
          .get() as { count: number }
      ).count,
    ),
    1,
  );
  assert.equal(
    Number(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM source_captures WHERE authority_route = 'post/domestic-deposit/human-attested-v1'",
          )
          .get() as { count: number }
      ).count,
    ),
    1,
  );
  db.close();
} finally {
  await rm(financialRunDir, { recursive: true, force: true });
}
