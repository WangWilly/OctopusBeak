import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import {
  CorpusLocationError,
  REPOSITORY_ROOT,
  defaultCorpusDirectory,
  readCaptures,
  resolveCorpusDirectory,
  updateLabels,
  withConfirmation,
  withSuggestion,
} from "./corpus.ts";
import { temporaryCorpus } from "./check-fixtures.mjs";

test("the default corpus lives under the home directory, outside the repository", async () => {
  assert.equal(defaultCorpusDirectory("mega"), join(homedir(), "OctopusBeakCalibration", "mega"));
  const resolved = await resolveCorpusDirectory("mega", undefined);
  assert.ok(relative(REPOSITORY_ROOT, resolved).startsWith(".."), `${resolved} is outside the repository`);
});

test("a corpus inside the repository is refused, including through a symlink", async () => {
  await assert.rejects(resolveCorpusDirectory("mega", join(REPOSITORY_ROOT, "corpus")), CorpusLocationError);
  await assert.rejects(resolveCorpusDirectory("mega", REPOSITORY_ROOT), CorpusLocationError);
  const outside = await mkdtemp(join(tmpdir(), "captcha-calibration-link-"));
  await symlink(REPOSITORY_ROOT, join(outside, "repo"));
  await assert.rejects(resolveCorpusDirectory("mega", join(outside, "repo", "not-yet", "corpus")), CorpusLocationError);
  assert.match(await resolveCorpusDirectory("mega", join(outside, "corpus")), /captcha-calibration-link-.+\/corpus$/u);
});

test("captures append one metadata line and one PNG each", async () => {
  const directory = await temporaryCorpus(["a", "b"]);
  assert.deepEqual((await readCaptures(directory)).map(({ id, file }) => [id, file]), [["a", "images/a.png"], ["b", "images/b.png"]]);
  assert.deepEqual((await readdir(join(directory, "images"))).sort(), ["a.png", "b.png"]);
});

test("a new suggestion keeps the human confirmation, and labels.json is replaced whole", async () => {
  const directory = await temporaryCorpus(["a"]);
  const suggestion = (answer) => ({ at: "t", answer, candidates: [], agreementCount: 0 });
  await updateLabels(directory, "mega", (entries) => withSuggestion(entries, "a", suggestion("11111")));
  await updateLabels(directory, "mega", (entries) => withConfirmation(entries, "a", { answer: "22222", at: "t2" }));
  await updateLabels(directory, "mega", (entries) => withSuggestion(entries, "a", suggestion("33333")));
  const labels = JSON.parse(await readFile(join(directory, "labels.json"), "utf8"));
  assert.deepEqual(labels.entries.a, { suggested: suggestion("33333"), confirmed: { answer: "22222", at: "t2" } });
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
  await assert.rejects(updateLabels(directory, "taishin", (entries) => entries), /belongs to mega/u);
});
