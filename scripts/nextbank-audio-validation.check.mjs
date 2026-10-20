import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendAudioCapture,
  parseAudioValidationArguments,
  readAudioCaptures,
  reRecognizeCorpus,
  resolveAudioCorpusDirectory,
  startAudioLabelServer,
  transcribeClip,
} from "./nextbank-audio-validation.ts";

function engineReturning(text) {
  return { async transcribe() { return { text }; } };
}

test("collect needs --allow-live-source and keeps the count and delay within the limits", () => {
  assert.equal(parseAudioValidationArguments([]).kind, "help");
  assert.equal(parseAudioValidationArguments(["--count", "5"]).kind, "usage-error");
  assert.equal(parseAudioValidationArguments(["--count", "5", "--allow-live-source", "--delay-ms", "1999"]).kind, "usage-error");
  assert.equal(parseAudioValidationArguments(["--count", "201", "--allow-live-source"]).kind, "usage-error");
  assert.equal(parseAudioValidationArguments(["--bogus"]).kind, "usage-error");
  assert.deepEqual(parseAudioValidationArguments(["--allow-live-source"]), {
    kind: "validate", count: 10, delayMs: 3000, headless: false, reRecognize: false,
  });
  assert.deepEqual(parseAudioValidationArguments(["--count", "0"]), {
    kind: "validate", count: 0, delayMs: 3000, headless: false, reRecognize: false,
  }, "a zero count serves the existing corpus without contacting the bank");
  assert.deepEqual(parseAudioValidationArguments(["--count", "20", "--delay-ms", "2500", "--headless", "--corpus", "/tmp/x", "--allow-live-source"]), {
    kind: "validate", corpus: "/tmp/x", count: 20, delayMs: 2500, headless: true, reRecognize: false,
  });
  assert.deepEqual(parseAudioValidationArguments(["--re-recognize"]), {
    kind: "validate", count: 10, delayMs: 3000, headless: false, reRecognize: true,
  }, "re-recognize needs no --allow-live-source: it reads the local corpus only");
});

test("the corpus directory resolves outside the repository and refuses an in-repo path", async () => {
  const outside = await mkdtemp(join(tmpdir(), "nextbank-audio-corpus-"));
  try {
    assert.equal(await resolveAudioCorpusDirectory(outside), await realpath(outside));
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
  await assert.rejects(resolveAudioCorpusDirectory(new URL(".", import.meta.url).pathname), /must stay outside the repo/u);
});

test("one clip transcribes to its digit and tolerates a failed decode", async () => {
  assert.deepEqual(await transcribeClip(engineReturning("開始 播放 一"), Buffer.from("clip")), {
    transcription: "開始 播放 一",
    recognized: "1",
  });
  assert.deepEqual(await transcribeClip(engineReturning("嗯"), Buffer.from("clip")), {
    transcription: "嗯",
    recognized: "2",
  }, "the digit 二 misheard as 嗯 is recovered");
  assert.deepEqual(await transcribeClip(engineReturning(""), Buffer.from("clip")), { transcription: "", recognized: "" });
  assert.deepEqual(await transcribeClip({ async transcribe() { throw new Error("not mpeg"); } }, Buffer.from("clip")), {
    transcription: "", recognized: "",
  }, "a clip the recogniser cannot decode is kept and shown with no digits");
});

test("an audio capture round-trips its clips through captures.jsonl", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nextbank-audio-roundtrip-"));
  try {
    await appendAudioCapture(dir, {
      id: "capture-1",
      capturedAt: "2026-10-19T00:00:00.000Z",
      transcriptions: ["一", "二", "三", "四", "五"],
      recognized: "12345",
    }, [Buffer.from("c1"), Buffer.from("c2"), Buffer.from("c3"), Buffer.from("c4"), Buffer.from("c5")]);
    const captures = await readAudioCaptures(dir);
    assert.equal(captures.length, 1);
    assert.deepEqual(captures[0], {
      id: "capture-1",
      capturedAt: "2026-10-19T00:00:00.000Z",
      transcriptions: ["一", "二", "三", "四", "五"],
      recognized: "12345",
      files: ["audio/capture-1/0.bin", "audio/capture-1/1.bin", "audio/capture-1/2.bin", "audio/capture-1/3.bin", "audio/capture-1/4.bin"],
      mediaTypes: ["application/octet-stream", "application/octet-stream", "application/octet-stream", "application/octet-stream", "application/octet-stream"],
    });
    assert.deepEqual(await readFile(join(dir, "audio", "capture-1", "0.bin")), Buffer.from("c1"));
    assert.deepEqual(await readFile(join(dir, "audio", "capture-1", "4.bin")), Buffer.from("c5"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("re-recognize refreshes the transcriptions and recognized in place and keeps the clips", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nextbank-audio-re-"));
  try {
    await appendAudioCapture(dir, {
      id: "capture-1",
      capturedAt: "2026-10-19T00:00:00.000Z",
      transcriptions: ["八", "嗯", "四", "八", "九"],
      recognized: "8489",
    }, [Buffer.from("c1"), Buffer.from("c2"), Buffer.from("c3"), Buffer.from("c4"), Buffer.from("c5")]);
    const engine = {
      async transcribe(clip) {
        return { text: { c1: "八", c2: "二", c3: "四", c4: "八", c5: "九" }[clip.toString()] ?? "" };
      },
    };
    assert.equal(await reRecognizeCorpus(dir, engine), 1);
    const [record] = await readAudioCaptures(dir);
    assert.deepEqual(record.transcriptions, ["八", "二", "四", "八", "九"]);
    assert.equal(record.recognized, "82489");
    assert.deepEqual(await readFile(join(dir, "audio", "capture-1", "1.bin")), Buffer.from("c2"), "the clip bytes are unchanged");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the label server serves the page, the clips, and records confirmations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nextbank-audio-server-"));
  const server = await startAudioLabelServer({ corpusDirectory: dir });
  try {
    await appendAudioCapture(dir, {
      id: "capture-1",
      capturedAt: "2026-10-19T00:00:00.000Z",
      transcriptions: ["一", "二", "三", "四", "五"],
      recognized: "12345",
    }, [Buffer.from("c1"), Buffer.from("c2"), Buffer.from("c3"), Buffer.from("c4"), Buffer.from("c5")]);

    const page = await (await fetch(server.url)).text();
    assert.match(page, /Next Bank audio CAPTCHA validation/u);

    const state = await (await fetch(`${server.url}api/state`)).json();
    assert.equal(state.bank.answerLength, 5);
    assert.equal(state.progress.total, 1);
    assert.deepEqual(state.captures[0], {
      id: "capture-1",
      transcriptions: ["一", "二", "三", "四", "五"],
      recognized: "12345",
      digits: ["1", "2", "3", "4", "5"],
    });

    const clip = await fetch(`${server.url}audio/capture-1/2.bin`);
    assert.equal(clip.status, 200);
    assert.deepEqual(Buffer.from(await clip.arrayBuffer()), Buffer.from("c3"));
    assert.equal((await fetch(`${server.url}audio/capture-1/9.bin`)).status, 404, "an out-of-range clip is not served");

    const labelled = await fetch(`${server.url}api/label`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "capture-1", answer: "12a34" }),
    });
    assert.equal(labelled.status, 200);
    const confirmation = (await labelled.json()).confirmed;
    assert.equal(confirmation.answer, "1234", "the answer is normalized to digits");
    assert.equal(typeof confirmation.at, "string");

    const labels = JSON.parse(await readFile(join(dir, "labels.json"), "utf8"));
    assert.equal(labels.bank, "nextbank-audio");
    assert.equal(labels.entries["capture-1"].confirmed.answer, "1234");
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
