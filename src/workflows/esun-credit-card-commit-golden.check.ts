import test from "node:test";
import type { WorkflowContextWith } from "../lib/automation/workflow-executor.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import { CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY } from "../lib/automation/server/config-files.ts";
import {
  createPage,
  runEsun,
  type EsunCardSummaryReply,
} from "../lib/automation/esun-credit-card-workflow.fixtures.ts";
import { assertCreditCardCommitGolden, recordDepositCommit, withCountedUuids } from "./deposit-commit-golden.ts";

const NOW = "2026-09-25T12:00:00.000Z";
const SECRET = "synthetic-esun-managed-secret";

// resultTime is Asia/Taipei civil time; it and the HTTP Date name the same instant as NOW.
const redesignedSummary: EsunCardSummaryReply = {
  body: {
    resultCode: "0000",
    resultTime: "2026-09-25 20:00:00",
    resultBody: { hasCreditCard: true, usedCreditLimit: "46,989", availableCreditLimit: "53,011" },
  },
  headers: { date: "Fri, 25 Sep 2026 12:00:00 GMT", "content-type": "application/json" },
};

async function runGolden(t: test.TestContext, name: string, cardSummary?: EsunCardSummaryReply): Promise<void> {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
  const previousSecret = process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY];
  process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY] = SECRET;
  try {
    const page = createPage(cardSummary ? { cardSummary } : {});
    const recorder = recordDepositCommit();
    const context: WorkflowContextWith<"financialCommit", "previewWrite"> = {
      runId: "run-esun-credit-card-golden",
      signal: new AbortController().signal,
      now: () => NOW,
      browser: { withPage: async (run) => run(page) },
      text: strictSourceText,
      verification: { async complete() {} },
      previewWrite: {
        async write() { throw new Error("The credit-card golden selects no preview product."); },
      },
      financialCommit: recorder.financialCommit,
      event: recorder.event,
      signalEvent: recorder.signalEvent,
    };
    const result = await withCountedUuids(() => runEsun(context, {
      managedIdentitySecret: SECRET,
      credentials: {
        esun_user_id: "synthetic-user",
        esun_account: "synthetic-account",
        esun_password: "synthetic-password",
      },
      statementTypes: ["credit_card"],
    }));
    await assertCreditCardCommitGolden(name, { result, ...recorder.recorded() });
  } finally {
    if (previousSecret === undefined) delete process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY];
    else process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY] = previousSecret;
  }
}

// getCardSummary is the only current-credit reply the workflow waits on, so only
// the redesigned v2 route is reachable; v1 (the FCM01006 dispatcher page) is not.
test("E.SUN card with a redesigned current used-credit summary", (t) =>
  runGolden(t, "esun-card-with-current-used-credit", redesignedSummary));

test("E.SUN card without a current used-credit summary", (t) =>
  runGolden(t, "esun-card-without-current-used-credit"));
