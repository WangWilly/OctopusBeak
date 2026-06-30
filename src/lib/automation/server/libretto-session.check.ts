import assert from "node:assert/strict";
import {
  cdpEndpointFromState,
  librettoSessionPath,
  parseLibrettoSessionState,
  validateLibrettoSessionName,
} from "./libretto-session.ts";

assert.equal(validateLibrettoSessionName("ses-1p4q"), "ses-1p4q");
assert.throws(() => validateLibrettoSessionName("../bad"));
assert.throws(() => validateLibrettoSessionName("bad/slash"));

assert.equal(
  librettoSessionPath("ses-1p4q").endsWith(".libretto/sessions/ses-1p4q/state.json"),
  true,
);

assert.deepEqual(
  parseLibrettoSessionState(JSON.stringify({
    version: 1,
    session: "ses-1p4q",
    port: 48321,
    pid: 123,
    startedAt: "2026-06-30T00:00:00.000Z",
    status: "paused",
    mode: "write-access",
  })),
  {
    session: "ses-1p4q",
    port: 48321,
    cdpEndpoint: undefined,
    viewport: undefined,
  },
);

assert.equal(
  cdpEndpointFromState({ session: "ses-1p4q", port: 48321 }),
  "http://127.0.0.1:48321",
);
assert.equal(
  cdpEndpointFromState({ session: "ses-1p4q", port: 0, cdpEndpoint: "ws://127.0.0.1:9999/devtools/browser/abc" }),
  "ws://127.0.0.1:9999/devtools/browser/abc",
);
assert.equal(cdpEndpointFromState({ session: "ses-1p4q", port: 0 }), null);
