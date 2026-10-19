import { createHash, randomUUID } from "node:crypto";
import { stdout } from "node:process";
import { inventoryFields } from "../src/lib/preview-sources/response-shape.ts";

// ADR 0044 transport probe for the CTBC credit-card preview source. Sends only
// the pre-login MobileFirst handshake of CTBC's mobile banking App (no
// credentials) through plain Node fetch, and prints each status, challenge
// marker, and field inventory.

const IMP = "https://eb.ctbcbank.com/IMP";
const APPLICATION = "EBMW_Adapter";
const RESOURCE_ENDPOINT = `${IMP}/api/adapters/${APPLICATION}/resource/ebmwResource`;
// CTBC_PROBE_APP_VERSION lets a rerun ask how the handshake answers an older App version.
const APP_VERSION = process.env.CTBC_PROBE_APP_VERSION ?? "5.2.26";
const WEB_VERSION = "(0812)";
const PUBLIC_CLIENT_TOKEN = "2ae74c0ad7a14739a2aab7340616d70e";
const USER_AGENT =
  "Mozilla/5.0 (Linux; Android 15; Pixel 8 Build/AP3A.241005.015; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.58 Mobile Safari/537.36";
const CHALLENGE = /<title>Just a moment\.\.\.<\/title>|\/cdn-cgi\/challenge-platform\/|Request Rejected|incapsula|akamai|_Incapsula_Resource|<html/iu;

type Step = Readonly<{ step: string; status: number; contentType: string | null; challenge: boolean; json: boolean; markers?: unknown; fields: unknown }>;

const cookies = new Map<string, string>();
const deviceCode = randomUUID();
const steps: Step[] = [];
let accessToken = "";

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
    challenge: parsed === null && CHALLENGE.test(body),
    json: parsed !== null,
    markers: parsed === null ? { bodyLength: body.length } : markers(parsed),
    fields: parsed === null ? null : inventoryFields(parsed),
  });
  return parsed;
}

// Non-secret values that decide the shape match: result codes and whether a
// seed and a token came back.
function markers(body: Record<string, unknown>) {
  const rsData = (body.rsData ?? {}) as Record<string, unknown>;
  return {
    statusCode: body.statusCode,
    statusDesc: typeof body.statusDesc === "string" ? body.statusDesc.slice(0, 80) : undefined,
    appVersionValidate: body.appVersionValidate,
    code: body.code,
    success: body.success,
    tokenPresent: typeof body.token === "string" && body.token !== "",
    seedPresent: typeof rsData.seed === "string" && rsData.seed !== "",
    tokenType: body.token_type,
    scope: body.scope,
  };
}

const baseHeaders = () => ({
  Accept: "application/json",
  "Content-Type": "application/json",
  "User-Agent": USER_AGENT,
  Authorization: `Bearer ${accessToken}`,
});

async function probe() {
  const tokenUrl = new URL(`${IMP}/oauth/token`);
  tokenUrl.search = new URLSearchParams({ grant_type: "client_credentials", scope: "PUBLIC", client_id: APPLICATION, client_secret: PUBLIC_CLIENT_TOKEN }).toString();
  const oauth = await send("POST oauth/token", tokenUrl.toString(), {
    method: "POST",
    headers: { ...baseHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
    body: "",
  });
  accessToken = typeof oauth?.access_token === "string" ? oauth.access_token : "";
  if (!accessToken) return;
  await send("POST main/init", `${IMP}/main/init`, {
    method: "POST",
    headers: baseHeaders(),
    body: JSON.stringify({
      application: APPLICATION,
      deviceCode,
      deviceManufacturer: "Google",
      deviceModel: "Pixel 8",
      devicePlatform: "Android",
      deviceVersion: "15",
      pclientTime: Date.now(),
      randomNumber: "",
      clientPubk: "",
    }),
  });
  const body = JSON.stringify({
    deviceIxd: deviceCode.replaceAll("-", ""),
    trackingIxd: randomUUID(),
    txnIxd: "",
    model: "Google Pixel 8",
    platform: "Android",
    version: "15",
    network: "wifi",
    appVer: APP_VERSION,
    clientNo: Date.now().toString(),
    clientTime: Date.now().toString(),
    locale: "zh_TW",
    fromSys: "0",
    seed: "",
    deviceToken: "",
    buildDisplay: "AP3A.241005.015",
    rqData: {},
    webVer: WEB_VERSION,
  });
  await send("POST ebmwResource (handshakewb)", RESOURCE_ENDPOINT, {
    method: "POST",
    headers: {
      ...baseHeaders(),
      checksum: createHash("sha256").update(body, "utf8").digest("hex"),
      deviceCode,
      "X-Request-Type": "handshakewb",
    },
    body,
  });
}

await probe().catch((error: unknown) => {
  steps.push({ step: "network", status: 0, contentType: null, challenge: false, json: false, fields: String(error) });
});
const full = process.argv.includes("--fields");
const report = steps.map((step) => full ? step : { ...step, fields: step.fields === null ? null : Object.keys(step.fields as object).filter((path) => /^\$\.[A-Za-z_]+$/u.test(path)) });
stdout.write(`${JSON.stringify({ probedAt: new Date().toISOString(), runtime: `node ${process.version}`, appVersion: APP_VERSION, steps: report }, null, 2)}\n`);
