# The worker's loopback DevTools endpoint is an accepted local exposure

Status: accepted

Records a consequence of [ADR 0129](./0129-a-workflow-execution-gets-its-page-and-worker-from-one-execution-host.md) that it did not weigh.

The App browser host launches Chromium with `--remote-debugging-address=127.0.0.1` and `--remote-debugging-port=0`, and the workflow worker thread attaches to that endpoint. ADR 0129 chose this because a Playwright `Page` cannot cross a thread boundary. Chromium's DevTools endpoint has no authentication.

**What can reach it.** A web page cannot: Chromium refuses a DevTools WebSocket that carries an `Origin` it was not told to allow. Any process on the Mac can, including one that runs as another user of the same Mac, because the loopback interface is shared. A process that attaches can read the session's cookies and drive the signed-in page. The endpoint exists only while a hosted page is open, which is the minutes a collection or a device registration takes.

**What already protects the rest.** Sign-in Details are encrypted under a Keychain key that another process cannot use without the person's consent. Retained cookies on disk are encrypted the same way. The endpoint is the one place where a signed-in session is reachable without that key.

## Decision

The exposure is accepted for now. PRODUCT.md's commitment that session material stays on the host holds against the network and against web content. It does not hold against another process on the same Mac while a collection runs.

Removing the endpoint is not a local change. The worker would have to own the browser over Playwright's pipe transport, which moves the launch, the profile folders and the cookie codec out of the main process, or the host would have to relay DevTools traffic over a channel it authenticates. Both reopen ADR 0129 to [ADR 0135](./0135-a-host-runs-a-round-s-page-and-worker-in-one-operation.md).

## Considered options

- **An authenticating relay in the host.** Not now. Chromium's own port would still listen unless the browser moves to the pipe transport, so the relay alone closes nothing.
- **Say nothing.** Rejected. A reader who finds the unauthenticated port should also find that it was weighed.

## Consequences

- A process on the same Mac can take over a bank session during a collection. Nothing in the App detects that.
- Any later change to how the worker reaches its page should remove the TCP endpoint if it can.
