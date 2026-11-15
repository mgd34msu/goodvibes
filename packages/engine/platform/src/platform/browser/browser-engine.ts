import { isAdmittedBrowserAction, retainAdmittedBrowserAction, retainAdmittedBrowserWork } from './browser-action-admission.js';
import { captureOwnedJson } from '../gate/judgment-input.js';
import { isYoloExecution } from '../gate/execution-context.js';
import type { ToolExecuteOptions } from '../types/tools.js';
import { BrowserControlIdentityWork } from './browser-control-identity.js';
import type { BrowserProvisionLifetime } from './browser-failure-reading.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { resolveAndValidatePath } from '../utils/path-safety.js';
import type { Locator, Page } from 'playwright-core';
import { BrowserSessionError, BrowserSessionManager, hasDisplay } from './browser-sessions.js';
import type { BrowserAttachOptions, BrowserLaunchOptions, RestoredBrowserPage } from './browser-sessions.js';
import type { BrowserPageConnection } from './browser-page-connection-data.js';
import { captureBrowserCheckoutRecovery, type BrowserCheckoutRecovery } from './browser-checkout-recovery-data.js';
import { BrowserControlSnapshotError } from './browser-control-snapshot-data.js';
import { describeProvisionWork } from './browser-provisioning.js';
import { captureCredentialPage, captureNativeSnapshotControls, restoreControlSnapshot, retainBrowserMethods, resolveRef, snapshotCredentialEvidence, snapshotHasPasswordInput, snapshotWithheldFrames, SnapshotStore, StaleElementError, takeSnapshot, type BrowserControlAdmission } from './browser-snapshot.js';
import { containsIssuerCredential } from '../utils/redaction.js';
import { assertCaptureAllowed, assertPageTextAllowed, fillSecretsIntoPage, type SecretFillKind } from './browser-secret-fill.js';
import type {
  BrowserProvisionReport,
  BrowserSnapshot,
  CardFieldGuard,
  OwnerApproval,
  UntrustedContentPort,
} from './browser-types.js';


// The engine's option/target types, its error and the two pure helpers moved
// to browser-engine-contract.ts when the untrusted-content boundary and the
// card-field guard together took this file past the 800-line cap. Re-exported
// below so the platform/browser barrel's surface is unchanged.
import {
  DEFAULT_ACTION_TIMEOUT_MS,
  DEFAULT_NAVIGATION_TIMEOUT_MS,
  DEFAULT_TEXT_LIMIT,
  DEFAULT_WAIT_TIMEOUT_MS,
  boundedBrowserCall,
  classifyNavigationTarget,
  deadlineFor,
  launchNote,
  normalizeUrl,
  readElementData,
  UntrustedEffectError,
} from './browser-engine-contract.js';
import type {
  BrowserActionLifetime,
  BrowserEngineOptions,
  BrowserExtractField,
  BrowserTarget,
} from './browser-engine-contract.js';

export { UntrustedEffectError };

/**
 * Whether pressing `key` can submit a form. Enter always can, whatever
 * modifiers come with it (Control+Enter sends a chat box); Space does when the
 * focused control is one that submits (a submit button). The key is read by its
 * final segment, so the spelling of the combination does not matter.
 */
function keyCanSubmit(key: string, controlSubmits: boolean): boolean {
  const final = (key.length > 1 && key.endsWith('+') ? '+' : key.split('+').pop() ?? key).toLowerCase();
  if (final === 'enter' || final === 'numpadenter' || final === 'return') return true;
  return controlSubmits && (final === 'space' || final === ' ');
}
export type { BrowserActionLifetime, BrowserEngineOptions, BrowserExtractField, BrowserTarget };

/** Names the embedded frames a read left out because of where they point. */
function withheldNote(origins: readonly string[]): { readonly withheldFrames?: readonly string[]; readonly withheldNote?: string } {
  if (origins.length === 0) return {};
  return {
    withheldFrames: [...new Set(origins)],
    withheldNote: 'Embedded frames on local, private or cloud-metadata addresses were left out. Ask the owner if their content is needed.',
  };
}

/** Host-owned attachment. The driver must bind snapshotId to every control
 * operation; assertCurrent retains the page/owner even after its submit clears
 * refs. A later snapshot can never supply replacement controls to that driver. */
export interface RestoredCheckoutPage extends RestoredBrowserPage {
  readonly snapshotId: string;
  /** Selected controls must still belong to the exact restored snapshot.
   * Separate from page lifetime, which must survive our own successful submit. */
  assertControlsCurrent(): void;
}


/** A native click entered the actuator. Later cancellation/validation failures
 * cannot prove that the remote site received nothing. Keep this value-free so
 * payment callers cannot mistake a post-click source error for a safe retry.
 */
class BrowserClickOutcomeUnknownError extends Error {
  override readonly name = 'BrowserClickOutcomeUnknownError';
  constructor() { super('The browser click was attempted, but its result could not be confirmed. Inspect the page before trying again.'); }
}

/**
 * The browser capability itself: provisioning, sessions, and every page
 * operation, with no Agent-surface types in sight.
 */
export class BrowserEngine {
  private readonly snapshots = new SnapshotStore();

  private readonly untrusted: UntrustedContentPort;
  private readonly cardGuard: CardFieldGuard | null;
  private approval: OwnerApproval | null;
  /** The provision report whose setup receipt was last handed to a caller. */
  private receiptDelivered: BrowserProvisionReport | null = null;
  /** Local or private origins a page was allowed to open, per session:page, so reading that page again is not a new reach. */
  private readonly localReach = new Map<string, Set<string>>();
  /** Credential-page verdicts, one per snapshot: the page is read for its purpose at most once per snapshot. */
  private readonly credentialVerdicts = new WeakMap<BrowserSnapshot, 'yes' | 'no'>();

  constructor(
    private readonly sessions: BrowserSessionManager,
    private readonly options: BrowserEngineOptions,
  ) {
    this.untrusted = options.untrusted;
    this.cardGuard = options.cardFieldGuard ?? null;
    this.approval = options.approval ?? null;
  }

  /** Whether this engine can be used to pay for something (see fill-card.ts). */
  cardFieldGuardInstalled(): boolean {
    return this.cardGuard !== null;
  }

  cardFieldGuard(): CardFieldGuard | null {
    return this.cardGuard;
  }

  /**
   * Strip live card material out of anything a page produced. Applied to every
   * value, name, body text, extracted field and ledger entry leaving this
   * class, unconditionally, see `CardFieldGuard` in browser-types.ts.
   */
  private scrub(sessionId: string, pageId: string, text: string): string {
    return this.cardGuard === null ? text : this.cardGuard.redact(sessionId, pageId, text);
  }

  /**
   * Records that the owner asked for a specific outward action.
   *
   * Approval arrives mid-session, in the normal case: the agent reports what it
   * found on a page and the owner says to go ahead. Only the product's trust
   * contract can mint one of these, and only from a surface that carries
   * command authority, so nothing a page says can reach this.
   */
  setOwnerApproval(approval: OwnerApproval | null): void {
    this.approval = approval;
  }

  /**
   * Records that page content entered the conversation, with where it came
   * from AND what it said.
   *
   * The text matters as much as the origin. Without it, a later outward action
   * can only be judged on "did this turn read anything", which in a daemon is
   * permanently true, so every send would be refused and the boundary would
   * be switched off. With it, the guard can ask the answerable question:
   * does what is about to leave derive from what was read.
   */
  private recordPageIngest(url: string, content?: string): string {
    const origin = this.untrusted.originOf(url);
    this.untrusted.recordIngest({
      origin,
      at: new Date().toISOString(),
      ...(content === undefined ? {} : { content }),
    });
    return origin;
  }

  /**
   * Refuses an outward action when this turn has read page content.
   *
   * This is the composition that matters: a page the agent just read must not
   * be able to cause the agent to act outwards. The refusal names what to do
   * instead, which is to take it to the owner.
   *
   * `content` is what is about to be submitted, when the caller could work it
   * out. Supplying it turns the coarse question into the answerable one, does
   * this submission repeat what was read, which is the difference between a
   * form filled from the owner's instruction going through and every form on a
   * browsing session being refused.
   */
  private async requireOutwardEffectAllowed(
    action: string,
    description: string,
    content?: Readonly<Record<string, string | undefined>>,
  ): Promise<void> {
    const approval = this.approval;
    const hadApproval = approval !== null;
    try {
      const decision = await this.untrusted.evaluateOutwardEffect({
        action,
        description,
        approval,
        ...(content === undefined ? {} : { content }),
      });
      if (this.approval !== approval) throw new UntrustedEffectError('The outward approval changed while checking it.', 'Retry the original action.');
      if (decision.allowed) return;
      throw new UntrustedEffectError(decision.reason ?? 'This action is not available here.', decision.fix ?? 'Ask the owner.');
    } finally {
      // `armSubmitApproval` (routes/browser-composition.ts) documents itself as
      // covering exactly ONE outward submit. A TTL alone does not enforce that,
      // an approval that sits unconsumed authorises every submit until it
      // expires, so it is spent here, on the first submit check it was live
      // for, whatever that check decided.
      if (hadApproval && action === 'browser.submit' && this.approval === approval) this.approval = null;
    }
  }

  /**
   * The values in the form this element belongs to, as the fields about to
   * leave the machine.
   *
   * Read live rather than remembered: the page may have filled, rewritten or
   * defaulted anything since the snapshot, and what matters is what will
   * actually be posted. Field names come from `name`/`id`, so a refusal can say
   * which input carried the overlap instead of pointing at an index.
   *
   * Password values are read but never returned. A password is high-entropy by
   * construction, so it contributes nothing to a derivation check, while
   * putting one into a `TaintFinding` excerpt would print it in a refusal
   * message, the check would have leaked what it was defending.
   *
   * Returns undefined when the values cannot be established: the element is
   * outside a form, the page is cross-origin-restricted, the evaluate times
   * out. That is the honest answer, and it drops this call to the coarse rule
   * rather than to a false "nothing overlaps".
   */
  private static async enclosingFormFields(
    locator: Locator,
  ): Promise<Readonly<Record<string, string | undefined>> | undefined> {
    try {
      const fields = await locator.evaluate((node: Element) => {
        const owner = (node as HTMLInputElement).form ?? node.closest('form');
        if (!owner) return null;
        const out: Record<string, string> = {};
        let index = 0;
        for (const control of Array.from(owner.elements)) {
          const input = control as HTMLInputElement;
          const type = (input.type ?? '').toLowerCase();
          if (type === 'password' || type === 'hidden' || type === 'file') continue;
          if (type === 'checkbox' || type === 'radio') {
            if (!input.checked) continue;
          }
          const value = typeof input.value === 'string' ? input.value : '';
          if (value.trim().length === 0) continue;
          index += 1;
          const name = input.name || input.id || `field ${String(index)}`;
          out[name] = value;
        }
        return out;
      });
      if (fields === null) return undefined;
      return Object.keys(fields).length === 0 ? undefined : fields;
    } catch {
      // A page that will not answer is not a page that has proved itself safe.
      return undefined;
    }
  }

  sessionManager(): BrowserSessionManager {
    return this.sessions;
  }

  async provision(options: BrowserProvisionLifetime & { readonly repair?: boolean | undefined; readonly allowDownload?: boolean | undefined } = {}): Promise<BrowserProvisionReport> {
    return this.sessions.provision(options);
  }

  async status(): Promise<Record<string, unknown>> {
    // A report that says something is wrong is read again: the person may have
    // installed the driver or browser since, and a stale problem/fix is worse
    // than no answer. A passing report is kept, it costs nothing to trust.
    const cached = this.sessions.provisionReport();
    const report = cached?.ok ? cached : await this.sessions.provision({ allowDownload: false });
    return {
      browserAvailable: report.ok,
      binarySource: report.source,
      executablePath: report.executablePath,
      driverVersion: report.driverVersion,
      browsersPath: report.browsersPath,
      displayAvailable: hasDisplay(),
      defaultMode: hasDisplay() ? 'visible window' : 'headless (no display on this machine)',
      sessions: this.sessions.list(),
      ...(report.ok ? {} : { problem: report.problem, fix: report.fix }),
      provisionSteps: report.steps,
    };
  }

  async launch(options: BrowserLaunchOptions): Promise<Record<string, unknown>> {
    const session = await this.sessions.launch(options);
    return {
      session,
      // Setup that actually ran is reported, never swallowed: a first call that
      // spent two minutes installing a driver and a browser has to say so.
      ...this.setupReceipt(),
      note: launchNote(session),
    };
  }

  /** The one-act setup receipt for a call that may have provisioned something. */
  private setupReceipt(): { readonly setup?: string } {
    const report = this.sessions.provisionReport();
    // Told once: the report stays on the manager, and repeating "first browser
    // call" on every later navigation would describe work that is long done.
    if (report === this.receiptDelivered) return {};
    this.receiptDelivered = report;
    const setup = describeProvisionWork(report);
    return setup ? { setup } : {};
  }

  async attach(options: BrowserAttachOptions): Promise<Record<string, unknown>> {
    const session = await this.sessions.attach(options);
    const pages = await this.sessions.pageList(session.sessionId);
    return {
      session,
      pages,
      note: 'Attached to a browser this agent did not start. It will keep running; the agent cannot close it.',
    };
  }

  release(sessionId: string): Record<string, unknown> {
    const session = this.sessions.release(sessionId);
    this.forgetSessionState(sessionId);
    return { released: session, note: 'Disconnected. The browser is still running.' };
  }

  async close(sessionId: string): Promise<Record<string, unknown>> {
    try {
      const session = await this.sessions.closeSession(sessionId);
      return { closed: session };
    } finally {
      // Every page's material in this session is gone with the browser that held
      // it. Material bound to a page that outlives the session it was typed in
      // would be material with no page left to be redacted out of. Done even
      // when the close itself failed: the session's controls are unusable either way.
      this.forgetSessionState(sessionId);
    }
  }

  /** Drops what this engine holds for a session it no longer drives: snapshots and armed card material. */
  private forgetSessionState(sessionId: string): void {
    this.snapshots.clearSession(sessionId);
    this.cardGuard?.disarmSession?.(sessionId);
    for (const key of [...this.localReach.keys()]) if (key.startsWith(`${sessionId}:`)) this.localReach.delete(key);
  }

  /**
   * Opening a local file or a private-network address reads it into the
   * conversation, so it is put through the same outward-effect check as a
   * submit: refused when this turn has read page content, unless the owner
   * approved it. Cloud metadata addresses are never opened.
   */
  private async requireNavigationAllowed(url: string, page?: { readonly sessionId: string; readonly pageId: string }): Promise<string | null> {
    const reach = classifyNavigationTarget(url);
    if (reach === 'public') return null;
    const origin = this.untrusted.originOf(url);
    if (reach === 'link-local') {
      throw new BrowserSessionError(
        `${origin} is a link-local or cloud-metadata address, which the browser tool does not open or read.`,
        'Use a public address, or ask the owner to open it in their own browser.',
      );
    }
    if (page && this.localReach.get(`${page.sessionId}:${page.pageId}`)?.has(origin)) return origin;
    await this.requireOutwardEffectAllowed('browser.navigate-local', `open ${origin} (a local file or private-network address) in the browser`);
    if (page) this.rememberLocalReach(page.sessionId, page.pageId, origin);
    return origin;
  }

  private rememberLocalReach(sessionId: string, pageId: string, origin: string | null): void {
    if (origin === null) return;
    const key = `${sessionId}:${pageId}`;
    const origins = this.localReach.get(key) ?? new Set<string>();
    origins.add(origin);
    this.localReach.set(key, origins);
  }

  /**
   * The same rule, applied to where the page actually is: after a redirect,
   * and before anything from the page is handed back. A pure string check for
   * a public address; the outward-effect decision only for a local one not
   * already allowed on this page.
   */
  private async requireReadableAddress(sessionId: string, pageId: string, url: string): Promise<void> {
    await this.requireNavigationAllowed(url, { sessionId, pageId });
  }

  /** Whether an embedded frame's content may be returned; a refused frame is left out, not fatal. */
  private async frameReadable(sessionId: string, pageId: string, url: string): Promise<boolean> {
    try {
      await this.requireReadableAddress(sessionId, pageId, url);
      return true;
    } catch (error) {
      if (error instanceof BrowserSessionError || error instanceof UntrustedEffectError) return false;
      throw error;
    }
  }

  private resolveSessionId(target: BrowserTarget): string {
    const sessionId = target.sessionId ?? this.sessions.defaultSessionId();
    if (!sessionId) {
      throw new BrowserSessionError(
        'No browser session is open.',
        'Call action:"launch" to start one, or action:"attach" to connect to a browser you already have running.',
      );
    }
    return sessionId;
  }

  private async target(target: BrowserTarget): Promise<{ readonly sessionId: string; readonly pageId: string; readonly page: Page }> {
    const sessionId = this.resolveSessionId(target);
    const { pageId, page } = await this.sessions.page(sessionId, target.pageId);
    return { sessionId, pageId, page };
  }

  /** Retain the exact selected page through native reads and result publication.
   * The session manager drains the callback after closing/disconnecting the
   * browser, so a late native result cannot outlive successful shutdown. */
  private async withTarget<T>(target: BrowserTarget, perform: (selected: {
    readonly sessionId: string; readonly pageId: string; readonly page: Page; readonly current: () => void;
    /** Aborts when the caller cancels or the page goes away. */
    readonly signal: AbortSignal;
  }) => Promise<T>, work?: BrowserControlIdentityWork): Promise<T> {
    target = { ...target };
    const selected = work ? await work.wait(() => this.target(target)) : await this.target(target);
    return this.sessions.withPage(selected.sessionId, selected.pageId, async (page, current, pageSignal) => {
      if (page !== selected.page) throw new BrowserSessionError('The original browser page was replaced.', 'Select a live page before retrying.');
      const signal = target.signal ? AbortSignal.any([pageSignal, target.signal]) : pageSignal;
      current(); work?.bindPage(current, signal);
      const result = await perform({ ...selected, current, signal });
      current(); work?.assertCurrent(); return result;
    });
  }

  /**
   * Opens a browser only if nothing is open yet, so the first call a model
   * makes is a useful one instead of an error telling it to call launch first.
   */
  private async ensureSession(target: BrowserTarget, launchOptions: BrowserLaunchOptions = {}): Promise<string> {
    if (target.sessionId) return target.sessionId;
    const existing = this.sessions.defaultSessionId();
    if (existing) return existing;
    // An implicitly opened session honors the same launch arguments an
    // explicit launch would, so headless:true on the first call is respected
    // instead of silently opening a window on someone's screen.
    const session = await this.sessions.launch(launchOptions);
    return session.sessionId;
  }

  async navigate(
    target: BrowserTarget,
    args: {
      readonly url: string;
      readonly waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | undefined;
      readonly timeoutMs?: number | undefined;
      readonly launch?: BrowserLaunchOptions | undefined;
    },
  ): Promise<Record<string, unknown>> {
    target = { ...target }; args = { ...args };
    const url = normalizeUrl(args.url);
    const deadlineMs = deadlineFor(args.timeoutMs, DEFAULT_NAVIGATION_TIMEOUT_MS);
    const approvedOrigin = await this.requireNavigationAllowed(url);
    const sessionId = await this.ensureSession(target, args.launch ?? {});
    return this.withTarget({ sessionId, pageId: target.pageId, signal: target.signal }, async ({ pageId, page, current, signal }) => {
      this.rememberLocalReach(sessionId, pageId, approvedOrigin);
      const response = await boundedBrowserCall({
        action: 'navigate', deadlineMs, signal,
        next: 'Call action:"snapshot" to see what has loaded so far, or navigate again.',
      }, () => page.goto(url, { waitUntil: args.waitUntil ?? 'domcontentloaded', timeout: deadlineMs }));
      current();
      this.snapshots.clear(sessionId, pageId);
      // A redirect can land somewhere the requested address was not: the
      // address the page ended on is held to the same rule before its title
      // or anything else from it is returned.
      await this.requireReadableAddress(sessionId, pageId, page.url()); current();
      // goto can be a same-document fragment change. A new document can also
      // restore filled history or merchant state. A URL/load result does not
      // establish that this page has forgotten its material; keep protection
      // until the actual page or owned browser is closed.
      const title = await page.title().catch(() => ''); current();
      return {
        sessionId,
        pageId,
        url: page.url(),
        title,
        httpStatus: response?.status() ?? null,
        ...this.setupReceipt(),
        next: 'Call action:"snapshot" to get element refs for this page.',
      };
    });
  }

  async snapshot(target: BrowserTarget, args: { readonly limit?: number | undefined } = {}, controls?: BrowserControlAdmission): Promise<Record<string, unknown>> {
    target = { ...target }; args = { ...args };
    const work = new BrowserControlIdentityWork({});
    return this.withTarget(target, async ({ sessionId, pageId, page, current }) => {
      const prior = this.currentSnapshot(sessionId, pageId);
      if (controls?.verifySnapshotId !== undefined && prior?.snapshotId !== controls.verifySnapshotId) throw new StaleElementError('The offered browser snapshot was replaced.', 'Read the page again.');
      await this.requireReadableAddress(sessionId, pageId, page.url()); current();
      // The guard goes IN rather than being applied to the result: the snapshot
      // is also stored for ref resolution, and a stored copy holding the card
      // would be the same leak one indirection further away.
      const snapshot = await takeSnapshot(page, sessionId, pageId, {
        ...args,
        work,
        admitFrame: (frameUrl) => this.frameReadable(sessionId, pageId, frameUrl),
        ...(controls ? { controls } : {}),
        ...(this.cardGuard === null ? {} : { guard: this.cardGuard }),
      });
      current();
      if (controls?.verifySnapshotId !== undefined) {
        if (prior !== this.currentSnapshot(sessionId, pageId)) throw new StaleElementError('The offered browser snapshot was replaced.', 'Read the page again.');
      } else this.snapshots.set(snapshot);
      // Element names and values are written by the page, so a snapshot is
      // untrusted content just as much as the body text is.
      const origin = this.recordPageIngest(
        snapshot.url,
        snapshot.elements.map((element) => `${element.name} ${element.value ?? ''}`).join('\n'),
      );
      return {
        sessionId,
        pageId,
        url: snapshot.url,
        title: snapshot.title,
        contentTrust: 'untrusted',
        origin,
        rule: this.untrusted.rule,
        snapshotId: controls?.verifySnapshotId ?? snapshot.snapshotId,
        elementCount: snapshot.elements.length,
        truncated: snapshot.truncated,
        ...withheldNote(snapshotWithheldFrames(snapshot).map(frameUrl => this.untrusted.originOf(frameUrl))),
        elements: snapshot.elements.map((element) => ({
          ref: element.ref,
          role: element.role,
          name: element.name,
          ...(element.value === undefined ? {} : { value: element.value }),
          ...(element.disabled === undefined ? {} : { disabled: element.disabled }),
          ...(element.checked === undefined ? {} : { checked: element.checked }),
        })),
      };
    }, work);
  }

  /** Synchronous page/ref ownership for retained structured setup readers. */
  assertSnapshotCurrent(sessionId: string | undefined, pageId: string | undefined, snapshotId: string | undefined): void {
    if (!sessionId || !pageId || !snapshotId || this.currentSnapshot(sessionId, pageId)?.snapshotId !== snapshotId) {
      throw new StaleElementError('The offered browser snapshot is no longer current.', 'Read the page again.');
    }
  }

  /** Complete checkout evidence without replacing snapshot refs or exporting field secrets. */
  async observeCheckoutTerms(target: BrowserTarget, ownership: BrowserActionLifetime, submitTarget?: string): Promise<{
    readonly state: object; readonly assertCurrent: () => Promise<void>; readonly signal: AbortSignal;
  }> {
    const sessionId = target.sessionId, pageId = target.pageId;
    if (!sessionId || !pageId) throw new BrowserSessionError('Checkout terms require an explicit session and page.');
    const work = new BrowserControlIdentityWork({ ...ownership });
    const guard = this.cardGuard;
    if (!guard) throw new BrowserSessionError('Checkout evidence requires the payment redactor.');
    const methods = retainBrowserMethods(guard, ['redact']);
    const redact = methods.value('redact');
    if (typeof redact !== 'function') throw new BrowserSessionError('Checkout redaction is unavailable.');
    const scrub = (text: string): string => {
      if (this.cardGuard !== guard) throw new BrowserSessionError('The original checkout redactor was replaced.');
      methods.assertCurrent(); work.assertCurrent();
      const result: unknown = Reflect.apply(redact, guard, [sessionId, pageId, text]);
      methods.assertCurrent(); work.assertCurrent();
      if (typeof result !== 'string') throw new BrowserSessionError('Checkout redaction is unavailable.');
      return result;
    };
    const fail = (error: unknown): never => {
      work.assertCurrent();
      if (error instanceof BrowserSessionError || error instanceof StaleElementError) throw error;
      // Native evaluation failures may contain page-authored text or values.
      throw new BrowserSessionError('The complete current checkout could not be safely read.', 'Read the live checkout again before starting another purchase.');
    };
    try { return await this.sessions.withPage(sessionId, pageId, async (page, currentPage, signal) => {
      work.bindPage(currentPage, signal);
      const scope = submitTarget ? this.refScope(sessionId, pageId, page, work, ownership, undefined, undefined, true) : undefined;
      const current = (): void => {
        currentPage(); work.assertCurrent(); methods.assertCurrent();
        scope?.current();
        if (this.cardGuard !== guard) throw new BrowserSessionError('The original checkout redactor was replaced.');
      };
      const selected = submitTarget && scope ? await scope.resolve(submitTarget) : undefined;
      if (selected) { await selected.revalidate(); current(); }
      const observation = await captureCredentialPage(page, work, current, text => {
        if (scrub(text) !== text) throw new BrowserSessionError('Checkout metadata contains live payment material.');
      }, { scrub });
      current();
      if (observation.password) throw new BrowserSessionError('Checkout terms cannot be verified on a credential-entry page.');
      if (selected) for (const text of [submitTarget, selected.element.selector, selected.element.name,
        selected.element.role, ...selected.element.frameChain]) {
        if (typeof text !== 'string' || scrub(text) !== text) throw new BrowserSessionError('Checkout submit metadata contains live payment material.');
      }
      const state = captureOwnedJson({ ...observation.state, ...(selected ? { submitControl: {
        ref: submitTarget, selector: selected.element.selector, frameChain: selected.element.frameChain,
        name: selected.element.name, role: selected.element.role, submits: selected.element.submits,
      } } : {}) });
      if (!state || typeof state !== 'object' || Array.isArray(state)) throw new BrowserSessionError('Checkout evidence is incomplete.');
      // Not recorded as a page ingest. This observation is read by the payments
      // flow itself and never reaches the conversation; recording it would make
      // the flow's own reading count as content the turn read, and the final
      // submit would be refused for something the purchase did to itself. The
      // checkout is already bound by the flow's retained evidence and the
      // card-field guard.
      current();
      return { state, signal, assertCurrent: async () => {
        try { await this.sessions.withPage(sessionId, pageId, async (original, assertPage) => {
          if (original !== page) throw new BrowserSessionError('The original checkout page was replaced.');
          assertPage(); await observation.assertCurrent(); assertPage();
        }); } catch (error) { fail(error); }
      } };
    }); } catch (error) { return fail(error); }
  }

  private currentSnapshot(sessionId: string, pageId: string): BrowserSnapshot | null {
    return this.snapshots.get(sessionId, pageId);
  }

  /** Composition-only recovery observation; never choose a default page or
   * launch/attach another browser to satisfy an original checkout reference. */
  capturePageConnection(target: BrowserTarget, owner: BrowserProvisionLifetime): Promise<BrowserPageConnection | null> {
    const { sessionId, pageId } = target;
    if (!sessionId || !pageId) throw new BrowserSessionError('The original checkout page must be selected explicitly.');
    return this.sessions.pageConnection(sessionId, pageId, owner);
  }

  /** Retain selected original native control identities alongside the actual
   * connection observation. Do not adopt a snapshot produced during an await. */
  async captureCheckoutRecovery(target: BrowserTarget, refs: readonly string[], owner: BrowserProvisionLifetime): Promise<BrowserCheckoutRecovery | null> {
    const { sessionId, pageId } = target;
    if (!sessionId || !pageId) throw new BrowserControlSnapshotError();
    const snapshot = this.currentSnapshot(sessionId, pageId);
    const selected = [...refs];
    const signal = owner.signal, check = owner.assertCurrent?.bind(owner);
    const current = () => {
      signal?.throwIfAborted(); check?.();
      if (this.currentSnapshot(sessionId, pageId) !== snapshot) throw new BrowserControlSnapshotError();
    };
    current();
    const controls = snapshot ? captureNativeSnapshotControls(snapshot, selected) : null;
    const connection = await this.sessions.pageConnection(sessionId, pageId, { signal, assertCurrent: current });
    current();
    if (!connection) return null;
    if (!controls) throw new BrowserControlSnapshotError();
    return captureBrowserCheckoutRecovery({ connection, controls });
  }

  /** Composition-only restoration; no public browser verb accepts this data.
   * The host supplies independently restored payment authority, while the
   * session manager reconnects only the original endpoint/tab/documents. */
  async restoreCheckoutRecovery(value: BrowserCheckoutRecovery, owner: BrowserProvisionLifetime): Promise<RestoredCheckoutPage> {
    const retained = captureBrowserCheckoutRecovery(value);
    const page = await this.sessions.restorePage(retained.connection, owner);
    const { sessionId, pageId } = page;
    let published: BrowserSnapshot | undefined;
    try {
      page.assertCurrent();
      const snapshot = await this.sessions.withPage(sessionId, pageId, async (native, current) => {
        current(); page.assertCurrent();
        if (this.currentSnapshot(sessionId, pageId) || native.url() !== retained.controls.url) throw new BrowserControlSnapshotError();
        const snapshot = restoreControlSnapshot(retained.controls, sessionId, pageId, this.cardGuard);
        current(); page.assertCurrent(); this.snapshots.set(snapshot); published = snapshot;
        return snapshot;
      });
      page.assertCurrent();
      if (this.currentSnapshot(sessionId, pageId) !== snapshot) throw new BrowserControlSnapshotError();
      const original = snapshot;
      let closing: Promise<void> | undefined;
      return Object.freeze({ sessionId, pageId, snapshotId: original.snapshotId, assertCurrent: page.assertCurrent,
        assertControlsCurrent: () => { page.assertCurrent(); if (this.currentSnapshot(sessionId, pageId) !== original) throw new BrowserControlSnapshotError(); }, release: () => {
        if (closing) return closing;
        if (this.currentSnapshot(sessionId, pageId) === original) this.snapshots.clear(sessionId, pageId);
        closing = page.release(); return closing;
      } });
    } catch {
      if (published && this.currentSnapshot(sessionId, pageId) === published) this.snapshots.clear(sessionId, pageId);
      try { await page.release(); } finally { throw new BrowserControlSnapshotError(); }
    }
  }

  /** Keep the shared tool decision bound to this serving browser and original input. */
  retainAdmittedToolAction(args: Record<string, unknown>, options: ToolExecuteOptions, current: () => void): BrowserActionLifetime | undefined {
    const sessionId = typeof args.sessionId === 'string' && args.sessionId.trim() ? args.sessionId.trim() : this.sessions.defaultSessionId();
    if (!sessionId) return undefined;
    const pageId = typeof args.pageId === 'string' && args.pageId.trim() ? args.pageId.trim() : this.sessions.info(sessionId).activePageId;
    return pageId ? retainAdmittedBrowserAction(this, args, options, current, sessionId, pageId) : undefined;
  }

  /**
   * Whether this action may proceed on a page that could be asking for
   * credentials. Decided from the snapshot the ref came from and the control's
   * own live document, both already read: no further walk of the page.
   *
   *   - an action the gate admitted (or yolo) goes ahead;
   *   - a native password input is refused as a fact;
   *   - anything else is one credential-page reading per snapshot, kept for
   *     every later action on the same snapshot.
   *
   * Returns the check to run once the control is re-identified and again
   * immediately before dispatch; it is given whether the control's own
   * document now holds a password input.
   */
  private async credentialInteraction(snapshot: BrowserSnapshot | null, sessionId: string, pageId: string,
    work: BrowserControlIdentityWork, current: () => void, action: string,
    ownership: BrowserActionLifetime | undefined, args: Readonly<Record<string, unknown>>): Promise<(passwordInDocument: boolean) => void> {
    if (isYoloExecution() || isAdmittedBrowserAction(this, ownership, sessionId, pageId, action, args)) {
      return () => {
        current();
        if (!isYoloExecution() && !isAdmittedBrowserAction(this, ownership, sessionId, pageId, action, args)) {
          throw new BrowserSessionError('The browser action is no longer admitted.', 'Obtain a current decision for this action.');
        }
      };
    }
    const passwordRefusal = (): BrowserSessionError => new BrowserSessionError(
      'This page contains a native password input, so automated credential interaction is refused.', 'Only the account owner can complete authentication.');
    if (!snapshot) throw new StaleElementError('No snapshot has been taken for this page.', 'Call action:"snapshot" first, then use a ref from that snapshot.');
    if (snapshotHasPasswordInput(snapshot)) throw passwordRefusal();
    const signInPage = (): BrowserSessionError => new BrowserSessionError(
      `This page looks like a sign-in page (${snapshot.url}), so the browser layer will not ${action} on it.`,
      `Give the owner this URL to open in their own browser and sign in there: ${snapshot.url}`,
    );
    let verdict: 'yes' | 'no' | 'unresolved' | undefined = this.credentialVerdicts.get(snapshot);
    if (verdict === undefined) {
      const evidence = snapshotCredentialEvidence(snapshot);
      const encoded = JSON.stringify(evidence);
      // Page labels carrying live card material or an issuer credential are
      // never sent to a reader; the action then waits for an owner decision.
      const guard = this.cardGuard;
      const unsafe = containsIssuerCredential(encoded) || (guard !== null && guard.redact(sessionId, pageId, encoded) !== encoded);
      try { verdict = unsafe ? 'unresolved' : await work.credentialPage(evidence); }
      catch (error) {
        // A reading that failed is no answer; cancellation and a retired owner still end the call.
        work.assertCurrent();
        if (error instanceof BrowserSessionError || error instanceof StaleElementError) throw error;
        verdict = 'unresolved';
      }
      current();
      if (verdict !== 'unresolved') this.credentialVerdicts.set(snapshot, verdict);
    }
    if (verdict === 'yes') throw signInPage();
    if (verdict !== 'no') {
      throw new BrowserSessionError(
        `Whether ${snapshot.url} is a sign-in page could not be read, so the browser layer will not ${action} on it without a decision.`,
        'Approve this browser action when asked, or turn decision models on so the page purpose can be read. Reading the page again does not change this.',
      );
    }
    return (passwordInDocument) => { current(); if (passwordInDocument) throw passwordRefusal(); };
  }

  /** Bind every ref consumer to one stored snapshot and one original source. */
  private refScope(sessionId: string, pageId: string, page: Page, work: BrowserControlIdentityWork, ownership?: BrowserActionLifetime,
    action?: string, args?: Readonly<Record<string, unknown>>, observationOnly = false) {
    const snapshot = this.currentSnapshot(sessionId, pageId), expected = ownership?.snapshotId;
    const pageMethods = retainBrowserMethods(page, ['url']);
    const current = () => {
      pageMethods.assertCurrent(); work.assertCurrent(); pageMethods.assertCurrent();
      const currentUrl = page.url(); pageMethods.assertCurrent(); work.assertCurrent(); pageMethods.assertCurrent();
      if (snapshot !== this.currentSnapshot(sessionId, pageId) || !snapshot || currentUrl !== snapshot.url
        || (expected !== undefined && snapshot.snapshotId !== expected)) {
        throw new StaleElementError('The selected browser snapshot is no longer current.', 'Read the page again before acting.');
      }
    };
    if (action && args) retainAdmittedBrowserWork(work, this, ownership, sessionId, pageId, action, args, current);
    return { snapshot, current, resolve: (ref: string) => resolveRef(page, snapshot, ref, work, current, () => {
      if (this.cardGuard?.hasLiveMaterial(sessionId, pageId)) throw new StaleElementError('Cannot read changed control identity while payment material is live.', 'Use an unchanged control or finish the authorized payment flow first.');
    }, { observationOnly }) };
  }

  async click(
    target: BrowserTarget,
    args: { readonly ref: string; readonly button?: 'left' | 'right' | 'middle' | undefined; readonly clickCount?: number | undefined; readonly timeoutMs?: number | undefined },
    ownership?: BrowserActionLifetime,
  ): Promise<Record<string, unknown>> {
    args = { ...args }; target = { ...target }; ownership = ownership && { ...ownership };
    const work = new BrowserControlIdentityWork(ownership);
    let attempted = false;
    const deadlineMs = deadlineFor(args.timeoutMs, DEFAULT_ACTION_TIMEOUT_MS);
    try { return await this.withTarget(target, async ({ sessionId, pageId, page }) => {
      const scope = this.refScope(sessionId, pageId, page, work, ownership, 'click', args);
      const current = scope.current;
      current();
      const credentialCurrent = await this.credentialInteraction(scope.snapshot, sessionId, pageId, work, current, 'click', ownership, args); current();
      const { locator, element, revalidate, passwordInDocument } = await scope.resolve(args.ref);
      credentialCurrent(passwordInDocument); current();
      if (element.submits) {
        // Submitting sends data to whoever runs the site. Whether this element
        // submits was recorded when the page was snapshotted, so this is a fact
        // about the control rather than a guess about the click.
        //
        // The form's current values are what will actually be posted, so they are
        // the fields the derivation check should see. Read live; undefined when
        // the element is outside a form or the page will not answer, which drops
        // this call to the coarse rule rather than to a false clean bill.
        const formFields = await work.wait(() => BrowserEngine.enclosingFormFields(locator));
        await revalidate(); scope.current();
        await work.wait(() => this.requireOutwardEffectAllowed(
          'browser.submit',
          `submit the form on ${this.untrusted.originOf(page.url())} by activating ${element.role} "${element.name}"`,
          formFields,
        ));
      }
      current();
      await revalidate(); current();
      credentialCurrent(passwordInDocument); current();
      const urlBefore = page.url();
      try {
        await work.action(async signal => {
          if (ownership?.beforeDispatch) { await ownership.beforeDispatch(); current(); }
          attempted = true;
          return locator.click({ signal, button: args.button ?? 'left', clickCount: args.clickCount ?? 1, timeout: deadlineMs });
        });
        await work.wait(() => page.waitForLoadState('domcontentloaded', { timeout: DEFAULT_NAVIGATION_TIMEOUT_MS }).catch(() => undefined));
        this.snapshots.clear(sessionId, pageId);
        const navigated = page.url() !== urlBefore;
        // URL changes also include pushState and fragments with the same filled
        // DOM. Navigation is not proof that live payment material disappeared.
        return {
          sessionId,
          pageId,
          clicked: { ref: args.ref, role: element.role, name: element.name },
          urlBefore,
          url: page.url(),
          navigated,
          next: 'Refs are cleared after a click. Call action:"snapshot" for current refs.',
        };
      } catch (error) {
        if (attempted) throw new BrowserClickOutcomeUnknownError();
        throw error;
      }
    }, work); } catch (error) {
      if (attempted) throw new BrowserClickOutcomeUnknownError();
      throw error;
    }
  }

  /**
   * Types into a resolved element. There is no variant that types into "the
   * focused window": the text goes to this element in this page or the call
   * fails.
   */
  async type(
    target: BrowserTarget,
    args: {
      readonly ref: string;
      readonly text: string;
      readonly submit?: boolean | undefined;
      readonly replace?: boolean | undefined;
      readonly timeoutMs?: number | undefined;
    },
    ownership?: BrowserActionLifetime,
  ): Promise<Record<string, unknown>> {
    args = { ...args }; target = { ...target }; ownership = ownership && { ...ownership };
    const work = new BrowserControlIdentityWork(ownership);
    return this.withTarget(target, async ({ sessionId, pageId, page }) => {
      const scope = this.refScope(sessionId, pageId, page, work, ownership, 'type', args);
      const current = scope.current;
      current();
      const credentialCurrent = await this.credentialInteraction(scope.snapshot, sessionId, pageId, work, current, 'type', ownership, args); current();
      const { locator, element, revalidate, passwordInDocument } = await scope.resolve(args.ref);
      credentialCurrent(passwordInDocument); current();
      const timeout = deadlineFor(args.timeoutMs, DEFAULT_ACTION_TIMEOUT_MS);
      const act = (run: (signal: AbortSignal) => Promise<unknown>) => boundedBrowserCall({
        action: 'type', deadlineMs: timeout, next: 'Call action:"snapshot" to check the field is present and enabled.',
      }, () => work.action(run));
      // Typing a line break key by key presses Enter in the field, which
      // submits a form just as `submit` does, so it is checked the same way.
      const typesLineBreak = args.replace === false && /[\r\n]/.test(args.text);
      if (args.submit === true || typesLineBreak) {
        // The text about to be typed is named explicitly as well as read back off
        // the form, because the fill has not happened yet at this point: the
        // guard runs BEFORE anything is entered, so a body lifted from a page
        // cannot be typed into a field and then submitted while the check looks
        // at the pre-fill state.
        const formFields = await work.wait(() => BrowserEngine.enclosingFormFields(locator));
        await revalidate(); scope.current();
        await work.wait(() => this.requireOutwardEffectAllowed(
          'browser.submit',
          `submit the form on ${this.untrusted.originOf(page.url())} after typing ${args.submit === true ? '' : 'a line break '}into ${element.role} "${element.name}"`,
          { ...(formFields ?? {}), [element.name || 'typed text']: args.text },
        ));
      }
      current();
      await revalidate(); current();
      credentialCurrent(passwordInDocument); current();
      if (args.replace === false) {
        await act(signal => locator.click({ timeout, signal }));
        current();
        await revalidate(); current();
        credentialCurrent(passwordInDocument); current();
        await act(signal => locator.pressSequentially(args.text, { timeout, signal }));
      } else {
        await act(signal => locator.fill(args.text, { timeout, signal }));
      }
      let submitted = false;
      if (args.submit === true) {
        current();
        await revalidate(); current();
        credentialCurrent(passwordInDocument); current();
        await act(signal => locator.press('Enter', { timeout, signal }));
        await work.wait(() => page.waitForLoadState('domcontentloaded', { timeout: DEFAULT_NAVIGATION_TIMEOUT_MS }).catch(() => undefined));
        submitted = true;
      }
      if (submitted) this.snapshots.clear(sessionId, pageId);
      return {
        sessionId,
        pageId,
        typedInto: { ref: args.ref, role: element.role, name: element.name },
        submitted,
        url: page.url(),
      };
    }, work);
  }

  /**
   * Type several DAEMON-held values in one motion, every ref resolved against
   * the snapshot in place before any of them is typed. Values never come from
   * the model. The mechanics live in browser-secret-fill.ts.
   *
   * The caller arms the guard once before calling this, for the whole batch.
   *
   * A field-by-field version of this cleared the snapshot after every field,
   * so the second field's ref pointed at nothing by the time its turn came.
   * This clears it once, only on failure: nothing then types into a page
   * nobody will click. A full success leaves the snapshot in place, still
   * fresh since nothing here navigates, so the submit click a filled card is
   * always followed by still resolves; that click clears it, as every click
   * already does.
   */
  async fillSecretBatch(
    target: BrowserTarget,
    args: { readonly fills: readonly { readonly ref: string; readonly value: string; readonly kind?: SecretFillKind | undefined }[]; readonly timeoutMs?: number | undefined },
    ownership?: BrowserActionLifetime,
  ): Promise<Record<string, unknown>> {
    args = { ...args, fills: args.fills.map(fill => ({ ...fill })) }; target = { ...target }; ownership = ownership && { ...ownership };
    const work = new BrowserControlIdentityWork(ownership);
    return this.withTarget(target, async ({ sessionId, pageId, page }) => {
      const scope = this.refScope(sessionId, pageId, page, work, ownership);
      const outcome = await fillSecretsIntoPage({
        page,
        snapshot: scope.snapshot,
        work,
        assertSnapshotCurrent: scope.current,
        fills: args.fills,
        guard: this.cardGuard,
        timeoutMs: deadlineFor(args.timeoutMs, DEFAULT_ACTION_TIMEOUT_MS),
      });
      if (!outcome.ok) this.snapshots.clear(sessionId, pageId);
      return {
        sessionId,
        pageId,
        url: page.url(),
        filled: outcome.filled,
        failedRef: outcome.failedRef,
      };
    }, work);
  }

  async select(
    target: BrowserTarget,
    args: { readonly ref: string; readonly values: readonly string[]; readonly timeoutMs?: number | undefined },
    ownership?: BrowserActionLifetime,
  ): Promise<Record<string, unknown>> {
    args = { ...args, values: [...args.values] }; target = { ...target }; ownership = ownership && { ...ownership };
    const work = new BrowserControlIdentityWork(ownership);
    return this.withTarget(target, async ({ sessionId, pageId, page }) => {
      const scope = this.refScope(sessionId, pageId, page, work, ownership, 'select', args);
      const credentialCurrent = await this.credentialInteraction(scope.snapshot, sessionId, pageId, work, scope.current, 'select', ownership, args); scope.current();
      const { locator, element, revalidate, assertCurrent, passwordInDocument } = await scope.resolve(args.ref);
      credentialCurrent(passwordInDocument);
      await revalidate(); assertCurrent();
      credentialCurrent(passwordInDocument); assertCurrent();
      const deadlineMs = deadlineFor(args.timeoutMs, DEFAULT_ACTION_TIMEOUT_MS);
      const selected = await boundedBrowserCall({ action: 'select', deadlineMs, next: 'Call action:"snapshot" to check the list and its options.' },
        () => work.action(signal => locator.selectOption([...args.values], { timeout: deadlineMs, signal })));
      return { sessionId, pageId, selectedIn: { ref: args.ref, role: element.role, name: element.name }, selected };
    }, work);
  }

  async press(
    target: BrowserTarget,
    args: { readonly ref: string; readonly key: string; readonly timeoutMs?: number | undefined },
    ownership?: BrowserActionLifetime,
  ): Promise<Record<string, unknown>> {
    args = { ...args }; target = { ...target }; ownership = ownership && { ...ownership };
    const work = new BrowserControlIdentityWork(ownership);
    return this.withTarget(target, async ({ sessionId, pageId, page }) => {
      const scope = this.refScope(sessionId, pageId, page, work, ownership, 'press', args);
      const credentialCurrent = await this.credentialInteraction(scope.snapshot, sessionId, pageId, work, scope.current, 'press', ownership, args); scope.current();
      const { locator, element, revalidate, assertCurrent, passwordInDocument } = await scope.resolve(args.ref);
      credentialCurrent(passwordInDocument);
      if (keyCanSubmit(args.key, element.submits)) {
        const formFields = await work.wait(() => BrowserEngine.enclosingFormFields(locator));
        await revalidate(); scope.current();
        await work.wait(() => this.requireOutwardEffectAllowed(
          'browser.submit',
          `submit the form on ${this.untrusted.originOf(page.url())} by pressing ${args.key} in ${element.role} "${element.name}"`,
          formFields,
        ));
      }
      await revalidate(); assertCurrent();
      credentialCurrent(passwordInDocument); assertCurrent();
      const deadlineMs = deadlineFor(args.timeoutMs, DEFAULT_ACTION_TIMEOUT_MS);
      await boundedBrowserCall({ action: 'press', deadlineMs, next: 'Call action:"snapshot" to check the control is present and enabled.' },
        () => work.action(signal => locator.press(args.key, { timeout: deadlineMs, signal })));
      this.snapshots.clear(sessionId, pageId);
      return { sessionId, pageId, pressed: args.key, on: { ref: args.ref, role: element.role, name: element.name }, url: page.url() };
    }, work);
  }

  async scroll(
    target: BrowserTarget,
    args: { readonly ref?: string | undefined; readonly direction?: 'up' | 'down' | undefined; readonly amount?: number | undefined },
    ownership?: BrowserActionLifetime,
  ): Promise<Record<string, unknown>> {
    args = { ...args }; target = { ...target }; ownership = ownership && { ...ownership };
    const work = new BrowserControlIdentityWork(ownership);
    return this.withTarget(target, async ({ sessionId, pageId, page }) => {
      const scope = this.refScope(sessionId, pageId, page, work, ownership);
      if (args.ref) {
        const { locator, element, revalidate, assertCurrent } = await scope.resolve(args.ref);
        await revalidate(); assertCurrent();
        await boundedBrowserCall({ action: 'scroll', deadlineMs: DEFAULT_ACTION_TIMEOUT_MS, next: 'Call action:"snapshot" to check the element is still on the page.' },
          () => work.wait(() => locator.scrollIntoViewIfNeeded({ timeout: DEFAULT_ACTION_TIMEOUT_MS })));
        return { sessionId, pageId, scrolledTo: { ref: args.ref, role: element.role, name: element.name } };
      }
      const amount = args.amount ?? 600;
      const delta = args.direction === 'up' ? -amount : amount;
      await work.wait(() => page.mouse.wheel(0, delta));
      const position = await work.wait(() => page.evaluate(() => ({ scrollY: window.scrollY, scrollHeight: document.body.scrollHeight })));
      return { sessionId, pageId, scrolledBy: delta, ...position };
    }, work);
  }

  async waitFor(
    target: BrowserTarget,
    args: { readonly text?: string | undefined; readonly url?: string | undefined; readonly timeoutMs?: number | undefined },
  ): Promise<Record<string, unknown>> {
    target = { ...target }; args = { ...args };
    return this.withTarget(target, async ({ sessionId, pageId, page, current, signal }) => {
      const timeout = deadlineFor(args.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS);
      const wait = (next: string, run: () => Promise<unknown>) => boundedBrowserCall({ action: 'wait_for', deadlineMs: timeout, signal, next }, run);
      if (args.text) {
        const text = args.text;
        await wait('The text did not appear. Call action:"read_text" or action:"snapshot" to see what the page shows instead.',
          () => page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout }));
        current();
        this.snapshots.clear(sessionId, pageId);
        return { sessionId, pageId, waitedFor: { text: args.text }, url: page.url(), found: true };
      }
      if (args.url) {
        const expected = args.url;
        await wait('The page did not reach that address. Call action:"snapshot" to see where it is.', () => page.waitForURL(expected, { timeout }));
        current();
        this.snapshots.clear(sessionId, pageId);
        return { sessionId, pageId, waitedFor: { url: args.url }, url: page.url(), found: true };
      }
      await wait('The page kept loading. Call action:"snapshot" to work with what is there.', () => page.waitForLoadState('networkidle', { timeout })); current();
      return { sessionId, pageId, waitedFor: { state: 'networkidle' }, url: page.url(), found: true };
    });
  }

  async readText(target: BrowserTarget, args: { readonly maxChars?: number | undefined } = {}): Promise<Record<string, unknown>> {
    target = { ...target }; args = { ...args };
    return this.withTarget(target, async ({ sessionId, pageId, page, current, signal }) => {
      assertPageTextAllowed(this.cardGuard, sessionId, pageId);
      const limit = Math.max(200, Math.min(200_000, args.maxChars ?? DEFAULT_TEXT_LIMIT));
      await this.requireReadableAddress(sessionId, pageId, page.url()); current();
      const read = <T>(run: () => Promise<T>) => boundedBrowserCall({
        action: 'read_text', deadlineMs: DEFAULT_ACTION_TIMEOUT_MS, signal, next: 'The page is not answering; call action:"screenshot" or navigate again.',
      }, run);
      // innerText ignores shadow DOM, so a page that renders its content inside a
      // component would read as empty. Open shadow roots are walked and appended.
      const text = await read(() => page.evaluate(() => {
        const collectShadowText = (root: Document | ShadowRoot): string[] => {
          const parts: string[] = [];
          for (const element of Array.from(root.querySelectorAll('*'))) {
            const shadow = element.shadowRoot;
            if (!shadow) continue;
            const inner = (shadow as unknown as { readonly textContent?: string }).textContent ?? '';
            if (inner.trim()) parts.push(inner.replace(/\s+/g, ' ').trim());
            parts.push(...collectShadowText(shadow));
          }
          return parts;
        };
        const body = document.body?.innerText ?? '';
        const shadow = collectShadowText(document);
        return shadow.length > 0 ? `${body}\n${shadow.join('\n')}` : body;
      }));
      current();
      // Embedded frames carry their own content from their own origin. Leaving
      // them out means reading a page and missing the part that mattered, and
      // each frame's origin is recorded separately because a frame is a
      // different author with the same access to this page.
      const frameTexts: string[] = [];
      const frameUrls: string[] = [];
      const withheld: string[] = [];
      for (const frame of page.frames()) {
        // The main frame is already read above. Identity comparison is not enough
        // for a host-backed page, whose frame objects are created per call, so the
        // main frame is the one with no parent.
        if (frame === page.mainFrame() || frame.parentFrame() === null) continue;
        current();
        // A frame is judged on its own address: a public page may embed a
        // private or metadata address, and that content is not returned.
        if (!(await this.frameReadable(sessionId, pageId, frame.url()))) { withheld.push(this.untrusted.originOf(frame.url())); current(); continue; }
        current();
        const frameText = await read(() => frame.evaluate(() => document.body?.innerText ?? '')).catch(() => { signal.throwIfAborted(); return ''; }); current();
        if (!frameText.trim()) continue;
        frameUrls.push(frame.url());
        frameTexts.push(`\n\n[embedded frame ${this.untrusted.originOf(frame.url())}]\n${frameText.trim()}`);
      }
      // Scrubbed before it is labelled, recorded, or returned. A page is free to
      // render what was typed into it as ordinary body text, and this is the path
      // that would hand that straight back.
      const normalized = this.scrub(
        sessionId,
        pageId,
        `${text}${frameTexts.join('')}`.replace(/\n{3,}/g, '\n\n').trim(),
      );
      const title = await page.title().catch(() => ''); current();
      // The ledger is told what the model is given (the returned slice), each
      // part under its own author: the page's text, then each frame's block.
      const given = normalized.slice(0, limit);
      const marks = frameUrls.map((url) => ({ url, at: given.indexOf(`[embedded frame ${this.untrusted.originOf(url)}]\n`) }))
        .filter((mark) => mark.at >= 0).sort((a, b) => a.at - b.at);
      const own = (marks.length > 0 ? given.slice(0, marks[0]!.at) : given).trim();
      // A page whose words are all in its frames is recorded through them.
      const origin = own || marks.length === 0 ? this.recordPageIngest(page.url(), own) : this.untrusted.originOf(page.url()); current();
      marks.forEach((mark, index) => {
        const start = mark.at + `[embedded frame ${this.untrusted.originOf(mark.url)}]\n`.length;
        const block = given.slice(start, marks[index + 1]?.at ?? given.length).trim();
        if (block) this.recordPageIngest(mark.url, block);
      });
      current();
      return {
        sessionId,
        pageId,
        url: page.url(),
        title,
        // The page's words, labelled as the page's words. The envelope carries
        // the origin and the standing rule with the text wherever it goes next.
        content: this.untrusted.label({
          origin,
          text: normalized.slice(0, limit),
          truncated: normalized.length > limit,
        }),
        truncated: normalized.length > limit,
        ...withheldNote(withheld),
      };
    });
  }

  async screenshot(
    target: BrowserTarget,
    args: { readonly fullPage?: boolean | undefined; readonly path?: string | undefined } = {},
  ): Promise<Record<string, unknown>> {
    target = { ...target }; args = { ...args };
    return this.withTarget(target, async ({ sessionId, pageId, page, current, signal }) => {
      assertCaptureAllowed(this.cardGuard, sessionId, pageId);
      // An image cannot leave a frame out, so every frame's address must be readable.
      for (const address of new Set([page.url(), ...page.frames().map(frame => frame.url())])) {
        await this.requireReadableAddress(sessionId, pageId, address); current();
      }
      const fileName = `${sessionId}-${pageId}-${String(Date.now())}.png`;
      mkdirSync(this.options.screenshotDirectory, { recursive: true });
      // Resolved once, so the path written, the path recorded, and the path
      // returned to the model are the same string. The ledger matches on exact
      // spelling and deliberately does not guess a working directory at read
      // time, so an unresolved relative path here would record one spelling and
      // hand back another. A caller's path must stay inside the screenshot
      // directory: this is a file write the write tool's checks never see.
      let path: string;
      try {
        path = args.path === undefined
          ? resolve(join(this.options.screenshotDirectory, fileName))
          : resolveAndValidatePath(args.path, this.options.screenshotDirectory);
      } catch {
        throw new BrowserSessionError(
          `Screenshots are saved inside ${this.options.screenshotDirectory}; ${args.path ?? ''} is outside it.`,
          'Omit path to use the default location, or give a file name inside that directory.',
        );
      }
      let buffer: Awaited<ReturnType<Page['screenshot']>>;
      try {
        buffer = await boundedBrowserCall({ action: 'screenshot', deadlineMs: DEFAULT_NAVIGATION_TIMEOUT_MS, signal, next: 'Try again with fullPage off, or call action:"read_text".' },
          () => page.screenshot({ fullPage: args.fullPage === true, timeout: DEFAULT_NAVIGATION_TIMEOUT_MS }));
      } catch (error) {
        current();
        if (error instanceof BrowserSessionError) throw error;
        throw new BrowserSessionError('The page could not be captured.', 'Read the current page before trying another capture.');
      }
      current(); assertCaptureAllowed(this.cardGuard, sessionId, pageId); current();
      mkdirSync(dirname(path), { recursive: true });
      try { writeFileSync(path, buffer, { flag: 'wx' }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        throw new BrowserSessionError(`A file already exists at ${path}, so the screenshot was not written.`, 'Choose a file name that does not exist yet, or omit path.');
      }
      // Recorded as written by this session, which is what lets the agent open
      // the file it just made even though it lives under a dotted storage root.
      //
      // Declared explicitly rather than inferred from the tool-event stream: that
      // classifier deliberately refuses to grant a waiver for browser and shell
      // writes, because those paths did not pass through the model. This one did
      // not either, but the browser engine KNOWS it just created this exact
      // file, which is the case the explicit entry point exists for.
      this.options.recordSessionWrite?.(path);
      return {
        sessionId,
        pageId,
        url: page.url(),
        path,
        bytes: buffer.byteLength,
        next: `Open it with read path:"${path}".`,
      };
    });
  }

  async tabs(target: BrowserTarget): Promise<Record<string, unknown>> {
    const sessionId = this.resolveSessionId(target);
    const pages = await this.sessions.pageList(sessionId);
    // Tabs the person closed natively are gone from the list; what this engine
    // held for them goes with them.
    for (const pageId of this.snapshots.retainPages(sessionId, new Set(pages.map((page) => page.pageId)))) {
      this.cardGuard?.disarm(sessionId, pageId);
      this.localReach.delete(`${sessionId}:${pageId}`);
    }
    return { sessionId, pages };
  }

  async newTab(
    target: BrowserTarget,
    args: { readonly url?: string | undefined; readonly launch?: BrowserLaunchOptions | undefined } = {},
  ): Promise<Record<string, unknown>> {
    target = { ...target }; args = { ...args };
    const startUrl = args.url ? normalizeUrl(args.url) : undefined;
    const approvedOrigin = startUrl ? await this.requireNavigationAllowed(startUrl) : null;
    const sessionId = await this.ensureSession(target, args.launch ?? {});
    const { pageId, page } = await this.sessions.newPage(sessionId);
    return this.sessions.withPage(sessionId, pageId, async (original, current, pageSignal) => {
      if (original !== page) throw new BrowserSessionError('The original new browser tab was replaced.', 'Select a live tab before retrying.');
      current();
      this.rememberLocalReach(sessionId, pageId, approvedOrigin);
      if (startUrl) {
        const signal = target.signal ? AbortSignal.any([pageSignal, target.signal]) : pageSignal;
        await boundedBrowserCall({ action: 'new_tab', deadlineMs: DEFAULT_NAVIGATION_TIMEOUT_MS, signal, next: `The tab is open as ${pageId}; call action:"snapshot" on it to see what loaded.` },
          () => page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_NAVIGATION_TIMEOUT_MS }));
        current();
        await this.requireReadableAddress(sessionId, pageId, page.url());
      }
      current();
      const pages = await this.sessions.pageList(sessionId); current();
      return { sessionId, pageId, url: page.url(), pages };
    });
  }

  switchTab(target: BrowserTarget, args: { readonly pageId: string }): Record<string, unknown> {
    const sessionId = this.resolveSessionId(target);
    this.sessions.setActivePage(sessionId, args.pageId);
    return { sessionId, activePageId: args.pageId };
  }

  async closeTab(target: BrowserTarget, args: { readonly pageId: string }): Promise<Record<string, unknown>> {
    const sessionId = this.resolveSessionId(target);
    await this.sessions.closePage(sessionId, args.pageId);
    this.snapshots.clear(sessionId, args.pageId);
    this.cardGuard?.disarm(sessionId, args.pageId);
    this.localReach.delete(`${sessionId}:${args.pageId}`);
    return { sessionId, closedPageId: args.pageId, pages: await this.sessions.pageList(sessionId) };
  }

  async goBack(target: BrowserTarget): Promise<Record<string, unknown>> {
    target = { ...target };
    return this.withTarget(target, async ({ sessionId, pageId, page, current, signal }) => {
      const response = await boundedBrowserCall({ action: 'back', deadlineMs: DEFAULT_NAVIGATION_TIMEOUT_MS, signal, next: 'Call action:"snapshot" to see where the page is.' },
        () => page.goBack({ timeout: DEFAULT_NAVIGATION_TIMEOUT_MS }));
      current();
      this.snapshots.clear(sessionId, pageId);
      return { sessionId, pageId, url: page.url(), moved: response !== null };
    });
  }

  async goForward(target: BrowserTarget): Promise<Record<string, unknown>> {
    target = { ...target };
    return this.withTarget(target, async ({ sessionId, pageId, page, current, signal }) => {
      const response = await boundedBrowserCall({ action: 'forward', deadlineMs: DEFAULT_NAVIGATION_TIMEOUT_MS, signal, next: 'Call action:"snapshot" to see where the page is.' },
        () => page.goForward({ timeout: DEFAULT_NAVIGATION_TIMEOUT_MS }));
      current();
      this.snapshots.clear(sessionId, pageId);
      return { sessionId, pageId, url: page.url(), moved: response !== null };
    });
  }

  /**
   * Reads data out of the page.
   *
   * This replaced an `evaluate` action that ran caller-supplied JavaScript in
   * the page. That action was guarded by searching the source for `fetch`,
   * `sendBeacon` and friends, a denylist standing between attacker-influenced
   * text and arbitrary code execution, which is a losing shape. An expression
   * built as `globalThis[atob('ZmV0Y2g=')]` defeats a string match while doing
   * exactly what the match existed to stop.
   *
   * So there is no longer any way to express code here. The caller supplies a
   * CSS selector or a ref and names the fields it wants; the function that runs
   * in the page is fixed, ships in this file, and reads DOM properties. A
   * network call is not something this contract can describe, not something we
   * try to notice.
   *
   * What that costs: running page functions, computing values in-page, and
   * poking at application state that never reaches the DOM. Interaction still
   * happens through click, type, select and press, which are checked; anything
   * computed can be computed here, from extracted data, where a page cannot
   * reach it.
   */
  async extract(
    target: BrowserTarget,
    args: {
      readonly ref?: string | undefined;
      readonly selector?: string | undefined;
      readonly fields?: readonly BrowserExtractField[] | undefined;
      readonly all?: boolean | undefined;
      readonly limit?: number | undefined;
    },
    ownership?: BrowserActionLifetime,
  ): Promise<Record<string, unknown>> {
    args = { ...args, ...(args.fields ? { fields: [...args.fields] } : {}) }; target = { ...target }; ownership = ownership && { ...ownership };
    const work = new BrowserControlIdentityWork(ownership);
    return this.withTarget(target, async ({ sessionId, pageId, page }) => {
      assertPageTextAllowed(this.cardGuard, sessionId, pageId);
      await this.requireReadableAddress(sessionId, pageId, page.url());
      const scope = this.refScope(sessionId, pageId, page, work, ownership);
      const fields = args.fields && args.fields.length > 0 ? args.fields : (['text'] as const);
      const limit = Math.max(1, Math.min(200, args.limit ?? (args.all === true ? 50 : 1)));

      let matched: number;
      const extracted: unknown[] = [];
      if (args.ref) {
        const { locator, revalidate, assertCurrent } = await scope.resolve(args.ref);
        await revalidate(); assertCurrent();
        matched = 1;
        extracted.push(await work.wait(() => locator.evaluate(readElementData, [...fields])));
        assertCurrent();
      } else {
        const selector = args.selector?.trim() || 'body';
        const all = page.locator(selector);
        matched = await work.wait(() => all.count().catch(() => 0));
        if (matched === 0) {
          throw new BrowserSessionError(
            `Nothing on this page matches ${selector}.`,
            'Call action:"snapshot" to see what is on the page, then extract by ref or by a selector that matches.',
          );
        }
        const take = args.all === true ? Math.min(matched, limit) : 1;
        for (let index = 0; index < take; index += 1) {
          extracted.push(await work.wait(() => all.nth(index).evaluate(readElementData, [...fields])));
        }
      }

      // Extracted field values are page-written text exactly as body text is,
      // a value lifted out of a form or a table is as good an injection carrier
      // as a paragraph, and recording the origin without the words would leave
      // the derivation check with nothing to compare against.
      // Scrubbed as one serialized blob, which covers every field the caller
      // asked for at once: `value` is the obvious one, and `html` and
      // `attributes` are the ones a page uses when it wants the number to come
      // back out somewhere nobody thought to check.
      const payload = this.scrub(sessionId, pageId, JSON.stringify(extracted));
      const origin = this.recordPageIngest(page.url(), payload);
      return {
        sessionId,
        pageId,
        url: page.url(),
        matched,
        returned: extracted.length,
        ...(matched > extracted.length
          ? { note: `Showing ${String(extracted.length)} of ${String(matched)} matches. Pass all:true with a limit to read more.` }
          : {}),
        // Whatever the page holds is still the page's own words.
        data: this.untrusted.label({
          origin,
          text: payload,
        }),
      };
    }, work);
  }

  async shutdown(): Promise<void> {
    await this.sessions.shutdown();
  }
}

export { BrowserSessionError, StaleElementError };
