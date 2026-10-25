import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HumanAssistanceContractInput } from "./human-assistance.ts";
import { signalRunEvent } from "./run-event.ts";
import {
  reportedVerificationPort,
  resolveVerificationStage,
  VerificationStageIncompleteError,
  type VerificationStage,
} from "./verification-stage.ts";
import type { WorkflowHumanAssistancePort } from "./workflow-executor.ts";

const TARGET_BOX = { x: 10, y: 20, width: 100, height: 24 };

function captchaStage(overrides: Partial<VerificationStage> = {}): VerificationStage {
  return {
    stageId: "bank-login-captcha",
    title: "Enter the CAPTCHA",
    targets: [{
      id: "captcha-input",
      label: "CAPTCHA input",
      semanticId: "bank.login.captcha-input",
      modes: ["click", "type"],
      locator: { boundingBox: async () => TARGET_BOX },
    }],
    contextRegions: [{
      id: "captcha-challenge",
      label: "CAPTCHA challenge",
      semanticId: "bank.login.captcha-challenge",
      locator: { boundingBox: async () => ({ x: 0, y: 0, width: 200, height: 80 }) },
    }],
    completion: { mode: "inline", targetIds: ["captcha-input"] },
    focus: { targetId: "captcha-input", contextRegionIds: ["captcha-challenge"] },
    challengeKind: "text-captcha",
    ...overrides,
  };
}

type Host = (signal: AbortSignal, abort: () => void) => ReturnType<WorkflowHumanAssistancePort["request"]>;
type Expected = "resolved" | "incomplete" | "abort-reason";

const REQUESTED = { stage: "authentication", outcome: "advanced", code: "human-assistance-requested", signal: undefined };
const COMPLETED = { stage: "authentication", outcome: "advanced", code: "human-assistance-completed", signal: undefined };
const FAILED = { stage: "authentication", outcome: "failed", code: "human-assistance-failed", signal: "human-assistance-failed" };

const neverSettles = new Promise<never>(() => undefined);
const unresolvable = { boundingBox: async () => null };

const rows: readonly Readonly<{
  name: string;
  stage?: (abort: () => void) => VerificationStage;
  abortBeforeStart?: true;
  host: Host;
  events: readonly object[];
  requested: boolean;
  expected: Expected;
}>[] = [
  { name: "entered", host: async () => "entered", events: [REQUESTED, COMPLETED], requested: true, expected: "resolved" },
  { name: "verified", host: async () => "verified", events: [REQUESTED, COMPLETED], requested: true, expected: "resolved" },
  { name: "failed status", host: async () => "failed", events: [REQUESTED, FAILED], requested: true, expected: "incomplete" },
  {
    name: "host throw",
    host: async () => { throw new Error("private host route detail"); },
    events: [REQUESTED, FAILED],
    requested: true,
    expected: "incomplete",
  },
  {
    name: "abort during a request the host never settles",
    host: (_signal, abort) => {
      queueMicrotask(abort);
      return neverSettles;
    },
    events: [REQUESTED],
    requested: true,
    expected: "abort-reason",
  },
  {
    name: "abort during a request the host rejects",
    host: (signal, abort) => {
      const hostRejection = new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("host noticed the abort")), { once: true });
      });
      queueMicrotask(abort);
      return hostRejection;
    },
    events: [REQUESTED],
    requested: true,
    expected: "abort-reason",
  },
  {
    name: "abort before start",
    abortBeforeStart: true,
    host: async () => "verified",
    events: [],
    requested: false,
    expected: "abort-reason",
  },
  {
    name: "abort while resolving",
    stage: (abort) => captchaStage({
      targets: [{
        ...captchaStage().targets[0]!,
        locator: { boundingBox: () => { abort(); return neverSettles; } },
      }],
    }),
    host: async () => "verified",
    events: [],
    requested: false,
    expected: "abort-reason",
  },
  {
    name: "unresolvable target",
    stage: () => captchaStage({ targets: [{ ...captchaStage().targets[0]!, locator: unresolvable }] }),
    host: async () => "verified",
    events: [FAILED],
    requested: false,
    expected: "incomplete",
  },
  {
    name: "unresolvable context region",
    stage: () => captchaStage({ contextRegions: [{ ...captchaStage().contextRegions[0]!, locator: unresolvable }] }),
    host: async () => "verified",
    events: [FAILED],
    requested: false,
    expected: "incomplete",
  },
];

for (const row of rows) {
  test(`a Verification stage that ends with ${row.name} reports its own events`, { timeout: 2_000 }, async () => {
    const controller = new AbortController();
    const reason = new Error("run cancelled");
    const abort = () => controller.abort(reason);
    const events: object[] = [];
    const requests: Array<{ contract: HumanAssistanceContractInput; signal: AbortSignal }> = [];
    const port = reportedVerificationPort({
      humanAssistance: {
        request: (contract, signal) => {
          requests.push({ contract, signal });
          return row.host(signal, abort);
        },
      },
      signal: controller.signal,
      event: async (stage, outcome, code) => { events.push({ stage, outcome, code, signal: undefined }); },
      signalEvent: async (signal) => {
        const { stage, outcome, code } = signalRunEvent(signal, { runId: "run-1", occurredAt: "2026-10-24T00:00:00.000Z" });
        events.push({ stage, outcome, code, signal });
      },
    });
    if (row.abortBeforeStart) abort();

    const settled = await port.complete(row.stage?.(abort) ?? captchaStage()).then(
      () => ({ resolved: true as const }),
      (error: unknown) => ({ resolved: false as const, error }),
    );

    assert.deepEqual(events, row.events);
    assert.equal(requests.length, row.requested ? 1 : 0);
    if (row.requested) {
      assert.equal(requests[0]!.signal, controller.signal);
      assert.deepEqual(requests[0]!.contract.targets[0]?.rect, TARGET_BOX);
    }
    if (row.expected === "resolved") {
      assert.deepEqual(settled, { resolved: true });
    } else if (row.expected === "abort-reason") {
      assert.equal(settled.resolved ? undefined : settled.error, reason);
    } else {
      const error = settled.resolved ? undefined : settled.error;
      assert.ok(error instanceof VerificationStageIncompleteError, `rejected with ${String(error)}`);
      assert.equal(error.message, "The Verification stage did not complete.");
      assert.equal(error.cause, undefined);
    }
  });
}

test("a workflow assistance stage resolves to a contract that never carries the captured answer", async () => {
  const contract = await resolveVerificationStage({
      stageId: "yuanta-bank-captcha",
      title: "Complete the CAPTCHA",
      targets: [{
        id: "captcha-input",
        label: "CAPTCHA input",
        semanticId: "yuanta-bank.login.captcha-input",
        modes: ["click", "type"],
        locator: { boundingBox: async () => ({ x: 10, y: 20, width: 100, height: 24 }) },
      }],
      contextRegions: [{
        id: "captcha-challenge",
        label: "CAPTCHA challenge",
        semanticId: "yuanta-bank.login.captcha-challenge",
        locator: { boundingBox: async () => ({ x: 0, y: 0, width: 200, height: 80 }) },
      }],
      completion: { mode: "inline", targetIds: ["captcha-input"] },
      focus: { targetId: "captcha-input", contextRegionIds: ["captcha-challenge"], initialZoom: 1.15 },
    });
  assert.deepEqual(contract.targets[0]?.rect, { x: 10, y: 20, width: 100, height: 24 });
  assert.deepEqual(contract.contextRegions[0]?.rect, { x: 0, y: 0, width: 200, height: 80 });
  assert.equal(JSON.stringify(contract).includes("captcha-answer"), false);
});

test("assistance stages publish a declared challenge kind and solver image region", async () => {
  const contract = await resolveVerificationStage({
      stageId: "yuanta-bank-captcha",
      title: "Complete the CAPTCHA",
      targets: [{
        id: "captcha-input",
        label: "CAPTCHA input",
        semanticId: "yuanta-bank.login.captcha-input",
        modes: ["click", "type"],
        locator: { boundingBox: async () => ({ x: 10, y: 20, width: 100, height: 24 }) },
      }],
      contextRegions: [{
        id: "captcha-challenge",
        label: "CAPTCHA challenge",
        semanticId: "yuanta-bank.login.captcha-challenge",
        locator: { boundingBox: async () => ({ x: 0, y: 0, width: 200, height: 80 }) },
      }],
      completion: { mode: "inline", targetIds: ["captcha-input"] },
      focus: { targetId: "captcha-input", contextRegionIds: ["captcha-challenge"], initialZoom: 1.15 },
      challengeKind: "text-captcha",
      challengeImageRegion: {
        id: "captcha-image",
        label: "CAPTCHA image",
        semanticId: "yuanta-bank.login.captcha-image",
        locator: { boundingBox: async () => ({ x: 0, y: 0, width: 200, height: 80 }) },
      },
    });
  assert.equal(contract.challengeKind, "text-captcha");
  assert.deepEqual(contract.challengeImageRegion, {
    id: "captcha-image",
    label: "CAPTCHA image",
    semanticId: "yuanta-bank.login.captcha-image",
    rect: { x: 0, y: 0, width: 200, height: 80 },
  });
});

test("assistance stages omit an unresolvable solver image region", async () => {
  const contract = await resolveVerificationStage({
    stageId: "yuanta-bank-captcha",
    title: "Complete the CAPTCHA",
    targets: [{
      id: "captcha-input",
      label: "CAPTCHA input",
      semanticId: "yuanta-bank.login.captcha-input",
      modes: ["click", "type"],
      locator: { boundingBox: async () => ({ x: 10, y: 20, width: 100, height: 24 }) },
    }],
    contextRegions: [],
    completion: { mode: "inline", targetIds: ["captcha-input"] },
    focus: { targetId: "captcha-input", contextRegionIds: [] },
    challengeKind: "image-selection",
    challengeImageRegion: {
      id: "captcha-image",
      label: "CAPTCHA image",
      semanticId: "yuanta-bank.login.captcha-image",
      locator: { boundingBox: async () => null },
    },
  });
  assert.equal(contract.challengeKind, "image-selection");
  assert.equal(contract.challengeImageRegion, undefined);
});

test("an explicit no-op publisher ignores legacy file and file-descriptor settings", async () => {
  const directory = mkdtempSync(join(tmpdir(), "human-assistance-no-file-"));
  const outputPath = join(directory, "contract.jsonl");
  const previousPath = process.env.OCTOPUSBEAK_HUMAN_ASSISTANCE_PATH;
  const previousFd = process.env.OCTOPUSBEAK_HUMAN_ASSISTANCE_FD;
  process.env.OCTOPUSBEAK_HUMAN_ASSISTANCE_PATH = outputPath;
  process.env.OCTOPUSBEAK_HUMAN_ASSISTANCE_FD = "987654";
  try {
    const contract = await resolveVerificationStage({
      stageId: "typed-captcha",
      title: "Complete the CAPTCHA",
      targets: [{
        id: "captcha-input",
        label: "CAPTCHA input",
        semanticId: "captcha.input",
        modes: ["type"],
        locator: { boundingBox: async () => ({ x: 1, y: 2, width: 30, height: 12 }) },
      }],
      contextRegions: [],
      completion: { mode: "inline", targetIds: ["captcha-input"] },
      focus: { targetId: "captcha-input", contextRegionIds: [] },
    });
    assert.equal(contract.stageId, "typed-captcha");
    assert.equal(existsSync(outputPath), false);
  } finally {
    if (previousPath === undefined) delete process.env.OCTOPUSBEAK_HUMAN_ASSISTANCE_PATH;
    else process.env.OCTOPUSBEAK_HUMAN_ASSISTANCE_PATH = previousPath;
    if (previousFd === undefined) delete process.env.OCTOPUSBEAK_HUMAN_ASSISTANCE_FD;
    else process.env.OCTOPUSBEAK_HUMAN_ASSISTANCE_FD = previousFd;
    rmSync(directory, { recursive: true, force: true });
  }
});
