import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright";
import { launchCheckBrowser } from "../lib/automation/check-browser.fixtures.ts";
import { ProviderResponseCheckError } from "../lib/automation/provider-response-check.ts";
import type { ProductCollectionHandle } from "../lib/automation/product-collection.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import { frameScope } from "./frame-scope.ts";
import type { ProviderResponseDeclaration } from "./provider-response.ts";
import { providerResponseReader, WITHOUT_PRODUCT_VALIDATION } from "./provider-response-reader.ts";

const ORIGIN = "https://bank.example";
const PROVIDER_DATE = "Wed, 09 Sep 2026 02:01:02 GMT";
const RUN_CLOCK = "2026-09-09T02:01:05.250Z";

const RESPONSE: ProviderResponseDeclaration<"required"> = {
  label: "Check bank history",
  host: "bank.example",
  endpoints: [{ path: "/history", method: "POST", contentType: /^application\/json\b/iu }],
  cacheControl: [],
  providerDate: "required",
};

let browser: Browser;
before(async () => {
  browser = await launchCheckBrowser();
});
after(async () => {
  await browser.close();
});

type Fulfil = Readonly<{ status?: number; body: string; delayMs?: number }>;

/** A bank page whose /history endpoint answers each POST body with the reply the check gives it. */
async function withBank(
  replies: (postData: string) => Fulfil | null,
  body: (page: Page) => Promise<void>,
): Promise<void> {
  const page = await browser.newPage();
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      const request = route.request();
      if (new URL(request.url()).pathname === "/") {
        await route.fulfill({ contentType: "text/html; charset=utf-8", body: "<!doctype html><p>bank</p>" });
        return;
      }
      const reply = replies(request.postData() ?? "");
      if (!reply) return;
      if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
      await route.fulfill({
        status: reply.status ?? 200,
        contentType: "application/json; charset=utf-8",
        headers: { date: PROVIDER_DATE },
        body: reply.body,
      }).catch(() => undefined);
    });
    await page.goto(`${ORIGIN}/`);
    await body(page);
  } finally {
    await page.close();
  }
}

const post = (page: Page, body: string) =>
  page.evaluate((sent) => fetch("/history", { method: "POST", body: sent }).then((response) => response.status), body);

/** A product validation that records whether a refusal reached it. */
function recordingValidation(): { validate: ProductCollectionHandle["validate"]; refused: unknown[] } {
  const refused: unknown[] = [];
  return {
    refused,
    validate: async (check) => {
      try {
        return await check();
      } catch (error) {
        refused.push(error);
        throw error;
      }
    },
  };
}

const readerWith = (validate: ProductCollectionHandle["validate"]) =>
  providerResponseReader({ now: () => RUN_CLOCK, text: strictSourceText, validate });

test("a captured response is accepted with the run clock, the request it answered and the trigger's value", async () => {
  await withBank(() => ({ body: '{"rows":[1]}' }), async (page) => {
    const { validate } = recordingValidation();
    const captured = await readerWith(validate).capture(frameScope(page, new AbortController().signal), RESPONSE, {
      evidence: "json",
      trigger: () => post(page, "q=1"),
    });
    assert.deepEqual(captured.evidence.value, { rows: [1] });
    assert.equal(captured.response.observedAt, "2026-09-09T10:01:05+08:00");
    assert.equal(captured.response.providerDate.raw, PROVIDER_DATE);
    assert.deepEqual(captured.request, { url: `${ORIGIN}/history`, method: "POST", postData: "q=1" });
    assert.equal(captured.triggered, 200);
  });
});

test("the request predicate picks the response that answers the source's own request", async () => {
  await withBank((postData) => ({ body: JSON.stringify({ answered: postData }) }), async (page) => {
    const { validate } = recordingValidation();
    const captured = await readerWith(validate).capture(frameScope(page, new AbortController().signal), RESPONSE, {
      evidence: "json",
      request: (request) => request.postData === "mine",
      trigger: async () => {
        await post(page, "other");
        await post(page, "mine");
      },
    });
    assert.deepEqual(captured.evidence.value, { answered: "mine" });
  });
});

test("a refused transport fails inside the caller's validation", async () => {
  await withBank(() => ({ status: 500, body: "{}" }), async (page) => {
    const { validate, refused } = recordingValidation();
    await assert.rejects(
      readerWith(validate).capture(frameScope(page, new AbortController().signal), RESPONSE, {
        evidence: "json",
        trigger: () => post(page, "q"),
      }),
      (error: unknown) => error instanceof ProviderResponseCheckError && error.check === "response-status",
    );
    assert.equal(refused.length, 1);
  });
});

test("undecodable evidence fails inside the caller's validation too", async () => {
  await withBank(() => ({ body: "not json" }), async (page) => {
    const { validate, refused } = recordingValidation();
    await assert.rejects(
      readerWith(validate).capture(frameScope(page, new AbortController().signal), RESPONSE, {
        evidence: "json",
        trigger: () => post(page, "q"),
      }),
      (error: unknown) => error instanceof ProviderResponseCheckError && error.check === "evidence-json",
    );
    assert.equal(refused.length, 1);
  });
});

test("a repeating trigger runs until the response arrives, then returns", async () => {
  let sent = false;
  await withBank(() => ({ body: "{}" }), async (page) => {
    const { validate } = recordingValidation();
    let rounds = 0;
    const captured = await readerWith(validate).capture(frameScope(page, new AbortController().signal), RESPONSE, {
      evidence: "json",
      trigger: async (replied) => {
        while (!replied.aborted) {
          rounds += 1;
          if (rounds === 3 && !sent) {
            sent = true;
            void post(page, "q");
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return rounds;
      },
    });
    assert.ok(captured.triggered >= 3);
  });
});

test("a trigger that throws fails the read without waiting for a response", async () => {
  await withBank(() => null, async (page) => {
    const { validate, refused } = recordingValidation();
    const started = Date.now();
    await assert.rejects(
      readerWith(validate).capture(frameScope(page, new AbortController().signal), RESPONSE, {
        evidence: "json",
        trigger: async () => {
          throw new Error("synthetic click failure");
        },
      }),
      /synthetic click failure/u,
    );
    assert.ok(Date.now() - started < 5_000);
    assert.equal(refused.length, 0);
  });
});

test("a response that never arrives times out outside validation and ends a repeating trigger", async () => {
  await withBank(() => null, async (page) => {
    const { validate, refused } = recordingValidation();
    let ended = false;
    await assert.rejects(readerWith(validate).capture(frameScope(page, new AbortController().signal), RESPONSE, {
      evidence: "json",
      timeoutMs: 300,
      trigger: async (replied) => {
        while (!replied.aborted) await new Promise((resolve) => setTimeout(resolve, 20));
        ended = true;
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(ended, true);
    assert.equal(refused.length, 0);
  });
});

test("cancelling the run rejects the read with the run's reason", async () => {
  await withBank(() => ({ body: "{}", delayMs: 2_000 }), async (page) => {
    const run = new AbortController();
    const reason = new Error("synthetic cancellation");
    const { validate } = recordingValidation();
    const reading = readerWith(validate).capture(frameScope(page, run.signal), RESPONSE, {
      evidence: "json",
      trigger: () => post(page, "q"),
    });
    setTimeout(() => run.abort(reason), 100);
    await assert.rejects(reading, (error: unknown) => error === reason);
  });
});

test("a response the source already holds is read the same way", async () => {
  await withBank(() => ({ body: '{"held":true}' }), async (page) => {
    const scope = frameScope(page, new AbortController().signal);
    const [response] = await Promise.all([page.waitForResponse(`${ORIGIN}/history`), post(page, "q")]);
    const reader = readerWith(recordingValidation().validate);
    const accepted = await reader.accept(RESPONSE, await reader.acquireFrom(scope, RESPONSE, response, "json"));
    assert.deepEqual(accepted.evidence.value, { held: true });
  });
});

test("a read no product owns refuses the response without product validation", async () => {
  const reader = providerResponseReader({ now: () => RUN_CLOCK, text: strictSourceText, validate: WITHOUT_PRODUCT_VALIDATION });
  await assert.rejects(
    reader.accept(RESPONSE, {
      response: { url: `${ORIGIN}/elsewhere`, status: 200, method: "POST", headers: { date: PROVIDER_DATE } },
      evidence: { kind: "json", bytes: new TextEncoder().encode("{}") },
    }),
    (error: unknown) => error instanceof ProviderResponseCheckError && error.check === "response-endpoint",
  );
});
