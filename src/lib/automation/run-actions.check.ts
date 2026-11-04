import assert from "node:assert/strict";
import test from "node:test";
import { get, writable } from "svelte/store";
import type { OnboardingWorkflowToken } from "../onboarding/controller.ts";
import { createRunActions, type RunActionsState, type RunTask } from "./run-actions.ts";

type Task = RunTask;

const task = (id: string, overrides: Partial<Task> = {}): Task => ({
  id, isActive: false, canRun: true, credentialGroupId: `${id}-group`, status: "queued", ...overrides,
});

const TOKEN = { token: "onboarding" } as unknown as OnboardingWorkflowToken;

/** A page state whose intents settle with what each test scripts, recording every call. */
function harness(options: Readonly<{
  pending?: readonly string[];
  run?: Readonly<{ runId: string | null; error: string | null }> | Promise<Readonly<{ runId: string | null; error: string | null }>> | null;
  runMany?: Readonly<{ errors: Record<string, string>; error: string | null }>;
  stops?: readonly (string | null)[];
  registering?: boolean;
}> = {}) {
  const log: string[] = [];
  const value = writable({ pendingTaskIds: new Set(options.pending ?? []) });
  const stops = [...(options.stops ?? [])];
  const stop = (label: string) => {
    log.push(label);
    return { taskIds: [], settled: Promise.resolve({ error: stops.shift() ?? null }) };
  };
  const state = {
    subscribe: value.subscribe,
    run: (taskId: string) => {
      log.push(`run ${taskId}`);
      return options.run === null ? null : { taskIds: [taskId], settled: Promise.resolve(options.run ?? { runId: "run-1", error: null }) };
    },
    runMany: (taskIds: readonly string[]) => {
      log.push(`runMany ${taskIds.join(",")}`);
      return { taskIds, settled: Promise.resolve(options.runMany ?? { errors: {}, error: null }) };
    },
    cancel: (target: Task) => stop(`cancel ${target.id}`),
    forceTerminate: (taskId: string) => stop(`forceTerminate ${taskId}`),
    cancelAll: (tasks: readonly Task[]) => tasks.map((target) => stop(`cancel ${target.id}`)),
    reload: async () => { log.push("reload"); },
  } as unknown as RunActionsState;
  const actions = createRunActions({
    state,
    onboarding: {
      starting: (taskId, groupId) => { log.push(`onboarding.starting ${taskId} ${groupId}`); return TOKEN; },
      started: (token, run) => log.push(`onboarding.started ${token === TOKEN} ${run.taskId} ${run.runId}`),
      startFailed: (token, message) => log.push(`onboarding.startFailed ${token === TOKEN} ${message}`),
    },
    registering: () => options.registering ?? false,
    messages: {
      registrationBlocksSync: () => "Finish the device registration first.",
      taskLabel: (target) => `Label(${target.id})`,
    },
  });
  return { actions, log, error: () => get(actions.actionError) };
}

test("a task that is pending, running or not runnable does not start", async () => {
  for (const [name, setup, target] of [
    ["pending", { pending: ["a"] }, task("a")],
    ["running", {}, task("a", { isActive: true })],
    ["not runnable", {}, task("a", { canRun: false })],
  ] as const) {
    const { actions, log } = harness(setup);
    await actions.runTask(target);
    assert.deepEqual(log, [], name);
  }
});

test("a task whose source is registering a device does not start and says why", async () => {
  const { actions, log, error } = harness({ registering: true });
  await actions.runTask(task("a"));
  assert.deepEqual(log, []);
  assert.equal(error(), "Finish the device registration first.");

  const pending = harness({ registering: true, pending: ["a"] });
  await pending.actions.runTask(task("a"));
  assert.equal(pending.error(), "", "a task already starting is skipped before the registration message");
});

test("onboarding hears of a start before the host answers", async () => {
  let answer!: (value: Readonly<{ runId: string | null; error: string | null }>) => void;
  const { actions, log } = harness({ run: new Promise((resolve) => { answer = resolve; }) });
  const running = actions.runTask(task("a"));
  await Promise.resolve();
  assert.deepEqual(log, ["run a", "onboarding.starting a a-group"]);
  answer({ runId: "run-2", error: null });
  await running;
  assert.deepEqual(log.slice(2), ["onboarding.started true a run-2", "reload"]);
});

test("a started task tells onboarding before and after the start, then reloads", async () => {
  const { actions, log, error } = harness({ run: { runId: "run-7", error: null } });
  actions.setError("an earlier failure");
  await actions.runTask(task("a"));
  assert.deepEqual(log, [
    "run a",
    "onboarding.starting a a-group",
    "onboarding.started true a run-7",
    "reload",
  ]);
  assert.equal(error(), "", "a start clears the earlier failure");
});

test("a refused start tells onboarding with the host's reason and shows the person's message, without a reload", async () => {
  const { actions, log, error } = harness({ run: { runId: null, error: "Device registration is in progress for cathay" } });
  await actions.runTask(task("a"));
  assert.deepEqual(log, [
    "run a",
    "onboarding.starting a a-group",
    "onboarding.startFailed true Device registration is in progress for cathay",
  ]);
  assert.equal(error(), "Finish the device registration first.");
});

test("a start the page state does not begin tells onboarding nothing", async () => {
  const { actions, log } = harness({ run: null });
  await actions.runTask(task("a"));
  assert.deepEqual(log, ["run a"]);
});

test("a batch names each refused task and still reloads; a failed batch shows its one error", async () => {
  const refused = harness({ runMany: { errors: { b: "busy", c: "Device registration is in progress" }, error: null } });
  await refused.actions.runAll([task("a"), task("b"), task("c")]);
  assert.deepEqual(refused.log, ["runMany a,b,c", "reload"]);
  assert.equal(refused.error(), "Label(b): busy\nLabel(c): Finish the device registration first.");

  const failed = harness({ runMany: { errors: {}, error: "runtime unavailable" } });
  await failed.actions.runAll([task("a")]);
  assert.deepEqual(failed.log, ["runMany a"]);
  assert.equal(failed.error(), "runtime unavailable");

  const empty = harness();
  await empty.actions.runAll([]);
  assert.deepEqual(empty.log, []);
});

test("stopping every task clears an earlier failure when all stop", async () => {
  const { actions, error } = harness({ stops: [null, null] });
  actions.setError("an earlier failure");
  await actions.stopAll([task("a"), task("b")]);
  assert.equal(error(), "");
});

test("stopping every task joins the failures and reloads", async () => {
  const { actions, log, error } = harness({ stops: [null, "already finished", "timed out"] });
  await actions.stopAll([task("a"), task("b"), task("c")]);
  assert.deepEqual(log, ["cancel a", "cancel b", "cancel c", "reload"]);
  assert.equal(error(), "already finished\ntimed out");
});

test("a stop that fails shows its error; one that succeeds reloads", async () => {
  const failed = harness({ stops: ["not running"] });
  await failed.actions.cancel(task("a"));
  assert.deepEqual(failed.log, ["cancel a"]);
  assert.equal(failed.error(), "not running");

  const stopped = harness({ stops: [null] });
  stopped.actions.setError("an earlier failure");
  await stopped.actions.forceTerminate(task("a"));
  assert.deepEqual(stopped.log, ["forceTerminate a", "reload"]);
  assert.equal(stopped.error(), "");
});
