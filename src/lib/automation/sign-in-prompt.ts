/** Text located on a page: Playwright's exact text match, or a pattern. */
export type TextPattern =
  | Readonly<{ exact: string }>
  | Readonly<{ pattern: RegExp }>;

/**
 * A browser dialog's message. `exact` compares after `normalizeDialogText`;
 * a pattern or predicate sees the raw message.
 */
export type TextMatch = TextPattern | ((message: string) => boolean);

/**
 * The control the step clicks to confirm a page prompt. `force` skips
 * Playwright's actionability checks, for a provider page that covers or
 * animates its own control; the click still lands on whatever is on top.
 */
export type Control = (
  | Readonly<{ role: "button"; name: string | RegExp }>
  | Readonly<{ text: string }>
  | Readonly<{ selector: string }>
) & Readonly<{ force?: true }>;

/**
 * Something visible on the page, found by its text or by a selector, in the
 * named frame and inside `within` when given.
 */
export type PageMatch = Readonly<{ frame?: string; within?: string }> & (
  | Readonly<{ text: TextPattern; selector?: never }>
  | Readonly<{ selector: string; text?: never }>
);

/**
 * `before-submit`: the prompt follows the filled form, so the step waits for
 * it and fills again after confirming. `while-settling`: it follows submit.
 */
export type TakeoverPhase = "before-submit" | "while-settling";

/** A confirm() dialog, or a page match with the control that confirms it. */
export type TakeoverPrompt =
  | Readonly<{ phase: TakeoverPhase; dialog: TextMatch }>
  | (PageMatch & Readonly<{ phase: TakeoverPhase; control: Control }>);

/**
 * How a workflow proves the provider rejected a CAPTCHA: an alert() dialog,
 * a page match, or `"workflow"` for a non-browser workflow that proves it
 * itself.
 */
export type RejectionEvidence = Readonly<{ dialog: TextMatch }> | PageMatch | "workflow";

export type DialogSnapshot = Readonly<{ type: string; message: string }>;

/** Bank dialogs differ in character width and trailing full stop between the FAQ and the live form. */
export function normalizeDialogText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/gu, "").replace(/。$/u, "");
}

export function matchesDialogText(match: TextMatch, message: string): boolean {
  if (typeof match === "function") return match(message);
  if ("exact" in match) return normalizeDialogText(message) === normalizeDialogText(match.exact);
  return match.pattern.test(message);
}

/** A takeover is asked with a confirm(); an alert() has nothing to confirm. */
export function matchesTakeoverDialog(prompt: TakeoverPrompt | undefined, dialog: DialogSnapshot): boolean {
  return prompt !== undefined && "dialog" in prompt && dialog.type === "confirm"
    && matchesDialogText(prompt.dialog, dialog.message);
}

/** A rejection is announced with an alert(); a confirm() with the same words asks something else. */
export function matchesRejectionDialog(evidence: RejectionEvidence | undefined, dialog: DialogSnapshot): boolean {
  return typeof evidence === "object" && "dialog" in evidence && dialog.type === "alert"
    && matchesDialogText(evidence.dialog, dialog.message);
}
