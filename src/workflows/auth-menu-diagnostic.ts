import { randomUUID } from "node:crypto";
import { chmod, mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Frame, Locator, Page } from "playwright";
import { z } from "zod";

/**
 * Auth-only route inspection contract.  The collector is intentionally not a
 * statement workflow: it reads visible repayment-related anchors after the
 * provider's shared authentication seam reports success, then exits.
 */
export const AUTH_MENU_DIAGNOSTIC_EVENT = "bank-auth-menu-diagnostic" as const;
export const AUTH_MENU_DIAGNOSTIC_CONTRACT_VERSION =
  "bank/auth-menu-diagnostic/v1" as const;
export const FUBON_AUTH_MENU_DIAGNOSTIC_CONTRACT_VERSION =
  "fubon/auth-menu-diagnostic/v1" as const;
export const YUANTA_AUTH_MENU_DIAGNOSTIC_CONTRACT_VERSION =
  "yuanta/auth-menu-diagnostic/v1" as const;
export const AUTH_MENU_DIAGNOSTIC_DIRECTORY_ENV =
  "OCTOPUSBEAK_AUTH_MENU_DIAGNOSTIC_DIR" as const;

export const AUTH_MENU_DIAGNOSTIC_MAX_SCOPES = 64;
// Authenticated bank shells commonly contain a few hundred utility anchors
// in fmain. Keep a generous bounded read so those anchors cannot starve the
// small repayment menu from the global budget.
export const AUTH_MENU_DIAGNOSTIC_MAX_ANCHORS = 2048;
export const AUTH_MENU_DIAGNOSTIC_MAX_ANCHORS_PER_SCOPE = 1024;
export const AUTH_MENU_DIAGNOSTIC_MAX_CANDIDATES = 128;
export const AUTH_MENU_DIAGNOSTIC_DEFAULT_READY_TIMEOUT_MS = 30_000;
export const AUTH_MENU_DIAGNOSTIC_READY_POLL_INTERVAL_MS = 250;

export type AuthMenuDiagnosticProvider = "fubon" | "yuanta";

export type AuthMenuDiagnosticCategory =
  | "loan"
  | "repayment"
  | "autodebit"
  | "detail"
  | "transaction";

export type AuthMenuAnchorSnapshot = {
  label?: string | null;
  ariaLabel?: string | null;
  title?: string | null;
  imageAlt?: string | null;
  dataLabel?: string | null;
  dataMenuLabel?: string | null;
  href?: string | null;
  onclick?: string | null;
  action?: string | null;
  task?: string | null;
  menu?: string | null;
  id?: string | null;
  visible?: boolean;
  frameName?: string | null;
};

export type AuthMenuSafeQueryParameter = {
  name: string;
  value: string;
};

export type AuthMenuActionMetadata = {
  actionId: string | null;
  handlerId: string | null;
  taskId: string | null;
  menuId: string | null;
};

export type AuthMenuDiagnosticCandidate = {
  category: AuthMenuDiagnosticCategory;
  label: string;
  pathname: string | null;
  query: AuthMenuSafeQueryParameter[];
  action: AuthMenuActionMetadata | null;
  frameName: string | null;
  maskedLabel: boolean;
  metadataOmittedReason: "sensitive-metadata-omitted" | null;
};

export type AuthMenuFrameSummary = {
  frameName: string | null;
  anchorCount: number;
};

export type AuthMenuScreenshotStatus =
  | "captured"
  | "page-unavailable"
  | "filesystem-failed"
  | "capture-failed";

export type AuthMenuDiagnosticEvent = {
  event: typeof AUTH_MENU_DIAGNOSTIC_EVENT;
  provider: AuthMenuDiagnosticProvider;
  contractVersion: string;
  source: "authenticated-menu";
  readMode: "dom-only";
  observedAnchorCount: number;
  truncated: boolean;
  maskedAccountObserved: boolean;
  evidenceUsable: boolean;
  evidenceStopReason:
    | "authentication-failed"
    | "masked-account-observed"
    | "menu-incomplete"
    | null;
  frameSummaries: AuthMenuFrameSummary[];
  candidates: AuthMenuDiagnosticCandidate[];
};

export type AuthMenuDiagnosticOutput = AuthMenuDiagnosticEvent & {
  authentication: "succeeded" | "failed";
  readiness: "ready" | "timed-out" | "not-checked";
  screenshotPath: string | null;
  screenshotStatus: AuthMenuScreenshotStatus;
};

const actionMetadataSchema = z.object({
  actionId: z.string().nullable(),
  handlerId: z.string().nullable(),
  taskId: z.string().nullable(),
  menuId: z.string().nullable(),
});

const candidateSchema = z.object({
  category: z.enum(["loan", "repayment", "autodebit", "detail", "transaction"]),
  label: z.string(),
  pathname: z.string().nullable(),
  query: z.array(z.object({ name: z.string(), value: z.string() })),
  action: actionMetadataSchema.nullable(),
  frameName: z.string().nullable(),
  maskedLabel: z.boolean(),
  metadataOmittedReason: z.literal("sensitive-metadata-omitted").nullable(),
});

export const authMenuDiagnosticOutputSchema = z.object({
  event: z.literal(AUTH_MENU_DIAGNOSTIC_EVENT),
  provider: z.enum(["fubon", "yuanta"]),
  contractVersion: z.string().min(1),
  source: z.literal("authenticated-menu"),
  readMode: z.literal("dom-only"),
  authentication: z.enum(["succeeded", "failed"]),
  readiness: z.enum(["ready", "timed-out", "not-checked"]),
  observedAnchorCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  maskedAccountObserved: z.boolean(),
  evidenceUsable: z.boolean(),
  evidenceStopReason: z
    .enum([
      "authentication-failed",
      "masked-account-observed",
      "menu-incomplete",
  ])
    .nullable(),
  frameSummaries: z.array(
    z.object({
      frameName: z.string().nullable(),
      anchorCount: z.number().int().nonnegative(),
    }),
  ),
  candidates: z.array(candidateSchema),
  screenshotPath: z.string().nullable(),
  screenshotStatus: z.enum([
    "captured",
    "page-unavailable",
    "filesystem-failed",
    "capture-failed",
  ]),
});

type BrowserScope = Page | Frame;

const MASKED_LABEL_PATTERN =
  /(?:\*{2,}|•{2,}|·{2,}|x{3,}|遮罩|masked|redacted)/iu;
const SENSITIVE_TOKEN_PATTERN =
  /(?:cid|session|token|auth|cookie|password|passwd|otp|account|user|credential|secret)/iu;
const LONG_DIGIT_PATTERN = /\d{4,}/u;
const MAX_LABEL_LENGTH = 160;
const MAX_PATHNAME_LENGTH = 220;
const MAX_QUERY_NAME_LENGTH = 48;
const MAX_QUERY_VALUE_LENGTH = 80;
const MAX_IDENTIFIER_LENGTH = 80;

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_LABEL_LENGTH);
}

function containsSensitivePattern(value: string | null | undefined): boolean {
  if (!value) return false;
  return SENSITIVE_TOKEN_PATTERN.test(value) || LONG_DIGIT_PATTERN.test(value);
}

function categoryForLabel(value: string): AuthMenuDiagnosticCategory | null {
  if (
    /(?:自動\s*扣繳|自動\s*扣款|auto(?:matic)?\s*(?:debit|payment)|autopay|direct\s*debit)/iu.test(
      value,
    )
  ) {
    return "autodebit";
  }
  if (/(?:貸款|loan)/iu.test(value)) return "loan";
  if (/(?:還款|繳款|繳費|扣繳|扣款|repay(?:ment)?|payment)/iu.test(value)) {
    return "repayment";
  }
  if (/(?:明細|detail)/iu.test(value)) return "detail";
  if (/(?:交易|transaction|history)/iu.test(value)) return "transaction";
  return null;
}

function categoryFallbackLabel(
  category: AuthMenuDiagnosticCategory,
): string {
  switch (category) {
    case "loan":
      return "Loan route";
    case "repayment":
      return "Repayment route";
    case "autodebit":
      return "Autodebit route";
    case "detail":
      return "Detail route";
    case "transaction":
      return "Transaction route";
  }
}

function firstNonEmptyValue(
  ...values: Array<string | null | undefined>
): string {
  return values.find((value) => Boolean(value?.trim()))?.trim() ?? "";
}

function sanitizeLabel(value: string): {
  label: string;
  maskedLabel: boolean;
  sensitive: boolean;
} {
  const normalized = normalizeText(value);
  const maskedLabel = MASKED_LABEL_PATTERN.test(normalized);
  const sensitive = containsSensitivePattern(normalized);
  const label = normalized
    .replace(/(?:\*{2,}|•{2,}|·{2,}|x{3,}|遮罩|masked|redacted)/giu, "[masked]")
    .replace(/\d+/gu, "[redacted]")
    .replace(SENSITIVE_TOKEN_PATTERN, "[redacted]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_LABEL_LENGTH);
  return { label: label || "[unlabeled]", maskedLabel, sensitive };
}

function safeFrameName(value: string | null | undefined): string | null {
  const normalized = normalizeText(value ?? "");
  if (!normalized || containsSensitivePattern(normalized)) return null;
  if (!/^[\p{L}][\p{L}0-9._:-]{0,63}$/u.test(normalized)) return null;
  return normalized;
}

function safePathname(value: string | null | undefined): string | null {
  const raw = value?.trim() ?? "";
  if (!raw || raw === "#" || /^(?:javascript|data|mailto):/iu.test(raw)) {
    return null;
  }

  let pathname: string;
  try {
    pathname = new URL(raw, "https://auth-menu.invalid").pathname;
  } catch {
    return null;
  }

  const safePath = pathname
    .split("/")
    .map((segment) => {
      if (!segment) return "";
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return ":redacted";
      }
      if (
        containsSensitivePattern(decoded) ||
        /^(?:account|cid|otp|password|passwd|secret|token|session)$/iu.test(
          decoded,
        ) ||
        !/^[\p{L}0-9._~:-]+$/u.test(decoded) ||
        decoded.length > 80
      ) {
        return ":redacted";
      }
      return decoded;
    })
    .join("/");

  return safePath.slice(0, MAX_PATHNAME_LENGTH) || "/";
}

function safePathnameForAnchor(
  anchor: AuthMenuAnchorSnapshot,
): string | null {
  const direct = safePathname(anchor.href);
  if (direct && direct !== "/") return direct;

  // Yuanta commonly exposes the route as an argument to doAction() instead
  // of an href. Extract only quoted path-like strings, then pass them through
  // the same segment sanitizer; onclick itself never crosses the boundary.
  for (const source of [anchor.href, anchor.onclick, anchor.action]) {
    if (!source) continue;
    for (const match of source.matchAll(
      /["']((?:https?:\/\/|\/)[^"'\s)]*)["']/gu,
    )) {
      const candidate = safePathname(match[1]);
      if (candidate && candidate !== "/") return candidate;
    }
  }
  return direct;
}

function safeIdentifier(value: string | null | undefined): string | null {
  const normalized = normalizeText(value ?? "");
  if (
    !normalized ||
    containsSensitivePattern(normalized) ||
    !/^[A-Za-z][A-Za-z_.:-]{0,79}$/u.test(normalized)
  ) {
    return null;
  }
  return normalized.slice(0, MAX_IDENTIFIER_LENGTH);
}

function safeQuery(value: string | null | undefined): {
  query: AuthMenuSafeQueryParameter[];
  suspicious: boolean;
} {
  const raw = value?.trim() ?? "";
  if (!raw || /^(?:javascript|data|mailto):/iu.test(raw)) {
    return { query: [], suspicious: false };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw, "https://auth-menu.invalid");
  } catch {
    return { query: [], suspicious: true };
  }
  const query: AuthMenuSafeQueryParameter[] = [];
  let suspicious = false;
  for (const [name, rawValue] of parsed.searchParams.entries()) {
    const safeName = normalizeText(name).slice(0, MAX_QUERY_NAME_LENGTH);
    const safeValue = normalizeText(rawValue).slice(0, MAX_QUERY_VALUE_LENGTH);
    if (
      !safeName ||
      !/^[A-Za-z][A-Za-z0-9_.:-]{0,47}$/u.test(safeName) ||
      containsSensitivePattern(safeName) ||
      containsSensitivePattern(safeValue)
    ) {
      suspicious = true;
      continue;
    }
    query.push({ name: safeName, value: safeValue });
  }
  query.sort((left, right) =>
    `${left.name}\u0000${left.value}`.localeCompare(
      `${right.name}\u0000${right.value}`,
    ),
  );
  return { query, suspicious };
}

function safeAction(
  anchor: AuthMenuAnchorSnapshot,
): { action: AuthMenuActionMetadata | null; suspicious: boolean } {
  const rawValues = [
    anchor.onclick,
    anchor.action,
    anchor.task,
    anchor.menu,
    anchor.id,
  ];
  const onclick = anchor.onclick?.trim() ?? "";
  const handlerMatch = onclick.match(
    /^(?:javascript:\s*)?(?:return\s+)?([A-Za-z_$][\w$]*)\s*(?:\(|;|$)/u,
  );
  const handlerId = safeIdentifier(handlerMatch?.[1]);
  const actionId = safeIdentifier(anchor.action);
  const taskId = safeIdentifier(anchor.task);
  const menuId =
    safeIdentifier(anchor.menu) ??
    (anchor.id?.trim().match(/^menu[_:.:-]?(.*)$/iu)?.[1]
      ? safeIdentifier(anchor.id)
      : null);
  const present = rawValues.some((value) => Boolean(value?.trim()));
  if (!present) return { action: null, suspicious: false };
  return {
    action: { actionId, handlerId, taskId, menuId },
    // Keep static handler/menu identifiers even when an argument in the raw
    // onclick/data attribute was sensitive. The raw body and arguments are
    // never serialized.
    suspicious: rawValues.some((value) => containsSensitivePattern(value)),
  };
}

function candidateKey(candidate: AuthMenuDiagnosticCandidate): string {
  return JSON.stringify([
    candidate.category,
    candidate.label,
    candidate.pathname,
    candidate.query,
    candidate.action,
    candidate.frameName,
    candidate.maskedLabel,
    candidate.metadataOmittedReason,
  ]);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toCandidate(
  anchor: AuthMenuAnchorSnapshot,
): AuthMenuDiagnosticCandidate | null {
  if (anchor.visible === false) return null;
  const rawLabel = firstNonEmptyValue(
    anchor.label,
    anchor.ariaLabel,
    anchor.title,
    anchor.dataLabel,
    anchor.dataMenuLabel,
    anchor.imageAlt,
  );
  const routeHint = [
    rawLabel,
    anchor.href,
    anchor.onclick,
    anchor.action,
    anchor.task,
    anchor.menu,
    anchor.id,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(" ");
  const category = categoryForLabel(normalizeText(routeHint));
  if (!category) return null;

  const { label: sanitizedLabel, maskedLabel, sensitive: sensitiveLabel } =
    sanitizeLabel(rawLabel || categoryFallbackLabel(category));
  const label = sanitizedLabel || categoryFallbackLabel(category);
  const frameName = safeFrameName(anchor.frameName);
  const pathname = safePathnameForAnchor(anchor);
  const safeQueryResult = safeQuery(anchor.href);
  const actionResult = safeAction(anchor);
  const metadataOmitted =
    sensitiveLabel ||
    frameName === null ||
    safeQueryResult.suspicious ||
    actionResult.suspicious;

  return {
    category,
    label,
    pathname,
    query: safeQueryResult.query,
    action: actionResult.action,
    frameName,
    maskedLabel,
    metadataOmittedReason: metadataOmitted
      ? "sensitive-metadata-omitted"
      : null,
  };
}

function safeContractVersion(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._/-]/gu, "")
    .slice(0, 120);
  return normalized || AUTH_MENU_DIAGNOSTIC_CONTRACT_VERSION;
}

/**
 * Build a deterministic, bounded diagnostic event from short-lived DOM
 * snapshots.  Raw hrefs, onclick bodies, account-like labels and sensitive
 * query values never cross this boundary.
 */
export function buildAuthMenuDiagnosticEvent(
  provider: AuthMenuDiagnosticProvider,
  anchors: readonly AuthMenuAnchorSnapshot[],
  contractVersion: string,
  options: {
    truncated?: boolean;
    frameSummaries?: readonly AuthMenuFrameSummary[];
  } = {},
): AuthMenuDiagnosticEvent {
  const boundedAnchors = anchors.slice(0, AUTH_MENU_DIAGNOSTIC_MAX_ANCHORS);
  const candidates = new Map<string, AuthMenuDiagnosticCandidate>();
  for (const anchor of boundedAnchors) {
    const candidate = toCandidate(anchor);
    if (candidate) candidates.set(candidateKey(candidate), candidate);
  }

  const sortedCandidates = [...candidates.values()].sort((left, right) => {
    for (const [leftValue, rightValue] of [
      [left.category, right.category],
      [left.label, right.label],
      [left.pathname ?? "", right.pathname ?? ""],
      [left.frameName ?? "", right.frameName ?? ""],
    ]) {
      const comparison = compareStrings(leftValue, rightValue);
      if (comparison !== 0) return comparison;
    }
    return Number(left.maskedLabel) - Number(right.maskedLabel);
  });

  const maskedAccountObserved = sortedCandidates.some(
    (candidate) => candidate.maskedLabel,
  );
  const truncated = Boolean(options.truncated) ||
    anchors.length > boundedAnchors.length;
  const evidenceStopReason = maskedAccountObserved
    ? "masked-account-observed"
    : truncated
      ? "menu-incomplete"
      : null;
  const frameSummaries = [
    ...(options.frameSummaries ?? []),
    ...[...new Set(boundedAnchors.map((anchor) => anchor.frameName ?? null))]
      .filter(
        (frameName) =>
          !(options.frameSummaries ?? []).some(
            (summary) => summary.frameName === frameName,
          ),
      )
      .map((frameName) => ({
        frameName: safeFrameName(frameName),
        anchorCount: boundedAnchors.filter(
          (anchor) => (anchor.frameName ?? null) === frameName,
        ).length,
      })),
  ]
    .map((summary) => ({
      frameName: safeFrameName(summary.frameName),
      anchorCount: Math.max(0, Math.floor(summary.anchorCount)),
    }))
    .sort(
      (left, right) =>
        framePriority(left.frameName) - framePriority(right.frameName) ||
        (left.frameName ?? "").localeCompare(right.frameName ?? ""),
    );

  return {
    event: AUTH_MENU_DIAGNOSTIC_EVENT,
    provider,
    contractVersion: safeContractVersion(contractVersion),
    source: "authenticated-menu",
    readMode: "dom-only",
    observedAnchorCount: boundedAnchors.length,
    truncated,
    maskedAccountObserved,
    evidenceUsable: !maskedAccountObserved && !truncated,
    evidenceStopReason,
    frameSummaries,
    candidates: sortedCandidates.slice(0, AUTH_MENU_DIAGNOSTIC_MAX_CANDIDATES),
  };
}

type DiagnosticScope = {
  scope: BrowserScope;
  frameName: string | null;
  order: number;
};

function framePriority(frameName: string | null): number {
  if (frameName?.toLowerCase() === "fmenu") return 0;
  if (frameName?.toLowerCase() === "fmain") return 1;
  return 2;
}

function enumerateScopes(scope: BrowserScope): {
  scopes: DiagnosticScope[];
  truncated: boolean;
} {
  const maybePage = scope as Page & {
    frames?: () => Frame[];
    mainFrame?: () => Frame;
    frame?: (options: { name: string }) => Frame | null;
  };
  const maybeFrame = scope as Frame & { childFrames?: () => Frame[] };
  const frames: Array<{ frame: Frame; order: number }> = [];
  const seen = new Set<Frame>();
  let order = 0;
  let truncated = false;

  const appendFrameTree = (frame: Frame): void => {
    if (seen.has(frame)) return;
    seen.add(frame);
    frames.push({ frame, order: order++ });
    const children = frame.childFrames;
    if (typeof children !== "function") return;
    let nested: Frame[];
    try {
      nested = children.call(frame);
    } catch {
      truncated = true;
      return;
    }
    for (const child of nested) appendFrameTree(child);
  };

  if (typeof maybePage.frames === "function") {
    let pageFrames: Frame[];
    try {
      pageFrames = maybePage.frames();
    } catch {
      return { scopes: [{ scope, frameName: "page", order: 0 }], truncated: true };
    }
    let mainFrame: Frame | null = null;
    if (typeof maybePage.mainFrame === "function") {
      try {
        mainFrame = maybePage.mainFrame();
      } catch {
        truncated = true;
      }
    }
    for (const frame of pageFrames) {
      if (mainFrame && frame === mainFrame) {
        const children = frame.childFrames;
        if (typeof children === "function") {
          try {
            for (const child of children.call(frame)) appendFrameTree(child);
          } catch {
            truncated = true;
          }
        }
        continue;
      }
      appendFrameTree(frame);
    }
  }

  // Some embedded browser adapters expose named child frames through
  // page.frame() before page.frames() has caught up. Re-add the provider's
  // known menu frames by name; appendFrameTree deduplicates normal Playwright
  // pages and keeps this read-only recovery bounded.
  if (typeof maybePage.frame === "function") {
    for (const frameName of ["fmenu", "fmain"]) {
      try {
        const namedFrame = maybePage.frame({ name: frameName });
        if (namedFrame) appendFrameTree(namedFrame);
      } catch {
        truncated = true;
      }
    }
  }

  if (frames.length === 0 && typeof maybeFrame.childFrames === "function") {
    appendFrameTree(scope as Frame);
  }

  const ordered = frames
    .map(({ frame, order: frameOrder }) => {
      let frameName: string | null = null;
      try {
        frameName = safeFrameName(frame.name());
      } catch {
        truncated = true;
      }
      return {
        scope: frame as BrowserScope,
        frameName,
        order: frameOrder,
      };
    })
    .sort(
      (left, right) =>
        framePriority(left.frameName) - framePriority(right.frameName) ||
        left.order - right.order,
    );
  const frameBudget = Math.max(0, AUTH_MENU_DIAGNOSTIC_MAX_SCOPES - 1);
  if (ordered.length > frameBudget) truncated = true;
  return {
    scopes: [
      ...ordered.slice(0, frameBudget),
      { scope, frameName: "page", order: Number.MAX_SAFE_INTEGER },
    ],
    truncated,
  };
}

async function readScopeAnchors(
  scope: DiagnosticScope,
  maxAnchors: number,
): Promise<{
  anchors: AuthMenuAnchorSnapshot[];
  inspectedAnchorCount: number;
  anchorCount: number;
  truncated: boolean;
}> {
  const maybeScope = scope.scope as BrowserScope & {
    locator?: (selector: string) => Locator;
  };
  if (typeof maybeScope.locator !== "function") {
    return { anchors: [], inspectedAnchorCount: 0, anchorCount: 0, truncated: false };
  }

  let links: Locator;
  try {
    links = maybeScope.locator("a");
  } catch {
    return { anchors: [], inspectedAnchorCount: 0, anchorCount: 0, truncated: true };
  }
  let totalCount = 0;
  try {
    const count = await links.count();
    if (!Number.isFinite(count) || count < 0) {
      return { anchors: [], inspectedAnchorCount: 0, anchorCount: 0, truncated: true };
    }
    totalCount = Math.floor(count);
  } catch {
    return { anchors: [], inspectedAnchorCount: 0, anchorCount: 0, truncated: true };
  }

  const safeBudget = Math.max(0, Math.floor(maxAnchors));
  const count = Math.min(totalCount, safeBudget);
  let truncated = totalCount > count;
  const anchors: AuthMenuAnchorSnapshot[] = [];
  for (let index = 0; index < count; index += 1) {
    let link: Locator;
    try {
      link = links.nth(index);
    } catch {
      truncated = true;
      continue;
    }
    let visible = false;
    try {
      visible = await link.isVisible();
    } catch {
      truncated = true;
      continue;
    }
    if (!visible) continue;

    const maybeInnerText = link as Locator & {
      innerText?: () => Promise<string>;
    };
    const read = async (name: string): Promise<string | null> => {
      try {
        return await link.getAttribute(name);
      } catch {
        truncated = true;
        return null;
      }
    };

    let label: string | null = null;
    try {
      label =
        typeof maybeInnerText.innerText === "function"
          ? await maybeInnerText.innerText()
          : await link.textContent();
    } catch {
      truncated = true;
    }
    const ariaLabel = await read("aria-label");
    const title = await read("title");
    const dataLabel = await read("data-label");
    const dataMenuLabel = await read("data-menu-label");
    let imageAlt: string | null = null;
    const maybeLocator = link as Locator & {
      locator?: (selector: string) => Locator;
    };
    if (typeof maybeLocator.locator === "function") {
      try {
        imageAlt = await maybeLocator
          .locator("img")
          .first()
          .getAttribute("alt");
      } catch {
        truncated = true;
      }
    }
    anchors.push({
      label,
      ariaLabel,
      title,
      imageAlt,
      dataLabel,
      dataMenuLabel,
      href: await read("href"),
      onclick: await read("onclick"),
      action: await read("data-action"),
      task: (await read("data-task")) ?? (await read("data-task-id")),
      menu: (await read("data-menu")) ?? (await read("data-menu-id")),
      id: await read("id"),
      visible,
      frameName: scope.frameName,
    });
  }
  return { anchors, inspectedAnchorCount: count, anchorCount: totalCount, truncated };
}

/**
 * Read repayment-related anchors from the page and all nested frames.  This
 * function performs only locator reads; it never clicks, navigates, evaluates
 * page JavaScript, or fetches network resources.
 */
export async function collectAuthMenuDiagnostic(
  scope: BrowserScope,
  options: {
    provider: AuthMenuDiagnosticProvider;
    contractVersion: string;
  },
): Promise<AuthMenuDiagnosticEvent> {
  const enumeration = enumerateScopes(scope);
  const anchors: AuthMenuAnchorSnapshot[] = [];
  const frameSummaries: AuthMenuFrameSummary[] = [];
  let inspectedAnchorCount = 0;
  let truncated = enumeration.truncated;
  for (const [scopeIndex, candidateScope] of enumeration.scopes.entries()) {
    const remaining = AUTH_MENU_DIAGNOSTIC_MAX_ANCHORS - inspectedAnchorCount;
    const result = await readScopeAnchors(
      candidateScope,
      Math.max(
        0,
        Math.min(AUTH_MENU_DIAGNOSTIC_MAX_ANCHORS_PER_SCOPE, remaining),
      ),
    ).catch(() => ({
      anchors: [],
      inspectedAnchorCount: 0,
      anchorCount: 0,
      truncated: true,
    }));
    anchors.push(...result.anchors);
    frameSummaries.push({
      frameName: candidateScope.frameName,
      anchorCount: result.anchorCount,
    });
    // Keep collecting frame summaries after the global candidate-read budget
    // is exhausted. The count is useful evidence that a known fmain/fmenu was
    // present, while readScopeAnchors(0) guarantees no unbounded DOM work.
    if (remaining <= 0) {
      truncated = true;
      continue;
    }
    inspectedAnchorCount += result.inspectedAnchorCount;
    truncated ||= result.truncated;
    if (
      inspectedAnchorCount >= AUTH_MENU_DIAGNOSTIC_MAX_ANCHORS &&
      scopeIndex < enumeration.scopes.length - 1
    ) {
      truncated = true;
      break;
    }
  }
  return buildAuthMenuDiagnosticEvent(
    options.provider,
    anchors,
    options.contractVersion,
    { truncated, frameSummaries },
  );
}

function emptyDiagnosticEvent(
  provider: AuthMenuDiagnosticProvider,
  contractVersion: string,
  evidenceStopReason: AuthMenuDiagnosticEvent["evidenceStopReason"],
): AuthMenuDiagnosticEvent {
  return {
    event: AUTH_MENU_DIAGNOSTIC_EVENT,
    provider,
    contractVersion: safeContractVersion(contractVersion),
    source: "authenticated-menu",
    readMode: "dom-only",
    observedAnchorCount: 0,
    truncated: false,
    maskedAccountObserved: false,
    evidenceUsable: false,
    evidenceStopReason,
    frameSummaries: [],
    candidates: [],
  };
}

/** Wait for an auth marker without navigating or holding for human input. */
export async function waitForAuthMenuReadiness(
  isReady: () => Promise<boolean>,
  waitForTimeout: (timeoutMs: number) => Promise<void>,
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
  } = {},
): Promise<boolean> {
  const timeoutMs = Math.max(
    0,
    Math.floor(options.timeoutMs ?? AUTH_MENU_DIAGNOSTIC_DEFAULT_READY_TIMEOUT_MS),
  );
  const pollIntervalMs = Math.max(
    1,
    Math.floor(options.pollIntervalMs ?? AUTH_MENU_DIAGNOSTIC_READY_POLL_INTERVAL_MS),
  );
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await isReady().catch(() => false)) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await waitForTimeout(Math.min(pollIntervalMs, remaining));
  }
}

export function authMenuDiagnosticDirectoryFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment[AUTH_MENU_DIAGNOSTIC_DIRECTORY_ENV]?.trim();
  return resolve(
    configured || join(process.cwd(), "data", "automation", "diagnostics", "auth-menu"),
  );
}

function privateMode(mode: number): boolean {
  return (mode & 0o077) === 0;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // mkdir's mode is ignored for an already-existing directory. Tighten a
  // reused workspace directory before placing a screenshot in it.
  await chmod(directory, 0o700);
  const metadata = await stat(directory);
  if (!metadata.isDirectory() || !privateMode(metadata.mode)) {
    throw new Error("Auth menu diagnostic directory must be private.");
  }
}

/** Save a full-page menu screenshot as a private local diagnostic artifact. */
export async function captureAuthMenuScreenshot(
  page: Page,
  provider: AuthMenuDiagnosticProvider,
  directory = authMenuDiagnosticDirectoryFromEnvironment(),
): Promise<string> {
  let destination = resolve(directory);
  try {
    await ensurePrivateDirectory(destination);
  } catch {
    // The desktop runner may launch the workflow with a packaged/read-only
    // cwd. Keep the default artifact local and private, but do not silently
    // override an explicitly configured diagnostic directory.
    const configured = process.env[AUTH_MENU_DIAGNOSTIC_DIRECTORY_ENV]?.trim();
    if (configured || destination !== authMenuDiagnosticDirectoryFromEnvironment({})) {
      throw new AuthMenuScreenshotError("filesystem-failed");
    }
    destination = resolve(join(tmpdir(), "octopus-beak", "auth-menu"));
    try {
      await ensurePrivateDirectory(destination);
    } catch {
      throw new AuthMenuScreenshotError("filesystem-failed");
    }
  }
  const filePath = join(
    destination,
    `${provider}-auth-menu-${Date.now()}-${randomUUID()}.png`,
  );
  try {
    await page.screenshot({ path: filePath, type: "png" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    throw new AuthMenuScreenshotError(
      /(?:target page|browser context|page|context)\s*(?:has been )?closed|detached/iu.test(
        message,
      )
        ? "page-unavailable"
        : "capture-failed",
    );
  }
  try {
    // Playwright creates files according to the process umask. Normalize the
    // final artifact explicitly so a permissive umask cannot make this
    // diagnostic world-readable.
    await chmod(filePath, 0o600);
  } catch {
    throw new AuthMenuScreenshotError("filesystem-failed");
  }
  let metadata: Awaited<ReturnType<typeof stat>>;
  try {
    metadata = await stat(filePath);
  } catch {
    throw new AuthMenuScreenshotError("filesystem-failed");
  }
  if (!metadata.isFile() || !privateMode(metadata.mode)) {
    throw new AuthMenuScreenshotError("filesystem-failed");
  }
  return filePath;
}

class AuthMenuScreenshotError extends Error {
  readonly status: Exclude<AuthMenuScreenshotStatus, "captured">;

  constructor(status: Exclude<AuthMenuScreenshotStatus, "captured">) {
    super("Auth menu diagnostic screenshot was not captured.");
    this.name = "AuthMenuScreenshotError";
    this.status = status;
  }
}

export function emitAuthMenuDiagnostic(
  output: AuthMenuDiagnosticOutput,
): void {
  console.log(AUTH_MENU_DIAGNOSTIC_EVENT, JSON.stringify(output));
}

export async function executeAuthMenuDiagnostic(options: {
  page: Page;
  provider: AuthMenuDiagnosticProvider;
  contractVersion: string;
  authenticate: () => Promise<void>;
  isReady: () => Promise<boolean>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  prepareMenu?: () => Promise<void>;
  collect?: () => Promise<AuthMenuDiagnosticEvent>;
  captureScreenshot?: () => Promise<string>;
}): Promise<AuthMenuDiagnosticOutput> {
  try {
    await options.authenticate();
  } catch {
    const output: AuthMenuDiagnosticOutput = {
      ...emptyDiagnosticEvent(
        options.provider,
        options.contractVersion,
        "authentication-failed",
      ),
      authentication: "failed",
      readiness: "not-checked",
      screenshotPath: null,
      screenshotStatus: "page-unavailable",
    };
    emitAuthMenuDiagnostic(output);
    return output;
  }

  const ready = await waitForAuthMenuReadiness(
    options.isReady,
    async (timeoutMs) => await options.page.waitForTimeout(timeoutMs),
    { timeoutMs: options.timeoutMs, pollIntervalMs: options.pollIntervalMs },
  );
  if (!ready) {
    let screenshotPath: string | null = null;
    let screenshotStatus: AuthMenuScreenshotStatus = "page-unavailable";
    try {
      screenshotPath =
        (await options.captureScreenshot?.()) ??
        (await captureAuthMenuScreenshot(options.page, options.provider));
      screenshotStatus = "captured";
    } catch (error) {
      screenshotStatus =
        error instanceof AuthMenuScreenshotError
          ? error.status
          : "capture-failed";
    }
    const output: AuthMenuDiagnosticOutput = {
      ...emptyDiagnosticEvent(
        options.provider,
        options.contractVersion,
        "menu-incomplete",
      ),
      authentication: "succeeded",
      readiness: "timed-out",
      screenshotPath,
      screenshotStatus,
    };
    emitAuthMenuDiagnostic(output);
    return output;
  }

  let event: AuthMenuDiagnosticEvent;
  try {
    await options.prepareMenu?.();
    event =
      (await options.collect?.()) ??
      (await collectAuthMenuDiagnostic(options.page, {
        provider: options.provider,
        contractVersion: options.contractVersion,
      }));
  } catch {
    event = emptyDiagnosticEvent(
      options.provider,
      options.contractVersion,
      "menu-incomplete",
    );
    event = { ...event, truncated: true };
  }

  let screenshotPath: string | null = null;
  let screenshotStatus: AuthMenuScreenshotStatus = "page-unavailable";
  try {
    screenshotPath =
      (await options.captureScreenshot?.()) ??
      (await captureAuthMenuScreenshot(options.page, options.provider));
    screenshotStatus = "captured";
  } catch (error) {
    // Keep the candidate event useful when a provider closes the page just
    // after readiness. The output never includes the browser's raw error.
    screenshotStatus =
      error instanceof AuthMenuScreenshotError
        ? error.status
        : "capture-failed";
  }

  const output: AuthMenuDiagnosticOutput = {
    ...event,
    authentication: "succeeded",
    readiness: "ready",
    screenshotPath,
    screenshotStatus,
  };
  emitAuthMenuDiagnostic(output);
  return output;
}
