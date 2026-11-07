import { errors, type Frame, type Locator, type Page, type Response } from "playwright";
import { FRAME_SCOPE_TIMEOUT_MS, frameScope, FrameScopeTimeoutError, type BrowserScope, type FrameScope } from "./frame-scope.ts";
import type { ProviderResponse, ProviderResponseDeclaration } from "./provider-response.ts";
import type { ProviderResponseReader } from "./provider-response-reader.ts";

export const HNCB_NETBANK_ORIGIN = "https://netbank.hncb.com.tw";
/** The servlet every HNCB transaction is requested through. */
export const HNCB_TRX_DISPATCHER_PATH = "/netbank/servlet/TrxDispatcher" as const;
const MAIN_FRAME = "main";
/** How long a menu click that posts to the TrxDispatcher may take to answer before the next step is searched. */
const MENU_DISPATCH_TIMEOUT_MS = 10_000;

/** One menu label clicked on the way to a page. */
export type HncbMenuStep = Readonly<{
  label: string;
  /** Search only this frame, such as the left `menu` frame; otherwise every scope. */
  frame?: string;
  /** The click posts to the TrxDispatcher; wait for that reply before the next step. */
  dispatches?: boolean;
}>;

/** A page on the HNCB netbank site: a transaction opened in the main frame. */
export type HncbRoute = Readonly<{
  description: string;
  via: Readonly<{ trx: string; state: string }>;
  /** Whether this scope shows the product's page. */
  ready(scope: BrowserScope): Promise<boolean>;
}>;

/**
 * A product's page reached by clicking menu labels in order, whose last
 * click must produce the declared reply. The page's evidence is its DOM, so
 * the reply only witnesses the request that rendered it.
 */
export type HncbMenuRoute = Readonly<{
  description: string;
  menu: readonly HncbMenuStep[];
  reply: ProviderResponseDeclaration;
  /** Whether this scope shows the product's page. */
  ready(scope: BrowserScope): Promise<boolean>;
}>;

/** A page the site opened: the scope that shows it and the provider reply that rendered it. */
export type HncbPage = Readonly<{ scope: BrowserScope; reply: Response }>;

/** A page a menu route read: the scope that shows it and the reply's transport, which the reader checked. */
export type HncbReadPage = Readonly<{ scope: BrowserScope; response: ProviderResponse }>;

/**
 * The signed-in HNCB netbank site (ADR 0104): a frameset whose `main` frame
 * shows each transaction, requested through the TrxDispatcher servlet.
 */
export type HncbNetbankSite = Readonly<{
  frames: FrameScope;
  /** The frame that shows each transaction; a missing frame times out after 60 s unless the caller says otherwise. */
  main(options?: Readonly<{ timeoutMs?: number }>): Promise<Frame>;
  /** Open a transaction's page from any signed-in page. */
  open(route: HncbRoute): Promise<HncbPage>;
  /** Follow a menu route from any signed-in page, reading its reply through the reader. */
  read(route: HncbMenuRoute, reader: ProviderResponseReader): Promise<HncbReadPage>;
  /** Post a transaction into the main frame and wait for the reply it loads there; null when it loads none. */
  dispatch(trx: string, fields: Readonly<Record<string, string>>): Promise<Response | null>;
  /** Click a control that posts the main frame's own form, and wait for the reply it loads there; null when it loads none. */
  submit(control: Locator): Promise<Response | null>;
  /** Wait for the page, and the main frame, to stop loading. */
  settle(): Promise<void>;
}>;

type SiteContext = Readonly<{ signal: AbortSignal }>;

export function isHncbTrxDispatcherUrl(url: string): boolean {
  try {
    return new URL(url).pathname === HNCB_TRX_DISPATCHER_PATH;
  } catch {
    return false;
  }
}

export function hncbTrxUrl(trx: string, state: string): string {
  const url = new URL(HNCB_TRX_DISPATCHER_PATH, HNCB_NETBANK_ORIGIN);
  url.searchParams.set("trx", trx);
  url.searchParams.set("state", state);
  return url.toString();
}

export function hncbNetbankSite(page: Page, context: SiteContext): HncbNetbankSite {
  const frames = frameScope(page, context.signal);

  const main = (options?: Readonly<{ timeoutMs?: number }>) => frames.frame(MAIN_FRAME, options);

  // Playwright's own timeout becomes the frame scope's, naming what the site waited for.
  const waited = async <T>(wait: Promise<T>, description: string): Promise<T> => {
    try {
      return await wait;
    } catch (error) {
      if (error instanceof errors.TimeoutError) throw new FrameScopeTimeoutError(`Timed out waiting for ${description}.`);
      throw error;
    }
  };

  // A post the main frame never loads answers null, so the product decides what a missing reply means; only cancellation escapes.
  const loadedInMain = async (send: (frame: Frame) => Promise<void>): Promise<Response | null> => {
    const frame = await main();
    const navigated = frames.withSignal((signal) =>
      frame.waitForNavigation({ waitUntil: "domcontentloaded", timeout: FRAME_SCOPE_TIMEOUT_MS, signal }))
      .catch(() => {
        frames.signal.throwIfAborted();
        return null;
      });
    navigated.catch(() => undefined);
    await send(frame);
    return await navigated;
  };

  const goto = async (url: string, description: string): Promise<Response> => {
    const frame = await main();
    const response = await frames.withSignal((signal) => frame.goto(url, { waitUntil: "domcontentloaded", signal }));
    if (!response) throw new Error(`HNCB loaded ${description} without a provider reply.`);
    return response;
  };

  const control = (step: HncbMenuStep): Promise<Locator> => {
    const matcher = new RegExp(`^\\s*${step.label}\\s*$`, "u");
    return frames.until(async () => {
      const scopes = step.frame ? [page.frame({ name: step.frame })].filter((frame) => frame !== null) : frames.scopes();
      for (const scope of scopes) {
        const controls = scope.locator("a, button").filter({ hasText: matcher });
        const count = await controls.count().catch(() => 0);
        for (let index = 0; index < count; index += 1) {
          const candidate = controls.nth(index);
          if (await candidate.isVisible().catch(() => false)) return candidate;
        }
      }
      return null;
    }, `Could not find HNCB menu control "${step.label}"${step.frame ? ` in frame "${step.frame}"` : ""}.`);
  };

  const isDispatcherPost = (response: Response) =>
    response.request().method() === "POST" &&
    response.url().startsWith(`${HNCB_NETBANK_ORIGIN}/`) &&
    isHncbTrxDispatcherUrl(response.url());

  /**
   * Click every label but the last. A dispatching menu reloads the frames, so
   * the next label is searched only once its dispatcher POST answers, when it
   * does; that reply is never read, only awaited.
   */
  const walkMenu = async (steps: readonly HncbMenuStep[]): Promise<void> => {
    for (const step of steps) {
      const link = await control(step);
      const dispatched = step.dispatches
        ? frames.withSignal((signal) =>
          page.waitForResponse(isDispatcherPost, { timeout: MENU_DISPATCH_TIMEOUT_MS, signal }))
          .catch(() => frames.signal.throwIfAborted())
        : null;
      dispatched?.catch(() => undefined);
      await frames.withSignal((signal) => link.click({ signal }));
      await dispatched;
    }
  };

  const showing = (route: Pick<HncbRoute, "description" | "ready">) =>
    frames.until(async () => {
      for (const scope of frames.scopes()) {
        if (await route.ready(scope)) return scope;
      }
      return null;
    }, `Could not find ${route.description} in any frame.`);

  const settle = async () => {
    await frames.settle(page.frame({ name: MAIN_FRAME }) ?? undefined);
  };

  const site: HncbNetbankSite = {
    frames,
    main,
    open: async (route) => {
      const reply = await goto(hncbTrxUrl(route.via.trx, route.via.state), route.description);
      await settle();
      return { scope: await showing(route), reply };
    },
    read: async (route, reader) => {
      const last = route.menu.at(-1);
      if (!last) throw new Error(`HNCB route to ${route.description} names no menu.`);
      await walkMenu(route.menu.slice(0, -1));
      // Only the last click is the trigger, so an earlier step's page cannot stand in for the reply.
      const link = await control(last);
      const { response } = await waited(reader.witness(frames, route.reply, {
        trigger: () => frames.withSignal((signal) => link.click({ signal })),
      }), `the HNCB reply that renders ${route.description}`);
      await settle();
      return { scope: await showing(route), response };
    },
    dispatch: (trx, fields) =>
      loadedInMain(async (frame) => {
        await frames.race(frame.evaluate(({ action, fields }) => {
          const form = document.createElement("form");
          form.method = "POST";
          form.action = action;
          for (const [name, value] of Object.entries(fields)) {
            const input = document.createElement("input");
            input.type = "hidden";
            input.name = name;
            input.value = value;
            form.appendChild(input);
          }
          document.body.appendChild(form);
          // Submitted after evaluate returns, so the navigation cannot cut the evaluation off.
          setTimeout(() => form.submit(), 0);
        }, { action: HNCB_TRX_DISPATCHER_PATH, fields: { trx, ...fields } }));
      }),
    submit: (target) =>
      loadedInMain(async () => {
        await frames.withSignal((signal) => target.click({ signal }));
      }),
    settle,
  };
  return Object.freeze(site);
}
