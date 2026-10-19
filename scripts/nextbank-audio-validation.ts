import { randomBytes, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { stderr, stdout } from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { recoverDigits, type SpeechRecognitionEngine } from "../src/lib/automation/server/audio-captcha-solver.ts";
import { createSherpaOnnxSpeechRecognitionEngine } from "../src/lib/automation/server/speech-recognition.ts";
import { strictSourceText } from "../src/lib/automation/source-text.ts";
import type { WorkflowBrowserPort } from "../src/lib/automation/workflow-executor.ts";
import { createNextBankSource } from "../src/lib/preview-sources/nextbank-source.ts";
import { PreviewSourceFailure, type PreviewCaptchaSolver } from "../src/lib/preview-sources/source-kit.ts";
import type { PreviewWorkflowContext } from "../src/lib/preview-sources/workflow.ts";
import { DeniedRequestError, guardedBrowser, type DeniedRequest } from "./captcha-calibration/collect.ts";
import type { DenyRule } from "./captcha-calibration/banks.ts";
import { createDevelopmentBrowserPort } from "./workflow-dev.ts";

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_CORPUS = join("OctopusBeakCalibration", "nextbank-audio");
const DEFAULT_COUNT = 10;
const MAX_COUNT = 200;
const DEFAULT_DELAY_MS = 3000;
const MIN_DELAY_MS = 2000;
const MAX_CONSECUTIVE_FAILURES = 3;
const ANSWER_LENGTH = 5;

// NextBank's CAPTCHA endpoint answers `isAudio: true` with `captchaAudio`, a
// list of base64 clips, one spoken digit each. The production source stops at
// the CAPTCHA solver, so a solver that records and throws captures the clips
// before any sign-in request. The login path is also blocked as a second guard.
const DENY_RULES: readonly DenyRule[] = [
  { name: "nextbank-login", path: /\/membership\/CaptchaLogin$/u },
];

const CAPTURES_FILE = "captures.jsonl";
const LABELS_FILE = "labels.json";

type AudioCaptureRecord = Readonly<{
  id: string;
  capturedAt: string;
  /** Raw per-clip transcription, one entry per spoken digit. */
  transcriptions: readonly string[];
  /** The concatenated per-clip digits. */
  recognized: string;
  /** Per-clip audio files, relative to the corpus directory. */
  files: readonly string[];
  /** Per-clip media type, sniffed when the clip was captured. */
  mediaTypes: readonly string[];
}>;

type AudioConfirmation =
  | Readonly<{ answer: string; at: string }>
  | Readonly<{ unreadable: true; at: string }>;

type AudioLabels = Readonly<{
  version: 1;
  bank: "nextbank-audio";
  entries: Readonly<Record<string, Readonly<{ confirmed?: AudioConfirmation }>>>;
}>;

type CollectOptions = Readonly<{
  count: number;
  delayMs: number;
  corpusDirectory: string;
  browser: WorkflowBrowserPort;
  engine: SpeechRecognitionEngine;
  signal: AbortSignal;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => string;
  log?: (line: string) => void;
}>;

type CollectResult = Readonly<{ captured: number; failed: number }>;

type Arguments =
  | Readonly<{ kind: "help" }>
  | Readonly<{ kind: "usage-error"; message: string }>
  | Readonly<{ kind: "validate"; corpus?: string; count: number; delayMs: number; headless: boolean; reRecognize: boolean }>;

const USAGE = [
  "Next Bank audio CAPTCHA validation (development only). Collects the spoken CAPTCHA clips,",
  "transcribes them with the local speech recogniser, and serves a page to confirm the digits.",
  "",
  "  npm run validate:nextbank-audio -- [--count N] [--delay-ms D] [--corpus DIR] [--headless] [--re-recognize] --allow-live-source",
  "",
  `--count defaults to ${DEFAULT_COUNT} (at most ${MAX_COUNT}); --count 0 serves the existing corpus without collecting.`,
  `--delay-ms defaults to ${DEFAULT_DELAY_MS} (at least ${MIN_DELAY_MS}).`,
  "--re-recognize re-transcribes the existing clips with the current recogniser and then serves them.",
  `The corpus defaults to ~/${DEFAULT_CORPUS} and must stay outside the repository.`,
  "You listen to each clip and confirm the recognised digits yourself. No agent labels or solves a CAPTCHA.",
].join("\n");

function integer(value: string): number | null {
  return /^\d+$/u.test(value) ? Number(value) : null;
}

export function parseAudioValidationArguments(args: readonly string[]): Arguments {
  const error = (message: string) => ({ kind: "usage-error", message }) as const;
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) return { kind: "help" };
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === "--headless" || flag === "--allow-live-source" || flag === "--re-recognize") switches.add(flag);
    else if (flag === "--count" || flag === "--delay-ms" || flag === "--corpus") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) return error(`${flag} needs a value.`);
      values.set(flag, value);
      index += 1;
    } else return error(`Unknown option: ${flag}`);
  }
  const count = integer(values.get("--count") ?? String(DEFAULT_COUNT));
  if (count === null || count > MAX_COUNT) return error(`--count must be an integer from 0 to ${MAX_COUNT}.`);
  const delayMs = integer(values.get("--delay-ms") ?? String(DEFAULT_DELAY_MS));
  if (delayMs === null || delayMs < MIN_DELAY_MS) return error(`--delay-ms must be an integer of at least ${MIN_DELAY_MS}.`);
  const reRecognize = switches.has("--re-recognize");
  if (!reRecognize && count > 0 && !switches.has("--allow-live-source")) {
    return error("collecting contacts the bank's public login endpoints; pass --allow-live-source.");
  }
  const corpus = values.get("--corpus");
  return { kind: "validate", ...(corpus === undefined ? {} : { corpus }), count, delayMs, headless: switches.has("--headless"), reRecognize };
}

class AudioCorpusLocationError extends Error {
  constructor(directory: string) {
    super(`Refusing corpus directory inside the repository: ${directory}. CAPTCHA audio must stay outside the repo.`);
    this.name = "AudioCorpusLocationError";
  }
}

async function realLocation(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(await realLocation(parent), basename(absolute));
  }
}

function isInside(child: string, parent: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export async function resolveAudioCorpusDirectory(override: string | undefined): Promise<string> {
  const directory = await realLocation(override ?? join(homedir(), DEFAULT_CORPUS));
  const repository = await realLocation(REPOSITORY_ROOT);
  if (isInside(directory, repository)) throw new AudioCorpusLocationError(directory);
  return directory;
}

export async function transcribeClip(engine: SpeechRecognitionEngine, clip: Buffer): Promise<Readonly<{ transcription: string; recognized: string }>> {
  try {
    const { text } = await engine.transcribe(clip);
    return { transcription: text, recognized: recoverDigits(text) };
  } catch {
    // A clip the recogniser cannot decode is kept and shown with no digits, so
    // the person hears it and can judge whether the format assumption is wrong.
    return { transcription: "", recognized: "" };
  }
}

class AudioChallengeCaptured extends Error {
  readonly clips: readonly Buffer[];
  readonly transcriptions: readonly string[];
  readonly recognized: string;

  constructor(clips: readonly Buffer[], transcriptions: readonly string[], recognized: string) {
    super("NextBank audio CAPTCHA captured; the validation run stops before sign-in.");
    this.name = "AudioChallengeCaptured";
    this.clips = clips;
    this.transcriptions = transcriptions;
    this.recognized = recognized;
  }
}

function recordingSolver(engine: SpeechRecognitionEngine): PreviewCaptchaSolver {
  return async (_context, challenge) => {
    if (!("audio" in challenge)) throw new Error("NextBank source did not present an audio challenge.");
    const transcriptions: string[] = [];
    const digits: string[] = [];
    for (const clip of challenge.audio) {
      const result = await transcribeClip(engine, clip);
      transcriptions.push(result.transcription);
      digits.push(result.recognized);
    }
    throw new AudioChallengeCaptured(challenge.audio, transcriptions, digits.join(""));
  };
}

function validationContext(
  browser: WorkflowBrowserPort,
  signal: AbortSignal,
  observations: { endpoint: string; status: number; body: unknown }[] = [],
): PreviewWorkflowContext {
  return {
    runId: `nextbank-audio-validation-${randomUUID()}`,
    signal,
    now: () => new Date().toISOString(),
    browser,
    text: strictSourceText,
    humanAssistance: { request: async () => { throw new Error("NextBank audio validation has no verification route."); } },
    event: async () => {},
    preview: {
      collect: async () => { throw new Error("NextBank audio validation never collects preview data."); },
      observe: (response) => { observations.push(response); },
    },
  };
}

/** Field names and nested shapes only, never values, so a failure can be read without exposing a challenge. */
function shapeOf(value: unknown): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) return { length: value.length, first: value.length === 0 ? null : shapeOf(value[0]) };
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, shapeOf(entry)]));
  }
  if (typeof value === "string") return `string(${value.length})`;
  return typeof value;
}

function failureClass(error: unknown): string {
  if (error instanceof PreviewSourceFailure) return `${error.name}(${error.reason}): ${error.message.slice(error.name.length + 2)}`;
  return error instanceof Error ? `${error.name}: ${error.message}` : typeof error;
}

function sniffAudioMime(bytes: Buffer): string {
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return "audio/mpeg";
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return "audio/mpeg";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WAVE") return "audio/wav";
  if (bytes.length >= 4 && bytes.toString("latin1", 0, 4) === "OggS") return "audio/ogg";
  return "application/octet-stream";
}

export async function collectAudioCaptchas(options: CollectOptions): Promise<CollectResult> {
  const { count, signal } = options;
  const sleep = options.sleep ?? ((ms, abort) => delay(ms, undefined, { signal: abort }));
  const now = options.now ?? (() => new Date().toISOString());
  const log = options.log ?? (() => {});
  const denials: DeniedRequest[] = [];
  const browser = guardedBrowser(options.browser, DENY_RULES, (request) => { denials.push(request); });
  const source = createNextBankSource({ solveCaptcha: recordingSolver(options.engine) });
  let captured = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  for (let index = 0; index < count; index += 1) {
    if (index > 0) await sleep(options.delayMs, signal);
    signal.throwIfAborted();
    const observations: { endpoint: string; status: number; body: unknown }[] = [];
    let failure: unknown = null;
    try {
      await source.run(validationContext(browser, signal, observations), { startUrl: source.startUrl, credentials: {}, products: [] });
      throw new Error("NextBank source finished without presenting an audio CAPTCHA.");
    } catch (error) {
      if (error instanceof AudioChallengeCaptured) {
        if (denials[0]) throw new DeniedRequestError(denials[0]);
        const id = randomUUID();
        await appendAudioCapture(options.corpusDirectory, {
          id,
          capturedAt: now(),
          transcriptions: error.transcriptions,
          recognized: error.recognized,
        }, error.clips);
        captured += 1;
        consecutiveFailures = 0;
        log(`capture ${index + 1}/${count} ${id} recognised="${error.recognized}"`);
      } else if (signal.aborted) {
        throw error;
      } else {
        failure = error;
      }
    }
    if (denials[0]) throw new DeniedRequestError(denials[0]);
    if (failure === null) continue;
    failed += 1;
    consecutiveFailures += 1;
    log(`capture ${index + 1}/${count} failed: ${failureClass(failure)}`);
    const last = observations[observations.length - 1];
    if (last) log(`  last response ${last.endpoint} HTTP ${last.status} shape=${JSON.stringify(shapeOf(last.body))}`);
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      log(`stopping after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`);
      break;
    }
  }
  return { captured, failed };
}

export async function appendAudioCapture(
  corpusDirectory: string,
  capture: Omit<AudioCaptureRecord, "files" | "mediaTypes">,
  clips: readonly Buffer[],
): Promise<void> {
  const files = clips.map((_, index) => `audio/${capture.id}/${index}.bin`);
  const mediaTypes = clips.map((clip) => sniffAudioMime(clip));
  const record: AudioCaptureRecord = { ...capture, files, mediaTypes };
  await mkdir(join(corpusDirectory, "audio", capture.id), { recursive: true });
  for (let index = 0; index < clips.length; index += 1) {
    await writeFile(join(corpusDirectory, files[index]!), clips[index]!, { flag: "wx" });
  }
  await appendFile(join(corpusDirectory, CAPTURES_FILE), `${JSON.stringify(record)}\n`);
}

export async function readAudioCaptures(corpusDirectory: string): Promise<readonly AudioCaptureRecord[]> {
  let text: string;
  try {
    text = await readFile(join(corpusDirectory, CAPTURES_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as AudioCaptureRecord);
}

/**
 * Re-transcribe every stored clip with the current recogniser and rewrite
 * `captures.jsonl` in place. The clips themselves are unchanged; only the
 * per-clip transcriptions and the joined `recognized` are refreshed.
 */
export async function reRecognizeCorpus(
  corpusDirectory: string,
  engine: SpeechRecognitionEngine,
  log: (line: string) => void = () => {},
): Promise<number> {
  const captures = await readAudioCaptures(corpusDirectory);
  const updated: AudioCaptureRecord[] = [];
  for (const capture of captures) {
    const transcriptions: string[] = [];
    const digits: string[] = [];
    for (let index = 0; index < capture.files.length; index += 1) {
      const clip = await readFile(join(corpusDirectory, capture.files[index]!));
      const result = await transcribeClip(engine, clip);
      transcriptions.push(result.transcription);
      digits.push(result.recognized);
    }
    const next: AudioCaptureRecord = { ...capture, transcriptions, recognized: digits.join("") };
    log(`${capture.id} recognised="${next.recognized}" (was "${capture.recognized}")`);
    updated.push(next);
  }
  await writeFile(join(corpusDirectory, CAPTURES_FILE), `${updated.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return updated.length;
}

async function readAudioLabels(corpusDirectory: string): Promise<AudioLabels> {
  let text: string;
  try {
    text = await readFile(join(corpusDirectory, LABELS_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, bank: "nextbank-audio", entries: {} };
    throw error;
  }
  const labels = JSON.parse(text) as AudioLabels;
  if (labels.version !== 1 || labels.bank !== "nextbank-audio") throw new Error("Unsupported labels.json for the NextBank audio corpus.");
  return labels;
}

const HOST = "127.0.0.1";
const MAX_BODY_BYTES = 4096;

type AudioLabelRequest = Readonly<{ id: string; answer: string }> | Readonly<{ id: string; unreadable: true }>;

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function parseAudioLabelRequest(value: unknown): AudioLabelRequest {
  if (!value || typeof value !== "object") throw new HttpError(400, "Expected a JSON object.");
  const { id, answer, unreadable } = value as Record<string, unknown>;
  if (typeof id !== "string") throw new HttpError(400, "id must be a string.");
  if (unreadable === true) return { id, unreadable: true };
  if (typeof answer !== "string") throw new HttpError(400, "answer must be a string.");
  return { id, answer };
}

async function readBody(request: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Body too large.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(response: ServerResponse, status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}) {
  response.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...headers,
  });
  response.end(body);
}

const sendJson = (response: ServerResponse, status: number, body: unknown) =>
  send(response, status, "application/json; charset=utf-8", JSON.stringify(body));

export type AudioLabelServer = Readonly<{ url: string; close(): Promise<void> }>;

export async function startAudioLabelServer(options: Readonly<{ corpusDirectory: string }>): Promise<AudioLabelServer> {
  const { corpusDirectory } = options;
  let origin = "";

  async function captureById(id: string): Promise<AudioCaptureRecord | undefined> {
    return (await readAudioCaptures(corpusDirectory)).find((capture) => capture.id === id);
  }

  async function state() {
    const captures = await readAudioCaptures(corpusDirectory);
    const { entries } = await readAudioLabels(corpusDirectory);
    return {
      bank: { id: "nextbank-audio", displayName: "Next Bank", answerLength: ANSWER_LENGTH },
      captures: captures.map(({ id, transcriptions, recognized }) => ({
        id,
        transcriptions,
        recognized,
        digits: transcriptions.map((transcription) => recoverDigits(transcription)),
      })),
      entries,
      progress: { confirmed: captures.filter(({ id }) => entries[id]?.confirmed).length, total: captures.length },
    };
  }

  async function label(request: IncomingMessage) {
    if (!/^application\/json\b/u.test(request.headers["content-type"] ?? "")) throw new HttpError(415, "Expected application/json.");
    if (request.headers.origin !== undefined && request.headers.origin !== origin) throw new HttpError(403, "Foreign origin.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(request));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "Invalid JSON.");
    }
    const body = parseAudioLabelRequest(parsed);
    if (!await captureById(body.id)) throw new HttpError(404, "Unknown capture.");
    const at = new Date().toISOString();
    const labels = await readAudioLabels(corpusDirectory);
    const confirmation: AudioConfirmation = "unreadable" in body
      ? { unreadable: true, at }
      : { answer: body.answer.replace(/[^0-9]/gu, ""), at };
    const updated: AudioLabels = {
      ...labels,
      entries: { ...labels.entries, [body.id]: { ...labels.entries[body.id], confirmed: confirmation } },
    };
    await writeFile(join(corpusDirectory, LABELS_FILE), `${JSON.stringify(updated, null, 2)}\n`);
    return updated.entries[body.id];
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (request.headers.host !== new URL(origin).host) throw new HttpError(403, "Unexpected Host header.");
    const { pathname } = new URL(request.url ?? "/", origin);
    if (request.method === "GET" && pathname === "/") {
      const nonce = randomBytes(16).toString("base64");
      send(response, 200, "text/html; charset=utf-8", audioLabelPage(nonce), {
        "content-security-policy": `default-src 'self'; media-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
      return;
    }
    if (request.method === "GET" && pathname === "/api/state") {
      sendJson(response, 200, await state());
      return;
    }
    const clip = /^\/audio\/([^/]+)\/(\d+)\.bin$/u.exec(pathname);
    if (request.method === "GET" && clip) {
      const capture = await captureById(decodeURIComponent(clip[1]!));
      const index = Number(clip[2]);
      if (!capture || index < 0 || index >= capture.files.length) throw new HttpError(404, "Unknown clip.");
      send(response, 200, capture.mediaTypes[index]!, await readFile(join(corpusDirectory, capture.files[index]!)));
      return;
    }
    if (request.method === "POST" && pathname === "/api/label") {
      sendJson(response, 200, await label(request));
      return;
    }
    throw new HttpError(404, "Not found.");
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      sendJson(response, status, { error: error instanceof HttpError ? error.message : "Internal error." });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, () => resolve());
  });
  origin = `http://${HOST}:${(server.address() as AddressInfo).port}`;
  return {
    url: `${origin}/`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    }),
  };
}

function audioLabelPage(nonce: string): string {
  return `<!doctype html>
<html lang="zh-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Next Bank audio CAPTCHA validation</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0; padding: 24px; display: grid; gap: 16px; justify-items: start; max-width: 720px; }
  header { display: flex; gap: 24px; align-items: baseline; flex-wrap: wrap; }
  h1 { font-size: 18px; margin: 0; }
  #clips { display: grid; gap: 8px; }
  .clip { display: flex; gap: 12px; align-items: center; padding: 8px; background: #fff; border: 1px solid #8884; border-radius: 6px; }
  .clip .digit { font: 20px ui-monospace, monospace; min-width: 2ch; text-align: center; }
  .clip .transcript { color: #666; font-size: 90%; }
  #recognized { font: 22px ui-monospace, monospace; letter-spacing: 0.1em; }
  #answer { font: 32px ui-monospace, monospace; letter-spacing: 0.2em; width: 8ch; padding: 4px 8px; }
  .meta { color: #888; }
  .status-confirmed { color: #2a7d2a; }
  .status-unreadable { color: #b5651d; }
  nav { display: flex; gap: 8px; }
  kbd { border: 1px solid #8886; border-radius: 3px; padding: 0 4px; font-size: 90%; }
</style>
</head>
<body>
<header>
  <h1 id="title">Next Bank audio CAPTCHA validation</h1>
  <span id="progress"></span>
  <span id="position" class="meta"></span>
</header>
<div id="clips"></div>
<div id="recognized"></div>
<input id="answer" autocomplete="off" spellcheck="false" inputmode="numeric" aria-label="Digits">
<div id="status"></div>
<nav>
  <button id="previous" type="button">Previous</button>
  <button id="next" type="button">Next</button>
</nav>
<p class="meta">
  Listen to each clip, then confirm the digits. <kbd>Enter</kbd> saves the box as confirmed (type to correct it first).
  <kbd>Esc</kbd> marks the capture unreadable. <kbd>PageUp</kbd> / <kbd>PageDown</kbd>, or <kbd>&larr;</kbd> / <kbd>&rarr;</kbd> with an empty box, move between captures.
</p>
<script nonce="${nonce}">
"use strict";
let state = null;
let index = 0;
const $ = (id) => document.getElementById(id);

function entry(id) { return state.entries[id] || {}; }
function confirmedCount() { return state.captures.filter(({ id }) => entry(id).confirmed).length; }
function nextUnconfirmed(from) {
  const total = state.captures.length;
  for (let step = 1; step <= total; step += 1) {
    const candidate = (from + step) % total;
    if (!entry(state.captures[candidate].id).confirmed) return candidate;
  }
  return -1;
}

function render() {
  const total = state.captures.length;
  $("progress").textContent = confirmedCount() + " / " + total + " confirmed";
  if (total === 0) {
    $("status").textContent = "The corpus has no captures yet. Collect first with --allow-live-source.";
    $("answer").disabled = true;
    return;
  }
  const capture = state.captures[index];
  const { confirmed } = entry(capture.id);
  $("position").textContent = "Capture " + (index + 1) + " of " + total;
  const clips = $("clips");
  clips.replaceChildren(...capture.transcriptions.map((transcript, i) => {
    const row = document.createElement("div");
    row.className = "clip";
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "auto";
    audio.src = "/audio/" + encodeURIComponent(capture.id) + "/" + i + ".bin";
    const digit = document.createElement("span");
    digit.className = "digit";
    digit.textContent = capture.digits[i] || "?";
    const text = document.createElement("span");
    text.className = "transcript";
    text.textContent = transcript || "(no transcription)";
    row.append(audio, digit, text);
    return row;
  }));
  $("recognized").textContent = capture.recognized ? "Recognised: " + capture.recognized : "No digits recognised.";
  const status = $("status");
  status.className = confirmed ? (confirmed.unreadable ? "status-unreadable" : "status-confirmed") : "";
  status.textContent = confirmed ? (confirmed.unreadable ? "Marked unreadable" : "Confirmed " + confirmed.answer) : "Not confirmed";
  const input = $("answer");
  input.value = confirmed && !confirmed.unreadable ? confirmed.answer : capture.recognized;
  input.disabled = false;
  input.focus();
  input.select();
}

function move(offset) {
  const total = state.captures.length;
  if (total === 0) return;
  index = (index + offset + total) % total;
  render();
}

async function save(body) {
  const id = state.captures[index].id;
  const response = await fetch("/api/label", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, ...body }),
  });
  const result = await response.json();
  if (!response.ok) {
    $("status").textContent = result.error;
    return;
  }
  state.entries[id] = result;
  const next = nextUnconfirmed(index);
  if (next === -1) {
    render();
    $("status").textContent = "All captures are confirmed.";
    return;
  }
  index = next;
  render();
}

$("answer").addEventListener("keydown", (event) => {
  const empty = event.target.value === "";
  if (event.key === "Enter") { event.preventDefault(); void save({ answer: event.target.value }); }
  else if (event.key === "Escape") { event.preventDefault(); void save({ unreadable: true }); }
  else if (event.key === "PageUp" || (empty && event.key === "ArrowLeft")) { event.preventDefault(); move(-1); }
  else if (event.key === "PageDown" || (empty && event.key === "ArrowRight")) { event.preventDefault(); move(1); }
});
$("previous").addEventListener("click", () => move(-1));
$("next").addEventListener("click", () => move(1));

fetch("/api/state").then((response) => response.json()).then((loaded) => {
  state = loaded;
  $("title").textContent = state.bank.displayName + " audio CAPTCHA validation";
  const first = state.captures.findIndex(({ id }) => !entry(id).confirmed);
  index = first === -1 ? 0 : first;
  render();
});
</script>
</body>
</html>`;
}

const log = (line: string) => { stderr.write(`${line}\n`); };
const print = (text: string) => new Promise<void>((resolve) => { stdout.write(text, () => resolve()); });

function interruptSignal(): AbortSignal {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  return controller.signal;
}

async function main(args: readonly string[]): Promise<number> {
  const command = parseAudioValidationArguments(args);
  if (command.kind === "help") {
    await print(`${USAGE}\n`);
    return 0;
  }
  if (command.kind === "usage-error") {
    stderr.write(`${command.message}\n\n${USAGE}\n`);
    return 2;
  }
  let corpusDirectory: string;
  try {
    corpusDirectory = await resolveAudioCorpusDirectory(command.corpus);
  } catch (error) {
    if (!(error instanceof AudioCorpusLocationError)) throw error;
    stderr.write(`${error.message}\n`);
    return 2;
  }

  if (command.reRecognize) {
    log(`Re-transcribing the clips in ${corpusDirectory}.`);
    const updated = await reRecognizeCorpus(corpusDirectory, createSherpaOnnxSpeechRecognitionEngine(), log);
    log(`Re-transcribed ${updated} capture(s).`);
  } else if (command.count > 0) {
    const signal = interruptSignal();
    log(`Collecting ${command.count} Next Bank audio CAPTCHA clips into ${corpusDirectory}, ${command.delayMs} ms apart.`);
    try {
      const result = await collectAudioCaptchas({
        count: command.count,
        delayMs: command.delayMs,
        corpusDirectory,
        signal,
        engine: createSherpaOnnxSpeechRecognitionEngine(),
        browser: createDevelopmentBrowserPort(signal, undefined, undefined, { headless: command.headless }),
        log,
      });
      log(`Captured ${result.captured}, failed ${result.failed}.`);
    } catch (error) {
      if (error instanceof DeniedRequestError) {
        log(error.message);
        return 1;
      }
      if (signal.aborted) {
        log("Interrupted; captures so far are kept.");
        return 130;
      }
      throw error;
    }
  }

  const captures = await readAudioCaptures(corpusDirectory);
  if (captures.length === 0) {
    log(`No captures in ${corpusDirectory}. Collect first with --allow-live-source.`);
    return 1;
  }
  const server = await startAudioLabelServer({ corpusDirectory });
  await print(`Confirm the Next Bank audio CAPTCHA digits at ${server.url}\nPress Ctrl-C to stop.\n`);
  const signal = interruptSignal();
  await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  await server.close();
  return 0;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
