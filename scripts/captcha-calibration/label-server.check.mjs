import assert from "node:assert/strict";
import { request } from "node:http";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { CALIBRATION_BANK_SPECS } from "./banks.ts";
import { startLabelServer } from "./label-server.ts";
import { solidPng, temporaryCorpus } from "./check-fixtures.mjs";

function send(url, { method = "GET", path = "/", host, headers = {}, body } = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: target.hostname,
      port: target.port,
      method,
      path,
      headers: { host: host ?? target.host, ...headers },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

const postLabel = (url, payload, headers = {}) => send(url, {
  method: "POST",
  path: "/api/label",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(payload),
});

async function withServer(bank, run) {
  const directory = await temporaryCorpus(["first", "second"], {
    version: 1,
    bank,
    entries: { first: { suggested: { at: "t", answer: "AB12", candidates: [], agreementCount: 3 } } },
  });
  const server = await startLabelServer({ corpusDirectory: directory, bank: CALIBRATION_BANK_SPECS[bank] });
  try {
    await run(server.url, directory);
  } finally {
    await server.close();
  }
}

const labelsIn = async (directory) => JSON.parse(await readFile(join(directory, "labels.json"), "utf8")).entries;

test("the server listens on 127.0.0.1 only and refuses a foreign Host header", async () => {
  await withServer("rakuten", async (url) => {
    assert.equal(new URL(url).hostname, "127.0.0.1");
    const ipv6 = await new Promise((resolve) => {
      const socket = connect({ host: "::1", port: Number(new URL(url).port) });
      socket.once("connect", () => { socket.destroy(); resolve("connected"); });
      socket.once("error", (error) => resolve(error.code));
    });
    assert.notEqual(ipv6, "connected", "the port is not reachable on another loopback address");
    assert.equal((await send(url, { host: "evil.example:80" })).status, 403);
    assert.equal((await send(url, { host: `localhost:${new URL(url).port}` })).status, 403);
    const page = await send(url);
    assert.equal(page.status, 200);
    assert.match(page.headers["content-security-policy"], /default-src 'self'; img-src 'self'; script-src 'nonce-/u);
    assert.doesNotMatch(page.body.toString(), /https?:\/\//u, "the page loads nothing from the network");
  });
});

test("a label is stored as a normalized confirmation and an unreadable mark is kept", async () => {
  await withServer("rakuten", async (url, directory) => {
    const saved = await postLabel(url, { id: "first", answer: " ab-12 " });
    assert.equal(saved.status, 200);
    const unreadable = await postLabel(url, { id: "second", unreadable: true });
    assert.equal(unreadable.status, 200);

    const entries = await labelsIn(directory);
    assert.equal(entries.first.confirmed.answer, "AB12");
    assert.equal(entries.first.suggested.answer, "AB12", "the suggestion survives");
    assert.equal(entries.second.confirmed.unreadable, true);
    const state = JSON.parse((await send(url, { path: "/api/state" })).body);
    assert.deepEqual(state.progress, { confirmed: 2, total: 2 });
  });
});

test("digit banks keep digits only and an empty answer is rejected", async () => {
  await withServer("mega", async (url, directory) => {
    assert.equal((await postLabel(url, { id: "first", answer: "1a2b3c4d5" })).status, 200);
    assert.equal((await labelsIn(directory)).first.confirmed.answer, "12345");
    assert.equal((await postLabel(url, { id: "second", answer: "abc" })).status, 400);
    assert.equal((await postLabel(url, { id: "missing", answer: "123" })).status, 404);
    assert.equal((await labelsIn(directory)).second, undefined);
  });
});

test("cross-site label posts are refused", async () => {
  await withServer("mega", async (url, directory) => {
    assert.equal((await postLabel(url, { id: "first", answer: "12345" }, { origin: "https://evil.example" })).status, 403);
    assert.equal((await send(url, { method: "POST", path: "/api/label", headers: { "content-type": "text/plain" }, body: JSON.stringify({ id: "first", answer: "12345" }) })).status, 415);
    assert.equal((await labelsIn(directory)).first.confirmed, undefined);
  });
});

test("images are served only for ids in captures.jsonl", async () => {
  await withServer("mega", async (url) => {
    const image = await send(url, { path: "/image/first" });
    assert.equal(image.status, 200);
    assert.equal(image.headers["content-type"], "image/png");
    assert.deepEqual(image.body, solidPng());
    assert.equal((await send(url, { path: "/image/unknown" })).status, 404);
    assert.equal((await send(url, { path: "/image/..%2Fcaptures.jsonl" })).status, 404);
    assert.equal((await send(url, { path: "/image/../labels.json" })).status, 404);
    assert.equal((await send(url, { path: "/images/first.png" })).status, 404);
  });
});
