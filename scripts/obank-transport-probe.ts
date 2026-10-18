import { createHash, randomUUID } from "node:crypto";
import { stdout } from "node:process";
import { inventoryFields } from "../src/lib/preview-sources/response-shape.ts";

// ADR 0044 transport probe for the O-Bank preview source. Sends only the
// pre-login requests of O-Bank's web banking (no credentials) through plain
// Node fetch, and prints each status, challenge marker, and field inventory.

const ORIGIN = "https://www.o-bank.com";
const ROOT = `${ORIGIN}/ebank/ixtein`;
const ADAPTER = `${ROOT}/v2/adapters/ebank`;
const REFERER = `${ORIGIN}/ebank/apps/services/www/ibmb/desktopbrowser/default/index.html`;
const CHALLENGE = /<title>Just a moment\.\.\.<\/title>|\/cdn-cgi\/challenge-platform\/|Request Rejected|incapsula|akamai/iu;

type Step = Readonly<{ step: string; status: number; contentType: string | null; challenge: boolean; json: boolean; markers?: unknown; fields: unknown }>;

const cookies = new Map<string, string>();
let accessToken = "";
let token = "#";
const clientNo = Date.now().toString();
const transactionId = randomUUID();
const steps: Step[] = [];

async function send(step: string, url: string, init: RequestInit): Promise<Record<string, unknown> | null> {
  const headers = new Headers(init.headers);
  if (cookies.size > 0) headers.set("Cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
  const response = await fetch(url, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(";", 1);
    const separator = pair!.indexOf("=");
    if (separator > 0) cookies.set(pair!.slice(0, separator).trim(), pair!.slice(separator + 1).trim());
  }
  const body = await response.text();
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(body) as Record<string, unknown>; } catch { parsed = null; }
  steps.push({
    step,
    status: response.status,
    contentType: response.headers.get("content-type"),
    challenge: CHALLENGE.test(body),
    json: parsed !== null,
    markers: parsed === null ? null : markers(parsed),
    fields: parsed === null ? null : inventoryFields(parsed),
  });
  if (parsed && typeof parsed.token === "string" && parsed.token) token = parsed.token;
  return parsed;
}

// Non-secret values that decide the shape match: result codes, the CAPTCHA
// media type, and the time factor's digit pattern.
function markers(body: Record<string, unknown>) {
  const rsData = (body.rsData ?? {}) as Record<string, unknown>;
  const img = typeof rsData.img === "string" ? /^data:([^;,]+);base64,/u.exec(rsData.img)?.[1] ?? "not a data URL" : undefined;
  const timeFactor = typeof rsData.timeFactor === "string" ? rsData.timeFactor.replace(/\d/gu, "9") : undefined;
  const e2eText = (rsData.params as Record<string, unknown> | undefined)?.e2e;
  const e2e = typeof e2eText === "string" ? /^-----BEGIN [A-Z ]+-----/u.exec(e2eText.trim())?.[0] ?? "no PEM header" : undefined;
  return { statusCode: body.statusCode, authStatus: body.authStatus, img, timeFactor, e2e };
}

function metadata(rqData: Record<string, unknown>, currentTxn?: string) {
  return {
    trackingPk: `${randomUUID().replaceAll("-", "")}${Date.now().toString().slice(-4)}`,
    txnPk: transactionId,
    pk: "none",
    model: "Chrome",
    platform: "MacIntel",
    version: "151",
    network: "0",
    appVersion: "1.0",
    clientTime: Date.now().toString(),
    locale: "zh_TW",
    fromSysPk: "IB",
    token,
    clientNo,
    xDId: "",
    rqData,
    ...(currentTxn ? { currentTxn } : {}),
  };
}

function adapter(step: string, procedure: string, payload: unknown[]) {
  const body = JSON.stringify(payload);
  return send(step, `${ADAPTER}/AuthenticationAdapter/${procedure}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      Origin: ORIGIN,
      Referer: REFERER,
      "X-Requested-With": "XMLHttpRequest",
      checksum: createHash("md5").update(body, "utf8").digest("hex"),
      "x-transaction-id": transactionId,
    },
    body,
  });
}

const noSec = (resource: string, rqData: Record<string, unknown>, currentTxn?: string) =>
  adapter(`sendAndReceiveNoSec ${resource}`, "sendAndReceiveNoSec", [resource, metadata(rqData, currentTxn)]);

async function probe() {
  await send("GET ChannelAdapter/getChannel", `${ADAPTER}/ChannelAdapter/getChannel`, {
    method: "GET",
    headers: { Accept: "application/json", "Content-Type": "application/json", Referer: REFERER, "X-Requested-With": "XMLHttpRequest" },
  });
  const oauth = await send("POST oauth/token", `${ROOT}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: "PUBLIC", client_id: "browser", client_secret: "browser" }).toString(),
  });
  accessToken = typeof oauth?.access_token === "string" ? oauth.access_token : "";
  if (!accessToken) return;
  await noSec("common/CMN01003/010", {});
  await adapter("emptyLogin", "emptyLogin", [metadata({}, "")]);
  token = "#";
  await noSec("fco/FCO02001/012", {}, "FCO02001");
  await noSec("common/CMN01004/010", { type: "0", page: "FCO02001_010" }, "FCO02001");
  await noSec("common/CMN01001/010", {}, "FCO02001");
  await noSec("common/EndToEnd/020", {});
}

await probe().catch((error: unknown) => {
  steps.push({ step: "network", status: 0, contentType: null, challenge: false, json: false, fields: String(error) });
});
stdout.write(`${JSON.stringify({ probedAt: new Date().toISOString(), runtime: `node ${process.version}`, steps }, null, 2)}\n`);
