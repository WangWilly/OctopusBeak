import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { normalizeCaptchaText } from "../../src/lib/automation/server/text-captcha-solver.ts";
import { preprocessCaptchaImage } from "../../src/lib/automation/server/captcha-preprocess.ts";
import type { CalibrationBankSpec } from "./banks.ts";
import {
  imagePath,
  readCaptures,
  readLabels,
  updateLabels,
  withConfirmation,
  type CaptureRecord,
  type Confirmation,
} from "./corpus.ts";

const HOST = "127.0.0.1";
const MAX_BODY_BYTES = 4096;

export type LabelServer = Readonly<{ url: string; close(): Promise<void> }>;

type LabelRequest = Readonly<{ id: string; answer: string }> | Readonly<{ id: string; unreadable: true }>;

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function parseLabelRequest(value: unknown): LabelRequest {
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

export async function startLabelServer(options: Readonly<{ corpusDirectory: string; bank: CalibrationBankSpec }>): Promise<LabelServer> {
  const { corpusDirectory, bank } = options;
  let origin = "";

  async function captureById(id: string): Promise<CaptureRecord | undefined> {
    return (await readCaptures(corpusDirectory)).find((capture) => capture.id === id);
  }

  async function state() {
    const captures = await readCaptures(corpusDirectory);
    const { entries } = await readLabels(corpusDirectory, bank.id);
    return {
      bank: { id: bank.id, displayName: bank.displayName, charset: bank.charset, declaredLength: bank.declaredLength?.value ?? null, authoritativeLength: bank.declaredLength?.authority === "source" ? bank.declaredLength.value : null, preprocessing: bank.preprocessing ?? null },
      captures: captures.map(({ id, width, height }) => ({ id, width, height })),
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
    const body = parseLabelRequest(parsed);
    if (!await captureById(body.id)) throw new HttpError(404, "Unknown capture.");
    const at = new Date().toISOString();
    let confirmation: Confirmation;
    if ("unreadable" in body) {
      confirmation = { unreadable: true, at };
    } else {
      const answer = normalizeCaptchaText(body.answer, bank.charset);
      if (!answer) throw new HttpError(400, "The answer is empty after normalization.");
      if (bank.declaredLength?.authority === "source" && answer.length !== bank.declaredLength.value) {
        throw new HttpError(400, `The source requires exactly ${bank.declaredLength.value} characters. Correct the answer or mark it unreadable with Esc.`);
      }
      confirmation = { answer, at };
    }
    const labels = await updateLabels(corpusDirectory, bank.id, (entries) => withConfirmation(entries, body.id, confirmation));
    return labels.entries[body.id];
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (request.headers.host !== new URL(origin).host) throw new HttpError(403, "Unexpected Host header.");
    const { pathname } = new URL(request.url ?? "/", origin);
    if (request.method === "GET" && pathname === "/") {
      const nonce = randomBytes(16).toString("base64");
      send(response, 200, "text/html; charset=utf-8", labelPage(nonce), {
        "content-security-policy": `default-src 'self'; img-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
      return;
    }
    if (request.method === "GET" && pathname === "/api/state") {
      sendJson(response, 200, await state());
      return;
    }
    const image = /^\/image\/([^/]+)$/u.exec(pathname);
    if (request.method === "GET" && image) {
      const capture = await captureById(decodeURIComponent(image[1]!));
      if (!capture) throw new HttpError(404, "Unknown capture.");
      send(response, 200, "image/png", await readFile(imagePath(corpusDirectory, capture)));
      return;
    }
    const processed = /^\/processed\/([^/]+)$/u.exec(pathname);
    if (request.method === "GET" && processed) {
      const capture = await captureById(decodeURIComponent(processed[1]!));
      if (!capture || !bank.preprocessing) throw new HttpError(404, "Unknown capture.");
      const raw = await readFile(imagePath(corpusDirectory, capture));
      const output = preprocessCaptchaImage(raw, undefined, { imagePreprocessing: bank.preprocessing });
      send(response, 200, "image/png", output);
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

function labelPage(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CAPTCHA labelling</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0; padding: 24px; display: grid; gap: 16px; justify-items: start; }
  header { display: flex; gap: 24px; align-items: baseline; flex-wrap: wrap; }
  h1 { font-size: 18px; margin: 0; }
  #frame { padding: 16px; background: #fff; border: 1px solid #8884; }
  #challenge { display: block; image-rendering: pixelated; }
  #processed-challenge { display: block; image-rendering: pixelated; background: #fff; }
  #frame, #pframe { padding: 16px; background: #fff; border: 1px solid #8884; display: inline-block; }
  #answer { font: 32px ui-monospace, monospace; letter-spacing: 0.2em; width: 12ch; padding: 4px 8px; }
  .meta { color: #888; }
  .status-confirmed { color: #2a7d2a; }
  .status-unreadable { color: #b5651d; }
  nav { display: flex; gap: 8px; }
  kbd { border: 1px solid #8886; border-radius: 3px; padding: 0 4px; font-size: 90%; }
</style>
</head>
<body>
<header>
  <h1 id="title">CAPTCHA labelling</h1>
  <span id="progress"></span>
  <span id="position" class="meta"></span>
</header>
<div id="frame" hidden></div>
<div id="pframe" hidden></div>
<div class="meta" id="suggestion"></div>
<input id="answer" autocomplete="off" spellcheck="false" aria-label="Answer">
<div id="status"></div>
<nav>
  <button id="previous" type="button">Previous</button>
  <button id="next" type="button">Next</button>
</nav>
<p class="meta">
  <kbd>Enter</kbd> saves the input as confirmed. Type to correct it first.
  <kbd>Esc</kbd> marks the image unreadable.
  <kbd>PageUp</kbd> / <kbd>PageDown</kbd>, or <kbd>&larr;</kbd> / <kbd>&rarr;</kbd> with an empty input, move between images.
</p>
<script nonce="${nonce}">
"use strict";
const SCALE = 6;
let state = null;
let index = 0;
const $ = (id) => document.getElementById(id);

function entry(id) { return state.entries[id] || {}; }
function validConfirmation(id) {
  const confirmed = entry(id).confirmed;
  return confirmed && (confirmed.unreadable || state.bank.authoritativeLength === null || confirmed.answer.length === state.bank.authoritativeLength);
}
function confirmedCount() { return state.captures.filter(({ id }) => validConfirmation(id)).length; }
function nextUnconfirmed(from) {
  const total = state.captures.length;
  for (let step = 1; step <= total; step += 1) {
    const candidate = (from + step) % total;
    if (!validConfirmation(state.captures[candidate].id)) return candidate;
  }
  return -1;
}

function render() {
  const total = state.captures.length;
  $("progress").textContent = confirmedCount() + " / " + total + " confirmed";
  if (total === 0) {
    $("status").textContent = "The corpus has no captures yet.";
    $("answer").disabled = true;
    return;
  }
  const capture = state.captures[index];
  const { suggested, confirmed } = entry(capture.id);
  $("position").textContent = "Image " + (index + 1) + " of " + total;
  const image = new Image();
  image.id = "challenge";
  image.alt = "CAPTCHA challenge";
  image.src = "/image/" + encodeURIComponent(capture.id);
  image.width = capture.width * SCALE;
  image.height = capture.height * SCALE;
  $("frame").replaceChildren(image);
  $("frame").hidden = false;
  const processed = state.bank.preprocessing ? document.createElement("img") : null;
  if (processed) {
    processed.id = "processed-challenge";
    processed.alt = "Preprocessed CAPTCHA challenge";
    processed.src = "/processed/" + encodeURIComponent(capture.id);
    processed.width = capture.width * SCALE;
    processed.height = capture.height * SCALE;
    $("pframe").replaceChildren(processed);
    $("pframe").hidden = false;
  } else {
    $("pframe").hidden = true;
  }
  $("suggestion").textContent = suggested
    ? "Suggested " + (suggested.answer || "(none)") + ", " + suggested.agreementCount + " of " + suggested.candidates.length + " OCR strategies agree"
    : "No OCR suggestion. Run prelabel first, or type the answer.";
  const status = $("status");
  status.className = confirmed ? (confirmed.unreadable ? "status-unreadable" : "status-confirmed") : "";
  status.textContent = confirmed ? (confirmed.unreadable ? "Marked unreadable" : "Confirmed " + confirmed.answer) : "Not confirmed";
  if (confirmed && !validConfirmation(capture.id)) {
    status.className = "status-unreadable";
    status.textContent = "The confirmed answer has the wrong length. Please correct it, or press Esc if unreadable.";
  }
  const input = $("answer");
  input.value = confirmed && !confirmed.unreadable ? confirmed.answer : (suggested ? suggested.answer : "");
  input.inputMode = state.bank.charset === "digits" ? "numeric" : "text";
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
    $("status").textContent = "All images are confirmed.";
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
  $("title").textContent = state.bank.displayName + " CAPTCHA labelling";
  const first = state.captures.findIndex(({ id }) => !validConfirmation(id));
  index = first === -1 ? 0 : first;
  render();
});
</script>
</body>
</html>`;
}
