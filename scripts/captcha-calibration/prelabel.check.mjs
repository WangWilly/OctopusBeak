import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { CALIBRATION_BANK_SPECS } from "./banks.ts";
import { prelabelCorpus, suggestAnswer } from "./prelabel.ts";
import { STRATEGY_GRID } from "./strategies.ts";
import { temporaryCorpus } from "./check-fixtures.mjs";

function fakeEngine() {
  const calls = [];
  return {
    calls,
    async recognize(_image, charset, preprocessing, psm) {
      calls.push(`${charset}|${preprocessing?.[0] ?? "none"}|${psm}`);
      if (psm === "raw-line") return { text: "", confidence: 0.4 };
      if (preprocessing?.[0] === "mask-bottom-interference-band") return { text: "99999", confidence: 0.99 };
      return { text: "12 345", confidence: 0.6 };
    },
  };
}

test("prelabel records every grid strategy and keeps confirmed labels", async () => {
  const confirmed = { answer: "54321", at: "2026-10-01T00:00:00.000Z" };
  const directory = await temporaryCorpus(["one", "two"], {
    version: 1,
    bank: "mega",
    entries: { one: { suggested: { at: "old", answer: "00000", candidates: [], agreementCount: 0 }, confirmed } },
  });
  const engine = fakeEngine();
  const run = () => prelabelCorpus({ corpusDirectory: directory, bank: CALIBRATION_BANK_SPECS.mega, engine, now: () => "2026-10-15T00:00:00.000Z" });

  assert.deepEqual(await run(), { labelled: 2 });
  await run();

  assert.equal(STRATEGY_GRID.length, 18);
  assert.equal(new Set(engine.calls).size, 18, "each grid strategy reaches the engine");
  assert.equal(engine.calls.length, 18 * 2 * 2);
  assert.ok(engine.calls.every((call) => call.startsWith("digits|")));
  const labels = JSON.parse(await readFile(join(directory, "labels.json"), "utf8"));
  assert.deepEqual(labels.entries.one.confirmed, confirmed);
  assert.equal(labels.entries.two.confirmed, undefined);
  for (const id of ["one", "two"]) {
    const { suggested } = labels.entries[id];
    assert.equal(suggested.at, "2026-10-15T00:00:00.000Z");
    assert.deepEqual(suggested.candidates.map(({ strategy }) => strategy), STRATEGY_GRID.map(({ label }) => label));
    assert.deepEqual(suggested.candidates.find(({ strategy }) => strategy === "pre=none|psm=raw-line"), { strategy: "pre=none|psm=raw-line", answer: "", confidence: 0 });
    assert.deepEqual(suggested.candidates.find(({ strategy }) => strategy === "pre=mask-bottom-interference-band|psm=single-word"), { strategy: "pre=mask-bottom-interference-band|psm=single-word", answer: "99999", confidence: 0.99 });
    assert.equal(suggested.answer, "12345");
    assert.equal(suggested.agreementCount, 10);
  }
});

test("the suggested answer is the most agreed one, ties broken by confidence", () => {
  const candidate = (strategy, answer, confidence) => ({ strategy, answer, confidence });
  assert.deepEqual(suggestAnswer([candidate("a", "11", 0.9), candidate("b", "22", 0.5), candidate("c", "22", 0.4)]), { answer: "22", agreementCount: 2 });
  assert.deepEqual(suggestAnswer([candidate("a", "11", 0.5), candidate("b", "22", 0.9)]), { answer: "22", agreementCount: 1 });
  assert.deepEqual(suggestAnswer([candidate("a", "", 0)]), { answer: "", agreementCount: 0 });
});
