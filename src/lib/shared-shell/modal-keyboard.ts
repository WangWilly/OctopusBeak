export type ModalKeyEvent = Readonly<{ key: string; defaultPrevented: boolean; isComposing?: boolean }>;

/**
 * Escape closes a dialog unless it is busy, something inside already handled the key, or an input
 * method is still composing (Escape then cancels the composition, not the dialog).
 */
export function closesOnKey(event: ModalKeyEvent, closable: boolean): boolean {
  return closable && event.key === "Escape" && !event.defaultPrevented && !event.isComposing;
}

type Focusable = { focus(): void; isConnected: boolean };

/** The element focused before the dialog opened, while it is still on the page. */
export function focusReturnTarget(previous: unknown): Focusable | null {
  if (typeof previous !== "object" || previous === null) return null;
  const candidate = previous as Partial<Focusable>;
  return typeof candidate.focus === "function" && candidate.isConnected === true ? candidate as Focusable : null;
}
