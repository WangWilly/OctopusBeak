import type { Browser, Page } from "playwright";
import { PNG } from "pngjs";
import type { PageForRun } from "./automation-viewer.ts";
import type { VerificationSolver, VerificationSolverResult } from "./verification-solver.ts";

type VerificationSolverInput = Parameters<VerificationSolver["solve"]>[0];

/** The synthetic provider origin every verification check page is served from. */
export const PROVIDER_ORIGIN = "https://provider.test";

export function solidPng(width: number, height: number, red = 40): Buffer {
  const png = new PNG({ width, height });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data[offset] = red;
    png.data[offset + 3] = 255;
  }
  return PNG.sync.write(png);
}

export const pngDataUrl = (width: number, height: number, red = 40) =>
  `data:image/png;base64,${solidPng(width, height, red).toString("base64")}`;

export type SyntheticRoute = Readonly<{ path: string; contentType: string; body: string | Buffer }>;

/**
 * Serve `html` from the synthetic provider origin on a fresh real-Chromium
 * page, together with any extra same-origin responses (images, audio, frames).
 */
export async function openSyntheticPage(
  browser: Browser,
  html: string,
  routes: readonly SyntheticRoute[] = [],
): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const responses = new Map<string, SyntheticRoute>([
    ["/login", { path: "/login", contentType: "text/html; charset=utf-8", body: html }],
    ...routes.map((route) => [route.path, route] as const),
  ]);
  await page.route(`${PROVIDER_ORIGIN}/**`, async (route) => {
    const response = responses.get(new URL(route.request().url()).pathname);
    if (!response) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ contentType: response.contentType, body: response.body });
  });
  await page.goto(`${PROVIDER_ORIGIN}/login`, { waitUntil: "load" });
  return page;
}

/** One run's page lookup, as the App's browser host registers it. */
export const pageForRunOf = (taskRunId: string, page: Page): PageForRun =>
  (candidate) => candidate === taskRunId ? page : null;

/** A solver that records what it was shown and answers from a fixed script. */
export function scriptedSolver(
  answer: (input: VerificationSolverInput, call: number) => VerificationSolverResult,
): VerificationSolver & { inputs: VerificationSolverInput[] } {
  const inputs: VerificationSolverInput[] = [];
  return {
    inputs,
    async solve(input) {
      inputs.push(input);
      return answer(input, inputs.length);
    },
  };
}
