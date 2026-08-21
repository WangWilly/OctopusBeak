import assert from "node:assert/strict";
import {
  cdpEndpointFromState,
  cdpEndpointFromSessionLog,
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
    pid: 123,
    cdpEndpoint: undefined,
    status: "paused",
    viewport: undefined,
  },
);
assert.throws(() => parseLibrettoSessionState(JSON.stringify({
  session: "ses-1p4q",
  port: 48321,
  pid: -1,
})), /Invalid Libretto session pid/);

assert.equal(
  cdpEndpointFromState({ session: "ses-1p4q", port: 48321 }),
  "http://127.0.0.1:48321",
);
assert.equal(
  cdpEndpointFromState({ session: "ses-1p4q", port: 0, cdpEndpoint: "ws://127.0.0.1:9999/devtools/browser/abc" }),
  "ws://127.0.0.1:9999/devtools/browser/abc",
);
assert.equal(cdpEndpointFromState({ session: "ses-1p4q", port: 0 }), null);

const recoveredState = parseLibrettoSessionState(JSON.stringify({
  session: "ses-fubon",
  port: 0,
  pid: 95248,
}));
assert.equal(
  cdpEndpointFromSessionLog(recoveredState, JSON.stringify({
    scope: "libretto.child",
    event: "child-launched",
    data: {
      session: "ses-fubon",
      pid: 95248,
      port: 53640,
    },
  })),
  "http://127.0.0.1:53640",
);
assert.equal(
  cdpEndpointFromSessionLog(recoveredState, JSON.stringify({
    scope: "libretto.child",
    event: "child-launched",
    data: {
      session: "ses-fubon",
      pid: 95249,
      port: 53640,
    },
  })),
  null,
);

const logEvent = (event: string, data: Record<string, unknown>) => JSON.stringify({
  scope: event === "child-launched" ? "libretto.child" : "libretto",
  event,
  data,
});
const launchA = logEvent("child-launched", {
  session: "ses-fubon",
  pid: 95248,
  port: 53640,
});
const exitA = logEvent("child-exit", {
  session: "ses-fubon",
  pid: 95248,
});
assert.equal(cdpEndpointFromSessionLog(recoveredState, [launchA, exitA].join("\n")), null);

const launchB = logEvent("child-launched", {
  session: "ses-fubon",
  pid: 95248,
  port: 53641,
});
assert.equal(
  cdpEndpointFromSessionLog(recoveredState, [launchA, exitA, launchB].join("\n")),
  "http://127.0.0.1:53641",
);
assert.equal(
  cdpEndpointFromSessionLog(
    recoveredState,
    [launchA, logEvent("child-exit", { session: "ses-fubon", pid: 95249 })].join("\n"),
  ),
  "http://127.0.0.1:53640",
);
assert.equal(
  cdpEndpointFromSessionLog(recoveredState, [launchA, launchA, exitA, exitA].join("\n")),
  null,
);
assert.equal(
  cdpEndpointFromSessionLog(recoveredState, [launchA, "{malformed-tail"].join("\n")),
  "http://127.0.0.1:53640",
);
for (const terminalEvent of ["close-success", "child-killed", "termination", "child-termination"]) {
  assert.equal(
    cdpEndpointFromSessionLog(recoveredState, [launchA, logEvent(terminalEvent, { session: "ses-fubon", pid: 95248 })].join("\n")),
    null,
    terminalEvent,
  );
}
