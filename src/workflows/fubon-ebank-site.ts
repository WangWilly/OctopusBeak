import type { Frame, Locator, Page, Response } from "playwright";
import { ProductCollectionFatalError } from "../lib/automation/product-collection.ts";
import type { SourceTextPort } from "../lib/automation/source-text.ts";
import { activateControlWithoutPointer } from "./browser-interaction.ts";
import { frameScope, ifFound, type BrowserScope, type FrameScope } from "./frame-scope.ts";

export const FUBON_EBANK_ENTRY_URL = "https://ebank.taipeifubon.com.tw/B2C/common/Index.faces";
const HEADER_FRAME = "frame1";
const SHELL_TIMEOUT_MS = 5_000;
/** How long a task link already on the page may take to appear before the header menu is opened. */
const LINK_PRESENT_TIMEOUT_MS = 5_000;
const LINK_TIMEOUT_MS = 30_000;
/** How long a triggered task may take to render before the site triggers it once more. */
const ROUTE_RENDER_TIMEOUT_MS = 30_000;
const CONTROL_TIMEOUT_MS = 5_000;
const BANK_MASK_SELECTOR = "div._mask, ._mask";

/** Where one product's page lives on the Fubon eBank site. */
export type FubonRoute = Readonly<{
  description: string;
  /** The task link that opens the page, searched in every scope; candidates are tried in order within each scope. */
  link(scope: BrowserScope): Locator | readonly Locator[];
  /** The header-frame menu that reveals the task link, such as "#menu_CLN". */
  menu?: string;
  /**
   * Click the task link where it is even when it carries a real href, so the
   * bank performs its own redirect instead of the site navigating to the href.
   */
  clickInPlace?: boolean;
  /** Whether this scope shows the product's page. It may throw a typed absence. */
  ready(scope: BrowserScope): Promise<boolean>;
}>;

/**
 * The signed-in Fubon eBank site (ADR 0066): a JSF frameset whose header
 * frame1 holds the menus and whose txnFrame shows each task. Tasks are reached
 * through the bank's own links, because navigating a frame directly loses the
 * bank's 302 hand-off.
 */
export type FubonEbankSite = Readonly<{
  frames: FrameScope;
  header(): Promise<Frame>;
  /** Open a product's page from any signed-in page and return the scope that shows it. */
  open(route: FubonRoute): Promise<BrowserScope>;
  /** Click a control without the pointer, following a real href in its own scope. */
  activate(control: Locator, scope?: BrowserScope): Promise<void>;
  waitForMaskToClear(timeoutMs?: number): Promise<void>;
  /** Post a form from inside the page and decode the reply strictly as UTF-8. */
  postback(form: Locator, submitFieldName?: string, fields?: Readonly<Record<string, string>>): Promise<string>;
  replaceDocument(scope: BrowserScope, html: string): Promise<void>;
  /** Decode an HTML response strictly as UTF-8. */
  readHtml(response: Response): Promise<string>;
}>;

type SiteContext = Readonly<{ signal: AbortSignal; text: SourceTextPort }>;

const isFollowableHref = (href: string | null): href is string =>
  !!href && href !== "#" && !href.startsWith("javascript:");

export function fubonEbankSite(page: Page, context: SiteContext): FubonEbankSite {
  const frames = frameScope(page, context.signal);

  const header = async (): Promise<Frame> => {
    const frame = await ifFound(frames.frame(HEADER_FRAME, { timeoutMs: SHELL_TIMEOUT_MS }));
    if (!frame) throw new ProductCollectionFatalError("authentication-failed");
    return frame;
  };

  const activate = async (control: Locator, scope?: BrowserScope) => {
    const href = await frames.race(control.getAttribute("href", { timeout: CONTROL_TIMEOUT_MS }).catch(() => null));
    if (scope && isFollowableHref(href)) {
      await frames.race(scope.goto(new URL(href, FUBON_EBANK_ENTRY_URL).toString(), { waitUntil: "domcontentloaded" }));
      return;
    }
    // A dispatched click takes the run's signal, so a click queued behind a bank redirect cannot outlive the run.
    await frames.race(activateControlWithoutPointer(control, {
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(CONTROL_TIMEOUT_MS)]),
      timeout: CONTROL_TIMEOUT_MS,
    }));
  };

  const findLink = (route: FubonRoute, timeoutMs: number) =>
    frames.until(async () => {
      for (const scope of frames.scopes()) {
        const candidates = route.link(scope);
        for (const candidate of Array.isArray(candidates) ? candidates : [candidates]) {
          const link = (candidate as Locator).first();
          if ((await link.count().catch(() => 0)) > 0) return { scope, link };
        }
      }
      return null;
    }, `Could not find the ${route.description} link in any frame.`, { timeoutMs });

  // A control that times out is not proof that the bank ignored it; the ready probe that follows decides.
  const activateTolerantly = async (control: Locator, scope?: BrowserScope) => {
    try {
      await activate(control, scope);
    } catch (error) {
      if (context.signal.aborted) throw error;
    }
  };

  const trigger = async (route: FubonRoute, openMenu: boolean): Promise<void> => {
    if (openMenu && route.menu) {
      await activateTolerantly((await header()).locator(route.menu).first());
    }
    const present = openMenu ? null : await ifFound(findLink(route, LINK_PRESENT_TIMEOUT_MS));
    if (!present && !openMenu && route.menu) return await trigger(route, true);
    const { scope, link } = present ?? await findLink(route, LINK_TIMEOUT_MS);
    await activateTolerantly(link, route.clickInPlace ? undefined : scope);
  };

  const showing = (route: FubonRoute, timeoutMs?: number) =>
    frames.until(async () => {
      for (const scope of frames.scopes()) {
        if (await route.ready(scope)) return scope;
      }
      return null;
    }, `Could not find ${route.description} in any frame.`, { timeoutMs });

  const site: FubonEbankSite = {
    frames,
    header,
    open: async (route) => {
      await header();
      await trigger(route, false);
      const rendered = await ifFound(showing(route, ROUTE_RENDER_TIMEOUT_MS));
      if (rendered) return rendered;
      // The first trigger can replace the transaction frame before its task renders; trigger it once more.
      await trigger(route, true);
      return await showing(route);
    },
    activate,
    waitForMaskToClear: async (timeoutMs) => {
      await frames.until(async () => {
        for (const scope of frames.scopes()) {
          const masks = scope.locator(BANK_MASK_SELECTOR);
          const count = await masks.count().catch(() => 0);
          for (let index = 0; index < count; index += 1) {
            if (await masks.nth(index).isVisible().catch(() => false)) return false;
          }
        }
        return true;
      }, "Timed out waiting for the bank loading mask to clear.", { timeoutMs });
    },
    postback: async (form, submitFieldName, fields = {}) => {
      const base64 = await frames.race(form.evaluate(async (element, options) => {
        if (!(element instanceof HTMLFormElement)) throw new Error("Postback target is not a form element.");
        const body = new URLSearchParams();
        for (const [key, value] of new FormData(element)) body.append(key, String(value));
        if (options.submitFieldName) body.set(options.submitFieldName, options.submitFieldName);
        for (const [key, value] of Object.entries(options.fields)) body.set(key, value);
        const action = element.getAttribute("action") || window.location.href;
        const response = await fetch(new URL(action, window.location.href).toString(), {
          body: body.toString(),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          method: "POST",
        });
        if (!response.ok) throw new Error(`${response.status} for ${response.url}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = "";
        for (let index = 0; index < bytes.length; index += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
        }
        return btoa(binary);
      }, { fields, submitFieldName }));
      return context.text.decode(Buffer.from(base64, "base64"), "utf-8");
    },
    replaceDocument: async (scope, html) => {
      await frames.race(scope.evaluate((nextHtml) => {
        document.open();
        document.write(nextHtml);
        document.close();
      }, html));
    },
    readHtml: async (response) => context.text.decode(await frames.race(response.body()), "utf-8"),
  };
  return Object.freeze(site);
}
