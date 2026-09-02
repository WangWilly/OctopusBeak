import type { Frame, Locator, Page } from "playwright";

/**
 * This contract describes the small, post-authentication menu probe used by
 * the combined bank workflows. It is deliberately separate from statement
 * extraction: the probe only reads visible anchors and never activates them.
 */
export const REPAYMENT_ROUTE_INVENTORY_EVENT =
  "bank-repayment-route-inventory" as const;
export const REPAYMENT_ROUTE_INVENTORY_CONTRACT_VERSION =
  "bank-repayment-route-inventory/v1" as const;
export const FUBON_REPAYMENT_ROUTE_INVENTORY_CONTRACT_VERSION =
  "fubon/post-auth-repayment-route-inventory/v1" as const;
export const YUANTA_REPAYMENT_ROUTE_INVENTORY_CONTRACT_VERSION =
  "yuanta/post-auth-repayment-route-inventory/v1" as const;

export const MAX_REPAYMENT_ROUTE_ANCHORS = 256;
export const MAX_REPAYMENT_ROUTE_ANCHORS_PER_SCOPE = 128;
export const MAX_REPAYMENT_ROUTE_SCOPES = 64;
export const MAX_REPAYMENT_ROUTE_CANDIDATES = 64;
const MAX_LABEL_LENGTH = 120;
const MAX_PATHNAME_LENGTH = 160;
const MAX_ACTION_LENGTH = 80;

export type RepaymentRouteProvider = "fubon" | "yuanta";

export type RepaymentRouteCategory =
  | "loan"
  | "repayment"
  | "autodebit"
  | "detail"
  | "transaction";

/** Raw values are short-lived DOM snapshots and are never emitted directly. */
export type RepaymentRouteAnchorSnapshot = {
  label?: string | null;
  href?: string | null;
  onclick?: string | null;
  action?: string | null;
  visible?: boolean;
};

export type SanitizedRepaymentRouteCandidate = {
  category: RepaymentRouteCategory;
  label: string;
  pathname: string | null;
  actionId: string | null;
  maskedLabel: boolean;
};

export type RepaymentRouteInventoryEvent = {
  event: typeof REPAYMENT_ROUTE_INVENTORY_EVENT;
  provider: RepaymentRouteProvider;
  contractVersion: string;
  source: "post-authenticated-menu";
  readMode: "dom-only";
  observedAnchorCount: number;
  truncated: boolean;
  candidates: readonly SanitizedRepaymentRouteCandidate[];
};

type BrowserScope = Page | Frame;

const MASKED_LABEL_PATTERN =
  /(?:\*{2,}|•{2,}|·{2,}|x{3,}|遮罩|masked|redacted)/iu;
const ACCOUNT_TOKEN_PATTERN =
  /\b(?:[A-Z]{2,}[A-Z0-9_-]*\d[A-Z0-9_-]*|\d{4,})\b/giu;
const SENSITIVE_TOKEN_PATTERN =
  /\b(?:account|cid|otp|password|passwd|secret)\b/giu;

function normalizeLabel(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_LABEL_LENGTH);
}

function sanitizeLabel(value: string): {
  label: string;
  maskedLabel: boolean;
} {
  const normalized = normalizeLabel(value);
  const maskedLabel = MASKED_LABEL_PATTERN.test(normalized);
  const label = normalized
    .replace(/(?:\*{2,}|•{2,}|·{2,}|x{3,}|遮罩|masked|redacted)/giu, "[masked]")
    .replace(ACCOUNT_TOKEN_PATTERN, "[redacted]")
    .replace(/\d+/gu, "[redacted]")
    .replace(SENSITIVE_TOKEN_PATTERN, "[redacted]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_LABEL_LENGTH);
  return { label, maskedLabel };
}

function categoryForLabel(label: string): RepaymentRouteCategory | null {
  if (
    /(?:自動\s*扣繳|自動\s*扣款|auto(?:matic)?\s*(?:debit|payment)|autopay|direct\s*debit)/iu.test(
      label,
    )
  ) {
    return "autodebit";
  }
  if (/(?:貸款|loan)/iu.test(label)) return "loan";
  if (/(?:還款|繳款|繳費|扣繳|扣款|repay(?:ment)?|payment)/iu.test(label)) {
    return "repayment";
  }
  if (/(?:明細|detail)/iu.test(label)) return "detail";
  if (/(?:交易|transaction|history)/iu.test(label)) return "transaction";
  return null;
}

function sanitizePathname(value: string | null | undefined): string | null {
  const raw = value?.trim() ?? "";
  if (!raw || raw === "#" || /^(?:javascript|data|mailto):/iu.test(raw)) {
    return null;
  }

  let pathname: string;
  try {
    pathname = new URL(raw, "https://repayment-route.invalid").pathname;
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

      // A route segment containing digits may be a CID, account, or opaque
      // provider identifier. Keep the route shape, but never expose it.
      if (
        /\d/u.test(decoded) ||
        /^(?:account|cid|otp|password|passwd|secret)$/iu.test(decoded) ||
        decoded.length > 80 ||
        !/^[\p{L}._~-]+$/u.test(decoded)
      ) {
        return ":redacted";
      }
      return decoded;
    })
    .join("/");

  return safePath.slice(0, MAX_PATHNAME_LENGTH) || "/";
}

function sanitizeActionIdentifier(
  value: string | null | undefined,
): string | null {
  const raw = value?.trim() ?? "";
  if (!raw) return null;

  // Keep only a static handler name. In particular, do not preserve the
  // onclick body or its arguments, which commonly contain CIDs or accounts.
  const handlerMatch = raw.match(
    /^(?:javascript:\s*)?(?:return\s+)?([A-Za-z_$][\w$]*)\s*(?:\(|;|$)/u,
  );
  if (handlerMatch?.[1]) {
    const handler = handlerMatch[1]
      .replace(/\d+/gu, "")
      .replace(/[^A-Za-z_$-]/gu, "")
      .slice(0, MAX_ACTION_LENGTH);
    return handler ? `handler:${handler}` : "handler:present";
  }

  // A data-action-like token is useful as a route hint only when it contains
  // no digits or punctuation that could be an opaque provider identifier.
  if (/^[A-Za-z][A-Za-z_-]{0,63}$/u.test(raw)) {
    if (/^(?:account|cid|otp|password|passwd|secret)$/iu.test(raw)) {
      return "action:present";
    }
    return `action:${raw.slice(0, MAX_ACTION_LENGTH)}`;
  }
  return "action:present";
}

function candidateKey(candidate: SanitizedRepaymentRouteCandidate): string {
  return [
    candidate.category,
    candidate.label,
    candidate.pathname ?? "",
    candidate.actionId ?? "",
    candidate.maskedLabel ? "masked" : "plain",
  ].join("\u0000");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toCandidate(
  anchor: RepaymentRouteAnchorSnapshot,
): SanitizedRepaymentRouteCandidate | null {
  if (anchor.visible === false) return null;
  const rawLabel = typeof anchor.label === "string" ? anchor.label : "";
  const normalizedLabel = normalizeLabel(rawLabel);
  const category = categoryForLabel(normalizedLabel);
  if (!category) return null;

  const { label, maskedLabel } = sanitizeLabel(rawLabel);
  if (!label) return null;
  const pathname = sanitizePathname(anchor.href);
  const actionId = sanitizeActionIdentifier(anchor.action ?? anchor.onclick);
  if (!pathname && !actionId) return null;
  return { category, label, pathname, actionId, maskedLabel };
}

/**
 * Convert short-lived anchor snapshots into a bounded, deterministic event.
 * This pure seam is also used by checks with sanitized provider fixtures.
 */
export function buildRepaymentRouteInventory(
  provider: RepaymentRouteProvider,
  anchors: readonly RepaymentRouteAnchorSnapshot[],
  contractVersion: string,
): RepaymentRouteInventoryEvent {
  const boundedAnchors = anchors.slice(0, MAX_REPAYMENT_ROUTE_ANCHORS);
  const candidates = new Map<string, SanitizedRepaymentRouteCandidate>();
  for (const anchor of boundedAnchors) {
    const candidate = toCandidate(anchor);
    if (candidate) candidates.set(candidateKey(candidate), candidate);
  }

  const sortedCandidates = [...candidates.values()].sort((left, right) => {
    for (const [leftValue, rightValue] of [
      [left.category, right.category],
      [left.label, right.label],
      [left.pathname ?? "", right.pathname ?? ""],
      [left.actionId ?? "", right.actionId ?? ""],
    ]) {
      const comparison = compareStrings(leftValue, rightValue);
      if (comparison !== 0) return comparison;
    }
    return Number(left.maskedLabel) - Number(right.maskedLabel);
  });

  const safeContractVersion = contractVersion
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._/-]/gu, "")
    .slice(0, MAX_ACTION_LENGTH);

  return {
    event: REPAYMENT_ROUTE_INVENTORY_EVENT,
    provider,
    contractVersion: safeContractVersion || REPAYMENT_ROUTE_INVENTORY_CONTRACT_VERSION,
    source: "post-authenticated-menu",
    readMode: "dom-only",
    observedAnchorCount: boundedAnchors.length,
    truncated: anchors.length > boundedAnchors.length,
    candidates: sortedCandidates.slice(0, MAX_REPAYMENT_ROUTE_CANDIDATES),
  };
}

async function readScopeAnchors(
  scope: BrowserScope,
  maxAnchors: number,
): Promise<{
  anchors: RepaymentRouteAnchorSnapshot[];
  inspectedAnchorCount: number;
  truncated: boolean;
}> {
  const maybeScope = scope as BrowserScope & {
    locator?: (selector: string) => Locator;
  };
  if (typeof maybeScope.locator !== "function") {
    return { anchors: [], inspectedAnchorCount: 0, truncated: false };
  }

  let links: Locator;
  try {
    links = maybeScope.locator("a");
  } catch {
    return { anchors: [], inspectedAnchorCount: 0, truncated: true };
  }
  let totalCount = 0;
  try {
    const observedCount = await links.count();
    if (!Number.isFinite(observedCount) || observedCount < 0) {
      return { anchors: [], inspectedAnchorCount: 0, truncated: true };
    }
    totalCount = Math.floor(observedCount);
  } catch {
    // A frame can detach while authentication replaces the bank shell. The
    // inventory remains useful, but it must truthfully mark that scope as
    // incomplete without exposing the provider's raw error or URL.
    return { anchors: [], inspectedAnchorCount: 0, truncated: true };
  }
  const safeBudget = Math.max(0, Math.floor(maxAnchors));
  const count = Math.min(totalCount, safeBudget);
  let truncated = totalCount > count;
  const anchors: RepaymentRouteAnchorSnapshot[] = [];
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
    let label: string | null = null;
    try {
      label =
        typeof maybeInnerText.innerText === "function"
          ? await maybeInnerText.innerText()
          : await link.textContent();
    } catch {
      truncated = true;
    }

    let href: string | null = null;
    try {
      href = await link.getAttribute("href");
    } catch {
      truncated = true;
    }

    let onclick: string | null = null;
    try {
      onclick = await link.getAttribute("onclick");
    } catch {
      truncated = true;
    }

    let action: string | null = null;
    try {
      action = await link.getAttribute("data-action");
    } catch {
      truncated = true;
    }

    anchors.push({
      label,
      href,
      onclick,
      action,
    });
  }
  return { anchors, inspectedAnchorCount: count, truncated };
}

type ScopeEnumeration = {
  scopes: BrowserScope[];
  truncated: boolean;
};

function framePriority(frame: Frame): number {
  // Yuanta keeps its authenticated product menu in `fmenu`. Prefer that
  // frame when a provider shell contains many unrelated anchors, while still
  // inspecting every other frame that fits the bounded scope budget.
  try {
    return frame.name().toLowerCase() === "fmenu" ? 0 : 1;
  } catch {
    return 1;
  }
}

function scopesFor(scope: BrowserScope): ScopeEnumeration {
  const maybePage = scope as Page & {
    frames?: () => Frame[];
    mainFrame?: () => Frame;
  };
  const maybeFrame = scope as Frame & {
    childFrames?: () => Frame[];
  };
  const frames: Frame[] = [];
  const seen = new Set<Frame>();
  let truncated = false;

  const appendFrameChildren = (frame: Frame): void => {
    const nestedFrame = frame as Frame & {
      childFrames?: () => Frame[];
    };
    if (typeof nestedFrame.childFrames !== "function") return;
    let children: Frame[];
    try {
      children = nestedFrame.childFrames();
    } catch {
      // Detached/cross-origin frame state is expected during bank shell
      // transitions. Keep the rest of the inventory and mark it incomplete.
      truncated = true;
      return;
    }
    for (const child of children) appendFrameTree(child);
  };

  const appendFrameTree = (frame: Frame): void => {
    if (seen.has(frame)) return;
    seen.add(frame);
    frames.push(frame);
    appendFrameChildren(frame);
  };

  if (typeof maybePage.frames === "function") {
    let pageFrames: Frame[];
    try {
      pageFrames = maybePage.frames();
    } catch {
      return { scopes: [scope], truncated: true };
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
      // Page.locator("a") covers the top-level document. Playwright's
      // frames() also includes mainFrame(), so reading it separately would
      // duplicate anchors and consume the global budget twice.
      if (mainFrame && frame === mainFrame) {
        // A lightweight test double, and some browser adapters, may expose
        // only the main frame from frames(). Still walk its descendants while
        // keeping the top-level document represented by the Page scope.
        appendFrameChildren(frame);
        continue;
      }
      appendFrameTree(frame);
    }
  } else if (typeof maybeFrame.childFrames === "function") {
    appendFrameTree(scope as Frame);
  }

  const orderedFrames = frames
    .map((frame, index) => ({ frame, index, priority: framePriority(frame) }))
    .sort(
      (left, right) =>
        left.priority - right.priority || left.index - right.index,
    )
    .map(({ frame }) => frame);
  const frameBudget = Math.max(0, MAX_REPAYMENT_ROUTE_SCOPES - 1);
  if (orderedFrames.length > frameBudget) truncated = true;

  // Inspect child frames before the page root so a large shell document does
  // not starve an authenticated product menu of the global anchor budget.
  return {
    scopes: [...orderedFrames.slice(0, frameBudget), scope],
    truncated,
  };
}

/**
 * Read visible anchors from the authenticated page and its frames. The only
 * browser operations here are locator reads; this helper never clicks,
 * navigates, submits forms, or fetches network resources.
 */
export async function collectRepaymentRouteInventory(
  scope: BrowserScope,
  options: {
    provider: RepaymentRouteProvider;
    contractVersion: string;
  },
): Promise<RepaymentRouteInventoryEvent> {
  const anchors: RepaymentRouteAnchorSnapshot[] = [];
  const enumeration = scopesFor(scope);
  let truncated = enumeration.truncated;
  let inspectedAnchorCount = 0;
  for (const [scopeIndex, candidateScope] of enumeration.scopes.entries()) {
    const remainingBudget =
      MAX_REPAYMENT_ROUTE_ANCHORS - inspectedAnchorCount;
    if (remainingBudget <= 0) {
      truncated = true;
      break;
    }

    const result = await readScopeAnchors(
      candidateScope,
      Math.min(MAX_REPAYMENT_ROUTE_ANCHORS_PER_SCOPE, remainingBudget),
    ).catch(() => ({
      anchors: [],
      inspectedAnchorCount: 0,
      truncated: true,
    }));
    anchors.push(...result.anchors);
    inspectedAnchorCount += result.inspectedAnchorCount;
    truncated ||= result.truncated;
    if (
      inspectedAnchorCount >= MAX_REPAYMENT_ROUTE_ANCHORS &&
      scopeIndex < enumeration.scopes.length - 1
    ) {
      truncated = true;
      break;
    }
  }
  const inventory = buildRepaymentRouteInventory(
    options.provider,
    anchors,
    options.contractVersion,
  );
  return truncated ? { ...inventory, truncated: true } : inventory;
}

/** Emit only the already-sanitized, versioned inventory event. */
export function emitRepaymentRouteInventory(
  inventory: RepaymentRouteInventoryEvent,
): void {
  // Keep the workflow-output line machine-readable while retaining the event
  // name as the stable grep/UI marker.
  console.log(REPAYMENT_ROUTE_INVENTORY_EVENT, JSON.stringify(inventory));
}
