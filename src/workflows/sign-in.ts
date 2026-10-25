import { errors, type Dialog, type Frame, type Locator, type Page } from "playwright";
import { CaptchaProviderRejectedError } from "../lib/automation/captcha-rejection.ts";
import { ProductCollectionFatalError } from "../lib/automation/product-collection.ts";
import {
  matchesRejectionDialog,
  matchesTakeoverDialog,
  type Control,
  type DialogSnapshot,
  type PageMatch,
  type RejectionEvidence,
  type TakeoverPrompt,
} from "../lib/automation/sign-in-prompt.ts";
import type { SessionTakeover } from "../lib/automation/types.ts";
import { VerificationStageIncompleteError, type VerificationStage } from "../lib/automation/verification-stage.ts";
import type { WorkflowContext } from "../lib/automation/workflow-executor.ts";
import { withAbort } from "./abort.ts";

export type Probe = (page: Page, signal: AbortSignal) => Promise<boolean>;
export type Act = (page: Page, signal: AbortSignal) => Promise<void>;

export type DialogDecision = "accept" | "dismiss" | "fail" | Error;

/**
 * What the step does with a dialog that is neither the declared takeover nor
 * the declared rejection. `fail` dismisses it and ends the sign-in as a dialog
 * interruption; `dismiss` and `accept` answer it and keep waiting;
 * `accept-for-page` also keeps accepting after sign-in, for the page's life.
 * An observer sees a snapshot, never the dialog, and decides per dialog.
 */
export type DialogPolicy =
  | "fail"
  | "dismiss"
  | "accept"
  | "accept-for-page"
  | ((dialog: DialogSnapshot) => DialogDecision);

/** How collection later checks the session is still live, or why it cannot. */
export type SessionProbe = Probe | Readonly<{ none: string }>;

export type FormPlan = Readonly<{
  /** True on the signed-in page. May throw a typed error to end the sign-in. */
  signedIn: Probe;
  /** Navigates when needed. Runs again after a before-submit takeover. */
  fill: Act;
  captcha?: Readonly<{
    stage(page: Page): VerificationStage | Promise<VerificationStage>;
    answer(page: Page): Locator;
  }>;
  submit: Act;
  /** Routine prompts that are not a takeover; true when it acted on one. */
  prompts?: Probe;
  dialogs: DialogPolicy;
  session: SessionProbe;
  /** From submit to a settled sign-in. Default 120 s; a confirmed takeover restarts it once. */
  timeoutMs?: number;
}>;

/** A source whose sign-in flow stays its own; the step owns only the bracket, the dialogs and cancellation. */
export type ShellPlan = Readonly<{
  own: Act;
  signedIn?: Probe;
  dialogs: DialogPolicy;
  session: SessionProbe;
}>;

export type SignInPlan = FormPlan | ShellPlan;

/** The facts the step reads from the Verified source definition. */
export type SignInSource = Readonly<{
  sessionTakeover?: SessionTakeover;
  workflow: Readonly<{ verification?: Readonly<{ rejection?: RejectionEvidence }> }>;
}>;

export type SignedIn = Readonly<{
  usedExistingSession: boolean;
  assertSession?: () => Promise<void>;
}>;

export type SignInFailure = "dialog-interrupted" | "takeover-repeated" | "answer-missing";

const SIGN_IN_FAILURE_MESSAGES: Readonly<Record<SignInFailure, string>> = {
  "dialog-interrupted": "Sign-in was interrupted by a browser dialog.",
  "takeover-repeated": "The provider asked to take over the session a second time.",
  "answer-missing": "The Verification stage completed, but no answer was entered.",
};

export class SignInError extends Error {
  readonly reason: SignInFailure;

  constructor(reason: SignInFailure) {
    super(SIGN_IN_FAILURE_MESSAGES[reason]);
    this.name = "SignInError";
    this.reason = reason;
  }
}

const TICK_MS = 250;
const SETTLE_MS = 2_000;
const CLOSE_TIMEOUT_MS = 500;
const PRE_SUBMIT_PROMPT_MS = 1_500;
const PROMPT_HIDDEN_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Sign a browser-driven Verified source in. The step owns the dialog listener
 * and its classification (takeover, then rejection, then policy), the
 * at-most-once Session takeover, the Verification stage hand-off, the poll
 * and deadline, cancellation, and the authentication event bracket.
 */
export async function signIn(
  context: WorkflowContext,
  page: Page,
  source: SignInSource,
  plan: SignInPlan,
): Promise<SignedIn> {
  const run = context.signal;
  run.throwIfAborted();
  await context.event("authentication", "started", "authentication-started");
  const attempt = new Attempt(context, page, source, plan);
  try {
    const signedIn = await attempt.run();
    await context.event("authentication", "completed", "authentication-completed");
    return signedIn;
  } catch (error) {
    if (run.aborted) throw run.reason;
    if (error instanceof VerificationStageIncompleteError) throw error;
    if (error instanceof CaptchaProviderRejectedError) {
      await context.event("authentication", "failed", "captcha-rejected");
    } else if (error instanceof SignInError && error.reason !== "answer-missing") {
      await context.signalEvent("login-dialog-interrupted");
    } else {
      await context.event("authentication", "failed", "authentication-failed");
    }
    throw error;
  } finally {
    attempt.end();
  }
}

type Scope = Page | Frame | Locator;

class Attempt {
  private readonly context: WorkflowContext;
  private readonly page: Page;
  private readonly source: SignInSource;
  private readonly plan: SignInPlan;
  private readonly ended = new AbortController();
  /** Ends with the run or with this attempt, whichever comes first. */
  private readonly signal: AbortSignal;
  private verdict: Error | undefined;
  private interrupt!: (error: Error) => void;
  private readonly interrupted: Promise<never>;
  private takeovers = 0;
  private restartDeadline: (() => void) | undefined;
  /** Dialogs are handled in arrival order, so the first one decides the outcome. */
  private dialogs: Promise<void> = Promise.resolve();
  private readonly onDialog = (dialog: Dialog): void => {
    this.dialogs = this.dialogs.then(() => this.handleDialog(dialog)).catch(() => undefined);
  };

  constructor(context: WorkflowContext, page: Page, source: SignInSource, plan: SignInPlan) {
    this.context = context;
    this.page = page;
    this.source = source;
    this.plan = plan;
    this.signal = AbortSignal.any([context.signal, this.ended.signal]);
    this.interrupted = new Promise<never>((_resolve, reject) => {
      this.interrupt = reject;
    });
    void this.interrupted.catch(() => undefined);
  }

  async run(): Promise<SignedIn> {
    const existing = this.plan.signedIn;
    if (existing && await this.raced(existing(this.page, this.signal))) return this.finish(true);
    this.page.on("dialog", this.onDialog);
    if ("own" in this.plan) await this.runShell(this.plan);
    else await this.runForm(this.plan);
    return this.finish(false);
  }

  end(): void {
    this.ended.abort();
    this.page.off("dialog", this.onDialog);
  }

  private finish(usedExistingSession: boolean): SignedIn {
    this.page.off("dialog", this.onDialog);
    if (this.plan.dialogs === "accept-for-page") this.page.on("dialog", acceptForPage);
    const session = this.plan.session;
    if ("none" in session) return { usedExistingSession };
    return {
      usedExistingSession,
      assertSession: async () => {
        if (!(await session(this.page, this.context.signal))) {
          throw new ProductCollectionFatalError("authentication-failed");
        }
      },
    };
  }

  private async runForm(plan: FormPlan): Promise<void> {
    await this.fillForm(plan);
    const captcha = plan.captcha;
    if (captcha) {
      const stage = await this.raced(Promise.resolve().then(() => captcha.stage(this.page)));
      // Never abandon a pending stage: a dialog verdict waits until the port returns.
      await this.context.verification.complete(stage);
      this.throwVerdict();
      if (!(await this.raced(plan.signedIn(this.page, this.signal)))) {
        const answer = await this.raced(captcha.answer(this.page).inputValue());
        if (answer.trim() === "") throw new SignInError("answer-missing");
        await this.raced(plan.submit(this.page, this.signal));
      }
    } else {
      await this.raced(plan.submit(this.page, this.signal));
    }
    await this.waitUntilSettled(plan);
  }

  private async runShell(plan: ShellPlan): Promise<void> {
    try {
      await this.raced(plan.own(this.page, this.signal));
    } catch (error) {
      if (this.context.signal.aborted || error === this.verdict) throw error;
      if (await this.pageRejectionVisible().catch(() => false)) throw new CaptchaProviderRejectedError();
      throw error;
    }
  }

  /** A before-submit takeover prompt follows the filled form and clears it, so fill again after confirming. */
  private async fillForm(plan: FormPlan): Promise<void> {
    const prompt = this.source.sessionTakeover?.prompt;
    const before = this.takeovers;
    await this.raced(plan.fill(this.page, this.signal));
    if (prompt?.phase !== "before-submit" || !(await this.takeoverAppears(prompt, before, PRE_SUBMIT_PROMPT_MS))) return;
    await this.raced(plan.fill(this.page, this.signal));
    await this.takeoverAppears(prompt, this.takeovers, PRE_SUBMIT_PROMPT_MS);
  }

  private async waitUntilSettled(plan: FormPlan): Promise<void> {
    const timeoutMs = plan.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let deadline = Date.now() + timeoutMs;
    this.restartDeadline = () => {
      deadline = Date.now() + timeoutMs;
    };
    let heldSince: number | undefined;
    try {
      for (;;) {
        if (await this.raced(plan.signedIn(this.page, this.signal))) {
          if (!plan.prompts) return;
          heldSince ??= Date.now();
          if (Date.now() - heldSince >= SETTLE_MS) return;
        } else {
          heldSince = undefined;
        }
        if (Date.now() >= deadline) throw new errors.TimeoutError(`Sign-in did not settle within ${timeoutMs} ms.`);
        if (plan.prompts && await this.raced(plan.prompts(this.page, this.signal))) heldSince = undefined;
        await this.checkPageTakeover();
        if (await this.pageRejectionVisible()) throw new CaptchaProviderRejectedError();
        this.throwVerdict();
        await this.raced(sleep(TICK_MS, this.signal));
      }
    } finally {
      this.restartDeadline = undefined;
    }
  }

  /** Every await of plan code ends with the run's abort reason or the first dialog verdict. */
  private async raced<T>(operation: Promise<T>): Promise<T> {
    void operation.catch(() => undefined);
    return await withAbort(Promise.race([operation, this.interrupted]), this.context.signal);
  }

  private fail(error: Error): void {
    if (this.verdict) return;
    this.verdict = error;
    this.interrupt(error);
  }

  private throwVerdict(): void {
    if (this.verdict) throw this.verdict;
  }

  private async handleDialog(dialog: Dialog): Promise<void> {
    const snapshot = snapshotOf(dialog);
    if (matchesTakeoverDialog(this.source.sessionTakeover?.prompt, snapshot)) {
      if (this.takeovers > 0) {
        await close(dialog, "dismiss");
        this.fail(new SignInError("takeover-repeated"));
        return;
      }
      // The fence is set before the accept is awaited, so a second dialog cannot slip through meanwhile.
      this.takeovers += 1;
      if (!(await close(dialog, "accept"))) {
        this.fail(new SignInError("dialog-interrupted"));
        return;
      }
      await this.reportTakeover();
      return;
    }
    if (matchesRejectionDialog(this.source.workflow.verification?.rejection, snapshot)) {
      const closed = await close(dialog, "dismiss");
      if (closed && await this.answerVisible()) {
        this.fail(new CaptchaProviderRejectedError());
        return;
      }
    }
    let decision: DialogDecision;
    try {
      decision = decide(this.plan.dialogs, snapshot);
    } catch (error) {
      decision = error instanceof Error ? error : new Error(String(error));
    }
    await close(dialog, decision === "accept" ? "accept" : "dismiss");
    if (decision === "fail") this.fail(new SignInError("dialog-interrupted"));
    else if (decision instanceof Error) this.fail(decision);
  }

  /**
   * Yuanta Bank's guard, applied to every source: a stale alert after the form
   * is gone proves nothing. A page that another dialog blocks cannot answer in
   * time, and that does not count against the alert.
   */
  private async answerVisible(): Promise<boolean> {
    const captcha = "captcha" in this.plan ? this.plan.captcha : undefined;
    if (!captcha) return true;
    return await bounded(captcha.answer(this.page).isVisible().catch(() => false), CLOSE_TIMEOUT_MS, true);
  }

  private async reportTakeover(): Promise<void> {
    this.restartDeadline?.();
    if (!this.signal.aborted) await this.context.event("authentication", "advanced", "session-takeover-confirmed");
  }

  /** Waits up to `ms` for a takeover beyond the `before` count: a dialog the listener confirms, or a page prompt this confirms. */
  private async takeoverAppears(prompt: TakeoverPrompt, before: number, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    if ("dialog" in prompt) {
      while (this.takeovers === before) {
        if (Date.now() >= deadline) return false;
        await this.raced(sleep(Math.min(TICK_MS, deadline - Date.now()), this.signal));
      }
      return true;
    }
    const text = this.pageText(prompt);
    if (!text) return false;
    const appeared = await this.raced(text.first().waitFor({ state: "visible", timeout: ms }).then(() => true, () => false));
    if (!appeared) return false;
    await this.confirmPageTakeover(prompt, text);
    return true;
  }

  private async checkPageTakeover(): Promise<void> {
    const prompt = this.source.sessionTakeover?.prompt;
    if (!prompt || "dialog" in prompt) return;
    const text = this.pageText(prompt);
    if (!text || !(await this.raced(text.first().isVisible().catch(() => false)))) return;
    await this.confirmPageTakeover(prompt, text);
  }

  private async confirmPageTakeover(prompt: Extract<TakeoverPrompt, PageMatch>, text: Locator): Promise<void> {
    if (this.takeovers > 0) throw new SignInError("takeover-repeated");
    this.takeovers += 1;
    const scope = this.scope(prompt);
    if (!scope) throw new SignInError("takeover-repeated");
    await this.raced(controlOf(scope, prompt.control).first().click());
    await this.raced(text.first().waitFor({ state: "hidden", timeout: PROMPT_HIDDEN_MS }));
    await this.reportTakeover();
  }

  private async pageRejectionVisible(): Promise<boolean> {
    const evidence = this.source.workflow.verification?.rejection;
    if (typeof evidence !== "object" || !("text" in evidence)) return false;
    const text = this.pageText(evidence);
    return text !== undefined && await this.raced(text.first().isVisible().catch(() => false));
  }

  private pageText(match: PageMatch): Locator | undefined {
    const scope = this.scope(match);
    if (!scope) return undefined;
    return "exact" in match.text
      ? scope.getByText(match.text.exact, { exact: true })
      : scope.getByText(match.text.pattern);
  }

  private scope(match: Pick<PageMatch, "frame" | "within">): Scope | undefined {
    const root = match.frame === undefined ? this.page : this.page.frame({ name: match.frame });
    if (!root) return undefined;
    return match.within === undefined ? root : root.locator(match.within);
  }
}

function controlOf(scope: Scope, control: Control): Locator {
  if ("role" in control) return scope.getByRole(control.role, { name: control.name, exact: typeof control.name === "string" });
  if ("text" in control) return scope.getByText(control.text, { exact: true });
  return scope.locator(control.selector);
}

function decide(policy: DialogPolicy, dialog: DialogSnapshot): DialogDecision {
  if (typeof policy === "function") return policy(dialog);
  return policy === "accept" || policy === "accept-for-page" ? "accept" : policy;
}

const acceptForPage = (dialog: Dialog): void => {
  void dialog.accept().catch(() => undefined);
};

/** The browser may close the dialog while it is being read; an unreadable dialog is unclassified. */
function snapshotOf(dialog: Dialog): DialogSnapshot {
  try {
    return { type: dialog.type(), message: dialog.message() };
  } catch {
    return { type: "unknown", message: "" };
  }
}

/** True when the dialog closed within the bound; a dialog that lingers proves nothing. */
function close(dialog: Dialog, action: "accept" | "dismiss"): Promise<boolean> {
  const closing = Promise.resolve()
    .then(() => (action === "accept" ? dialog.accept() : dialog.dismiss()))
    .then(() => true, () => false);
  return bounded(closing, CLOSE_TIMEOUT_MS, false);
}

async function bounded<T>(operation: Promise<T>, ms: number, late: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(late), ms);
  });
  try {
    return await Promise.race([operation, expired]);
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
