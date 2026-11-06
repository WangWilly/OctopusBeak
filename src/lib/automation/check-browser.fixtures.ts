import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { chromium, type Browser, type BrowserContext, type LaunchOptions } from "playwright";

type PersistentContextOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>;

/** A check's own fixture servers listen here, so these hosts skip the refusing proxy. */
const LOOPBACK_HOSTS = "localhost,127.0.0.1,[::1]";

/** A check sent a request that no route answered to a host that is not loopback. */
export class UnroutedRequestError extends Error {
  constructor(readonly destinations: readonly string[]) {
    super(
      `A browser check sent requests that no route answered to ${destinations.join(", ")}. ` +
        "Answer each with a route or a local fixture server. Chromium follows a fulfilled redirect on the network.",
    );
    this.name = "UnroutedRequestError";
  }
}

type RefusingProxy = Readonly<{
  settings: NonNullable<LaunchOptions["proxy"]>;
  /** Stops the proxy, then throws if it refused any request. */
  close(): Promise<void>;
}>;

/**
 * A request that no route fulfils reaches this proxy instead of the network. The
 * proxy refuses it and records its destination. Routes see only the first URL of
 * a redirect chain, so a fulfilled 3xx is the usual way past them. A
 * `route.continue()` and the context's `request` API also go through this proxy.
 */
async function startRefusingProxy(): Promise<RefusingProxy> {
  const destinations = new Set<string>();
  const proxy = createServer((request, response) => {
    destinations.add(request.url ?? "");
    response.writeHead(403).end();
  });
  proxy.on("connect", (request, socket: Socket) => {
    destinations.add(`https://${request.url ?? ""}`);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  proxy.unref();
  const { port } = proxy.address() as AddressInfo;
  let closed: Promise<void> | null = null;
  return {
    settings: { server: `http://127.0.0.1:${port}`, bypass: LOOPBACK_HOSTS },
    async close() {
      closed ??= new Promise<void>((resolve) => {
        proxy.closeAllConnections();
        proxy.close(() => resolve());
      });
      await closed;
      if (destinations.size > 0) throw new UnroutedRequestError([...destinations]);
    },
  };
}

async function guarded<T extends Browser | BrowserContext>(
  launch: (proxy: RefusingProxy["settings"]) => Promise<T>,
): Promise<T> {
  const proxy = await startRefusingProxy();
  let target: T;
  try {
    target = await launch(proxy.settings);
  } catch (error) {
    await proxy.close().catch(() => undefined);
    throw error;
  }
  const close = target.close.bind(target);
  target.close = async (options) => {
    try {
      await close(options);
    } finally {
      await proxy.close();
    }
  };
  return target;
}

/**
 * Launches Chromium for a check. Only routes and loopback servers answer its
 * requests. Closing the browser throws `UnroutedRequestError` if any request
 * went past them.
 */
export async function launchCheckBrowser(options: Omit<LaunchOptions, "proxy"> = {}): Promise<Browser> {
  return await guarded((proxy) => chromium.launch({ headless: true, ...options, proxy }));
}

/** `launchCheckBrowser` for a check that needs a persistent profile. */
export async function launchCheckPersistentContext(
  userDataDirectory: string,
  options: Omit<PersistentContextOptions, "proxy"> = {},
): Promise<BrowserContext> {
  return await guarded((proxy) =>
    chromium.launchPersistentContext(userDataDirectory, { headless: true, ...options, proxy }));
}
