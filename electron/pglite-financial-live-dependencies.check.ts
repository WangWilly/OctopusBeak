import assert from "node:assert/strict";
import test from "node:test";
import { createLocalDateClock, type LiveViewDependencySignals } from "./pglite-financial-live-dependencies.ts";

function recorder() {
  const seen = { changed: 0, failed: [] as unknown[] };
  const signals: LiveViewDependencySignals = {
    changed: () => { seen.changed += 1; },
    failed: (error) => { seen.failed.push(error); },
  };
  return { seen, signals };
}

test("the clock reports a date change once to every watcher, and nothing within the same date", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let date = "2026-11-01";
  const clock = createLocalDateClock(() => date, 60_000);
  const first = recorder();
  const second = recorder();
  const stops = [await clock.watch(first.signals), await clock.watch(second.signals)];
  t.mock.timers.tick(60_000);
  assert.deepEqual([first.seen.changed, second.seen.changed], [0, 0], "a minute on the same date reports nothing");
  date = "2026-11-02";
  t.mock.timers.tick(60_000);
  t.mock.timers.tick(60_000);
  assert.deepEqual([first.seen.changed, second.seen.changed], [1, 1]);
  await Promise.all(stops.map((stop) => stop()));
  date = "2026-11-03";
  t.mock.timers.tick(60_000);
  assert.deepEqual([first.seen.changed, second.seen.changed], [1, 1], "an unwatched clock stops polling");
});

test("a failed date read reaches the watchers, and the next good read still reports the move", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let date: string | Error = "2026-11-01";
  const clock = createLocalDateClock(() => {
    if (date instanceof Error) throw date;
    return date;
  }, 60_000);
  const watcher = recorder();
  const stop = await clock.watch(watcher.signals);
  try {
    const failure = new Error("settings unreadable");
    date = failure;
    t.mock.timers.tick(60_000);
    assert.deepEqual(watcher.seen.failed, [failure]);
    date = "2026-11-02";
    t.mock.timers.tick(60_000);
    assert.equal(watcher.seen.changed, 1, "the date moved from the last good read");
  } finally {
    await stop();
  }
});
