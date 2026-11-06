import assert from "node:assert/strict";
import test from "node:test";
import { ProviderResponseCheckError, type ProviderResponseCheck } from "../lib/automation/provider-response-check.ts";
import { SourceTextIntegrityError, strictSourceText } from "../lib/automation/source-text.ts";
import {
  acceptProviderResponse,
  verifyProviderResponse,
  type ProviderEvidence,
  type ProviderResponse,
  type ProviderResponseDeclaration,
} from "./provider-response.ts";

const HTTP_DATE = "Fri, 25 Sep 2026 11:59:00 GMT";

const RESPONSE: ProviderResponseDeclaration<"required"> = {
  label: "Check bank current deposit",
  host: "bank.example",
  endpoints: [
    { path: "/balances", method: "POST", contentType: /^application\/json\b/iu, search: /^(?:\?t=\d+)?$/u },
    { path: "/fallback", method: "GET" },
  ],
  cacheControl: ["no-store", "no-cache"],
  providerDate: "required",
};

const PROVIDER_RESPONSE: ProviderResponse = {
  url: "https://bank.example/balances",
  status: 200,
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8", "cache-control": "private, no-cache, no-store", date: HTTP_DATE },
};

const accept = (evidence: ProviderEvidence, response: ProviderResponse = PROVIDER_RESPONSE) =>
  acceptProviderResponse(RESPONSE, { evidence, response }, { observedAt: "2026-09-25T20:00:01+08:00", text: strictSourceText });

const json = (body: string): ProviderEvidence => ({ kind: "json", bytes: new TextEncoder().encode(body) });

test("a declared response verifies to its transport facts and the run clock's Taipei second", () => {
  const verified = verifyProviderResponse(RESPONSE, { ...PROVIDER_RESPONSE, url: "https://bank.example/balances?t=1" }, "2026-09-25T20:00:01+08:00");
  assert.equal(verified.endpoint.path, "/balances");
  assert.equal(verified.contentType, "application/json; charset=utf-8");
  assert.equal(verified.cacheControl, "private, no-cache, no-store");
  assert.deepEqual(verified.providerDate, { raw: HTTP_DATE, effectiveAt: "2026-09-25T11:59:00.000Z" });
  assert.equal(verified.observedAt, "2026-09-25T20:00:01+08:00");
  const fallback = verifyProviderResponse(RESPONSE, { ...PROVIDER_RESPONSE, url: "https://bank.example/fallback", method: "get", headers: { ...PROVIDER_RESPONSE.headers, "content-type": "text/html" } }, "x");
  assert.equal(fallback.endpoint.path, "/fallback");
  const anyMethod: ProviderResponseDeclaration = { ...RESPONSE, endpoints: [{ path: "/balances" }] };
  assert.equal(verifyProviderResponse(anyMethod, { ...PROVIDER_RESPONSE, method: "PUT" }, "x").endpoint.path, "/balances");
});

test("every undeclared transport fact rejects the response with the source's label", () => {
  const rejected: readonly [string, ProviderResponse, RegExp][] = [
    ["unparseable URL", { ...PROVIDER_RESPONSE, url: "not a url" }, /^Error: Check bank current deposit response URL is invalid\.$/u],
    ["plain http", { ...PROVIDER_RESPONSE, url: "http://bank.example/balances" }, /endpoint is unexpected/u],
    ["other host", { ...PROVIDER_RESPONSE, url: "https://evil.example/balances" }, /endpoint is unexpected/u],
    ["explicit port", { ...PROVIDER_RESPONSE, url: "https://bank.example:8443/balances" }, /endpoint is unexpected/u],
    ["credentials", { ...PROVIDER_RESPONSE, url: "https://u:p@bank.example/balances" }, /endpoint is unexpected/u],
    ["fragment", { ...PROVIDER_RESPONSE, url: "https://bank.example/balances#x" }, /endpoint is unexpected/u],
    ["other path", { ...PROVIDER_RESPONSE, url: "https://bank.example/other" }, /endpoint is unexpected/u],
    ["undeclared query", { ...PROVIDER_RESPONSE, url: "https://bank.example/balances?session=1" }, /endpoint is unexpected/u],
    ["query on a query-free endpoint", { ...PROVIDER_RESPONSE, url: "https://bank.example/fallback?t=1", method: "GET" }, /endpoint is unexpected/u],
    ["method", { ...PROVIDER_RESPONSE, method: "GET" }, /response method is not POST/u],
    ["status", { ...PROVIDER_RESPONSE, status: 302 }, /response status is 302, expected 200/u],
    ["content type", { ...PROVIDER_RESPONSE, headers: { ...PROVIDER_RESPONSE.headers, "Content-Type": "text/html" } }, /content type is unexpected/u],
    ["one cache directive", { ...PROVIDER_RESPONSE, headers: { ...PROVIDER_RESPONSE.headers, "cache-control": "no-store" } }, /must carry Cache-Control: no-store, no-cache/u],
    ["cache directive as a value", { ...PROVIDER_RESPONSE, headers: { ...PROVIDER_RESPONSE.headers, "cache-control": "no-store, x=no-cache" } }, /must carry Cache-Control/u],
    ["missing Date", { ...PROVIDER_RESPONSE, headers: { ...PROVIDER_RESPONSE.headers, date: "" } }, /response is missing HTTP Date/u],
    ["Date without GMT", { ...PROVIDER_RESPONSE, headers: { ...PROVIDER_RESPONSE.headers, date: "Fri, 25 Sep 2026 11:59:00" } }, /HTTP Date is invalid/u],
    ["impossible Date", { ...PROVIDER_RESPONSE, headers: { ...PROVIDER_RESPONSE.headers, date: "Thu, 31 Sep 2026 11:59:00 GMT" } }, /HTTP Date is invalid/u],
    ["wrong weekday", { ...PROVIDER_RESPONSE, headers: { ...PROVIDER_RESPONSE.headers, date: "Mon, 25 Sep 2026 11:59:00 GMT" } }, /HTTP Date is invalid/u],
  ];
  for (const [name, response, expected] of rejected)
    assert.throws(() => verifyProviderResponse(RESPONSE, response, "x"), expected, name);
  const checkOf = (name: string): ProviderResponseCheck => {
    if (/URL|http|host|port|credentials|fragment|path|query/u.test(name)) return "response-endpoint";
    if (name === "method") return "response-method";
    if (name === "status") return "response-status";
    if (name === "content type") return "response-content-type";
    if (/cache/u.test(name)) return "response-cache-control";
    return "response-date";
  };
  for (const [name, response] of rejected)
    assert.throws(
      () => verifyProviderResponse(RESPONSE, response, "x"),
      (error) => error instanceof ProviderResponseCheckError && error.check === checkOf(name),
      `${name} names its check`,
    );
});

test("an optional provider date may be absent but must be valid when present", () => {
  const optional: ProviderResponseDeclaration<"optional"> = { ...RESPONSE, providerDate: "optional" };
  const { date: _date, ...headers } = PROVIDER_RESPONSE.headers;
  assert.equal(verifyProviderResponse(optional, { ...PROVIDER_RESPONSE, headers }, "x").providerDate, null);
  assert.throws(
    () => verifyProviderResponse(optional, { ...PROVIDER_RESPONSE, headers: { ...headers, date: "yesterday" } }, "x"),
    /HTTP Date is invalid/u,
  );
});

test("an accepted response carries its verified transport facts and its strictly decoded evidence", () => {
  const body = '[{"amount":1000.00,"note":"\\u53f0\\u5e63 臺"}]';
  const accepted = accept(json(body));
  assert.equal(accepted.response.endpoint.path, "/balances");
  assert.equal(accepted.response.observedAt, "2026-09-25T20:00:01+08:00");
  assert.deepEqual(accepted.evidence, { kind: "json", value: [{ amount: 1000, note: "台幣 臺" }], text: body });
  assert.deepEqual(accept({ kind: "cells", rows: [["A", "12"]] }).evidence, { kind: "cells", rows: [["A", "12"]] });
  assert.deepEqual(accept({ kind: "html", html: "<td>12</td>" }).evidence, { kind: "html", html: "<td>12</td>" });
});

test("acceptance checks the transport before it decodes the evidence", () => {
  assert.throws(
    () => accept(json("not json"), { ...PROVIDER_RESPONSE, url: "https://bank.example/other" }),
    (error) => error instanceof ProviderResponseCheckError && error.check === "response-endpoint",
  );
});

test("acceptance rejects evidence that does not decode strictly", () => {
  const rejected: readonly [string, ProviderEvidence, (error: unknown) => boolean][] = [
    ["invalid UTF-8", { kind: "json", bytes: Uint8Array.of(0x5b, 0xff, 0x5d) }, (error) => error instanceof SourceTextIntegrityError],
    ["escaped U+FFFD", json('["A\\uFFFD"]'), (error) => error instanceof SourceTextIntegrityError],
    ["not JSON", json("["), (error) => error instanceof ProviderResponseCheckError && error.check === "evidence-json"],
    ["cell with U+FFFD", { kind: "cells", rows: [["A", "1�"]] }, (error) => error instanceof SourceTextIntegrityError],
    ["markup with U+FFFD", { kind: "html", html: "<td>1�</td>" }, (error) => error instanceof SourceTextIntegrityError],
  ];
  for (const [name, evidence, expected] of rejected)
    assert.throws(() => accept(evidence), expected, name);
});

const EXPORT: ProviderResponseDeclaration<"optional"> = {
  label: "Check bank export",
  host: "bank.example",
  endpoints: [{ path: "/export", method: "POST", charset: { decode: "big5", labels: ["cp950"] }, attachment: true }],
  cacheControl: [],
  providerDate: "optional",
  maxBytes: 8,
};
const EXPORT_RESPONSE: ProviderResponse = {
  url: "https://bank.example/export",
  status: 200,
  method: "POST",
  headers: { "content-type": "application/vnd.ms-excel; charset=cp950", "content-disposition": "attachment; filename=x.xls" },
};
const BIG5_TAI = Uint8Array.of(0xa5, 0x78);
const acceptExport = (headers: Readonly<Record<string, string>>, bytes = BIG5_TAI) =>
  acceptProviderResponse(EXPORT, { evidence: { kind: "text", bytes }, response: { ...EXPORT_RESPONSE, headers } }, {
    observedAt: "2026-09-25T20:00:01+08:00",
    text: strictSourceText,
  });
const checked = (check: ProviderResponseCheck) => (error: unknown) =>
  error instanceof ProviderResponseCheckError && error.check === check;

test("a text response decodes as its endpoint's charset under any label that names it", () => {
  assert.deepEqual(acceptExport(EXPORT_RESPONSE.headers).evidence, { kind: "text", text: "台" });
  for (const contentType of ["application/vnd.ms-excel; charset=big5", "application/vnd.ms-excel"])
    assert.deepEqual(acceptExport({ ...EXPORT_RESPONSE.headers, "content-type": contentType }).evidence, { kind: "text", text: "台" });
});

test("a body in another charset than declared is refused before it decodes", () => {
  assert.throws(() => acceptExport({ ...EXPORT_RESPONSE.headers, "content-type": "text/csv; charset=utf-8" }), checked("response-charset"));
  assert.throws(() => accept(json("[]"), { ...PROVIDER_RESPONSE, headers: { ...PROVIDER_RESPONSE.headers, "Content-Type": "application/json; charset=big5" } }), checked("response-charset"));
  assert.doesNotThrow(() => accept(json("[]"), { ...PROVIDER_RESPONSE, headers: { ...PROVIDER_RESPONSE.headers, "Content-Type": "application/json; charset=UTF8" } }));
});

test("an attachment endpoint refuses an inline response, and a size limit refuses a larger one", () => {
  const { "content-disposition": _disposition, ...inline } = EXPORT_RESPONSE.headers;
  assert.throws(() => acceptExport(inline), checked("response-disposition"));
  assert.throws(() => acceptExport({ ...EXPORT_RESPONSE.headers, "content-length": "9" }), checked("response-size"));
  assert.throws(() => acceptExport(EXPORT_RESPONSE.headers, new Uint8Array(9)), checked("response-size"));
  assert.throws(
    () => verifyProviderResponse(EXPORT, { ...EXPORT_RESPONSE, headers: { ...EXPORT_RESPONSE.headers, "content-length": "9" } }, "x"),
    checked("response-size"),
    "a declared length over the limit is refused before the body is read",
  );
});

test("text evidence from an endpoint with no declared charset is a declaration error", () => {
  assert.throws(
    () => acceptProviderResponse(RESPONSE, { evidence: { kind: "text", bytes: BIG5_TAI }, response: PROVIDER_RESPONSE }, {
      observedAt: "x",
      text: strictSourceText,
    }),
    /declares no charset/u,
  );
});
