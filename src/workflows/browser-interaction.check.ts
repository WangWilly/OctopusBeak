import assert from "node:assert/strict";
import {
  activateControlWithoutPointer,
  endsRequestChainFrom,
  hasAttachedLocator,
} from "./browser-interaction.ts";

function locatorProbe(
  waitFor: (options: { state: "attached"; timeout: number }) => Promise<void>,
) {
  return {
    first() {
      return { waitFor };
    },
  };
}

let seenOptions: { state: "attached"; timeout: number } | null = null;
assert.equal(
  await hasAttachedLocator(
    locatorProbe(async (options) => {
      seenOptions = options;
    }),
    123,
  ),
  true,
);
assert.deepEqual(seenOptions, { state: "attached", timeout: 123 });

assert.equal(
  await hasAttachedLocator(
    locatorProbe(async () => {
      throw new Error("not attached");
    }),
    1,
  ),
  false,
);

let evaluateCalled = false;
let dispatchType: string | null = null;
let dispatchOptions: { signal?: AbortSignal; timeout?: number } | null = null;
const dispatchSignal = new AbortController().signal;
await activateControlWithoutPointer(
  {
    evaluate: async () => {
      evaluateCalled = true;
    },
    dispatchEvent: async (
      type: string,
      _eventInit: unknown,
      options: { signal?: AbortSignal; timeout?: number },
    ) => {
      dispatchType = type;
      dispatchOptions = options;
    },
  } as never,
  { signal: dispatchSignal, timeout: 0 },
);
assert.equal(evaluateCalled, false);
assert.equal(dispatchType, "click");
const seenDispatchOptions = dispatchOptions as unknown as {
  signal?: AbortSignal;
  timeout?: number;
};
assert.equal(seenDispatchOptions.signal, dispatchSignal);
assert.equal(seenDispatchOptions.timeout, 0);

// A redirect chain reaches the endpoint when it starts or ends there; the hops
// that redirect onward are never the response (ADR 0108).
type FakeRequest = Readonly<{ url(): string; method(): string; redirectedFrom(): FakeRequest | null }>;
const fakeRequest = (url: string, method: string, from: FakeRequest | null = null): FakeRequest => ({
  url: () => url,
  method: () => method,
  redirectedFrom: () => from,
});
const fakeResponse = (status: number, request: FakeRequest, location?: string) =>
  ({
    status: () => status,
    request: () => request,
    headers: () => (location === undefined ? {} : { location }),
  }) as never;
const endpointPath = "/B2C/cccqu/cccqu002/CCCQU002_Home.faces";
const dispatcher = fakeRequest("https://bank.test/B2C/dispatcher?ParamValue=~opaque~", "GET");
const endpoint = `https://bank.test${endpointPath}?menuId=CCC0201`;
assert.equal(
  endsRequestChainFrom(fakeResponse(200, fakeRequest(`${endpoint}&`, "GET", dispatcher)), endpointPath, "GET"),
  true,
  "a chain that arrives at the endpoint from a dispatcher ends on the endpoint's response",
);
assert.equal(
  endsRequestChainFrom(fakeResponse(302, fakeRequest(endpoint, "GET"), "/elsewhere"), endpointPath, "GET"),
  false,
  "a hop that redirects onward is not the response",
);
assert.equal(
  endsRequestChainFrom(
    fakeResponse(200, fakeRequest("https://bank.test/maintenance", "GET", fakeRequest(endpoint, "GET"))),
    endpointPath,
    "GET",
  ),
  true,
  "a chain that leaves the endpoint surfaces as its last response, for the endpoint check to reject",
);
assert.equal(
  endsRequestChainFrom(
    fakeResponse(200, fakeRequest("https://bank.test/notice", "GET", fakeRequest(endpoint, "POST"))),
    endpointPath,
    "POST",
  ),
  true,
  "a POST redirected to a GET elsewhere still counts as the POST's response",
);
assert.equal(
  endsRequestChainFrom(fakeResponse(304, fakeRequest(endpoint, "GET")), endpointPath, "GET"),
  true,
  "a 304 without a location is a final response, for the status check to reject",
);
assert.equal(
  endsRequestChainFrom(fakeResponse(200, fakeRequest(endpoint, "POST")), endpointPath, "GET"),
  false,
  "a request with another method is a different endpoint",
);
assert.equal(
  endsRequestChainFrom(fakeResponse(200, dispatcher), endpointPath, "GET"),
  false,
  "a response that never touches the endpoint is not its response",
);
