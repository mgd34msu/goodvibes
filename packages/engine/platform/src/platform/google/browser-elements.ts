/**
 * Purpose-grounded Google setup controls. Readings are observations, not action
 * authorization.
 *
 * Each step observes the page once, asks against that capture, and acts with
 * the capture's snapshot id as the precondition: the browser engine refuses a
 * click or keystroke whose snapshot is no longer the page's current one, which
 * is the one check that sits at the effect. A refused action re-observes and
 * acts once more on the same control when it is still there.
 */

import type { GoogleBrowserElement, GoogleBrowserPort } from './types.js';
import { googleCallerCurrent, preserveGoogleDecisionFailure } from './decision-work.js';
import { decisionOrClassic } from '../runtime/decision-policy.js';
import { googleSetupControl, googleSignInPage, googleTwoStepPage, googleAppPasswordPage, googleControlSnapshot, admitGoogleControlMetadata, googleReadingOwner, GoogleReadingError, latestGoogleSnapshot, type GoogleReadingOptions } from './browser-readings.js';
import { snapshotJudgmentInput } from '../gate/judgment-input.js';
import { StaleElementError } from '../browser/index.js';

export interface GoogleElementQuery {
  /** The action or observation this control must serve, not a substring filter. */
  readonly purpose?: string;
  readonly role?: string;
  readonly nameIncludes?: string;
  readonly namePattern?: RegExp;
  readonly tag?: string;
}

/** What a chosen control may be acted on with: the browser and capture it was read from, and the reading's lifetime. */
interface SelectionLease {
  readonly browser: GoogleBrowserPort | undefined;
  readonly source: readonly GoogleBrowserElement[];
  readonly signal: AbortSignal | undefined;
  readonly assertOwner: () => void;
}
const selected = new WeakMap<GoogleBrowserElement, SelectionLease>();

/** All structurally eligible candidates participate; no first-match fallback. */
export async function findElement(
  elements: readonly GoogleBrowserElement[],
  query: GoogleElementQuery,
  options: GoogleReadingOptions = {},
): Promise<GoogleBrowserElement | null> {
  try {
    const snapshot = googleControlSnapshot(elements);
    const request = snapshotJudgmentInput({ purpose: query.purpose, nameIncludes: query.nameIncludes,
      role: query.role, tag: query.tag, pattern: query.namePattern?.source, flags: query.namePattern?.flags });
    const context = snapshotJudgmentInput({ ...request as object,
      purpose: query.purpose ?? query.nameIncludes ?? 'Select the control matching the supplied structural constraints' });
    const pattern = query.namePattern ? new RegExp(query.namePattern.source, query.namePattern.flags.replace(/[gy]/g, '')) : undefined;
    const candidates = snapshot.filter(element => element.disabled !== true && (!query.role || element.role.toLowerCase() === query.role.toLowerCase())
      && (!query.tag || element.tag.toLowerCase() === query.tag.toLowerCase())
      && (!pattern || pattern.test(element.name)));
    if (!candidates.length) return null;
    const chosen = await decisionOrClassic<{ readonly element: GoogleBrowserElement; readonly signal: AbortSignal | undefined; readonly assertOwner: () => void } | null>(async () => {
      const owner = googleReadingOwner('google.setup.control', options);
      const reading = await googleSetupControl.select(owner.port, context as never,
        candidates.map((element, index) => ({ id: `control_${index}`, content: { role: element.role, name: element.name, tag: element.tag } })),
        { site: 'google.setup.control', signal: owner.signal });
      if (reading.outcome !== 'act') throw new GoogleReadingError();
      if (reading.chosen === undefined) { reading.recordAction('no suitable Google setup control'); return null; }
      const index = candidates.findIndex((_, index) => `control_${index}` === reading.chosen);
      if (index < 0) throw new GoogleReadingError();
      reading.recordAction('selected an offered Google setup control');
      return { element: candidates[index]!, signal: owner.signal, assertOwner: owner.assertCurrent };
    }, () => {
      const element = controlByLabel(candidates, query);
      return element === null ? null : { element, signal: options.signal, assertOwner: googleCallerCurrent(options) };
    });
    if (chosen === null) return null;
    const element = Object.freeze({ ...chosen.element });
    selected.set(element, { browser: options.browser, source: elements, signal: chosen.signal, assertOwner: chosen.assertOwner });
    return element;
  } catch (error) { preserveGoogleDecisionFailure(error, options); throw new GoogleReadingError(); }
}

const foldLabel = (text: string): string => text.normalize('NFC').toLocaleLowerCase().replace(/\s+/gu, ' ').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/**
 * The code reading of a control, with no decision model in use: the one
 * eligible control whose label is the query's `nameIncludes` text, else the one
 * whose label contains it (case and spacing ignored). Two or more equally
 * matching controls, or a query that names only a purpose, choose none, so the
 * step reports what the page showed and the manual step instead of guessing.
 */
function controlByLabel(candidates: readonly GoogleBrowserElement[], query: GoogleElementQuery): GoogleBrowserElement | null {
  if (query.nameIncludes === undefined) return query.namePattern !== undefined && candidates.length === 1 ? candidates[0]! : null;
  const wanted = foldLabel(query.nameIncludes);
  if (!wanted) return null;
  const exact = candidates.filter(element => foldLabel(element.name) === wanted);
  if (exact.length > 0) return exact.length === 1 ? exact[0]! : null;
  const containing = candidates.filter(element => foldLabel(element.name).includes(wanted));
  return containing.length === 1 ? containing[0]! : null;
}

/**
 * The ref of the control with the chosen control's role and name in a later
 * capture, when exactly one such control is there.
 */
function sameControl(element: GoogleBrowserElement, elements: readonly GoogleBrowserElement[]): string {
  const same = googleControlSnapshot(elements).filter((control) => control.disabled !== true && control.role === element.role && control.name === element.name);
  if (same.length !== 1) {
    throw new GoogleReadingError(`The Google setup page changed after the ${element.role} "${element.name}" was chosen, and it is no longer on the page once. Re-run this step.`);
  }
  return same[0]!.ref;
}

/**
 * Act on a chosen control. A ref belongs to the capture it was read from, so a
 * control chosen from an earlier capture is found again, by role and name, in
 * the latest one. The engine refuses the action when the page changed since
 * that capture; then the page is observed once more and the action repeated
 * once on the same control.
 */
export async function consumeGoogleElement(browser: GoogleBrowserPort, element: GoogleBrowserElement, text?: string): Promise<void> {
  const lease = selected.get(element);
  if (!lease || lease.browser !== browser) throw new GoogleReadingError();
  selected.delete(element);
  lease.assertOwner();
  const act = (ref: string): Promise<void> => text === undefined
    ? browser.click(ref, { signal: lease.signal, assertCurrent: lease.assertOwner })
    : browser.type(ref, text, { signal: lease.signal, assertCurrent: lease.assertOwner });
  const latest = latestGoogleSnapshot(browser);
  try {
    await act(latest === undefined || latest === lease.source ? element.ref : sameControl(element, latest));
  } catch (error) {
    if (!(error instanceof StaleElementError)) throw error;
    await act(sameControl(element, await browser.snapshot()));
  }
  lease.assertOwner();
}

/** Describes what a query was looking for, in plain language. */
function describeQuery(query: GoogleElementQuery): string {
  const parts: string[] = [];
  if (query.role) parts.push(`role "${query.role}"`);
  if (query.tag) parts.push(`tag "${query.tag}"`);
  if (query.purpose) parts.push(`purpose "${query.purpose}"`);
  if (query.nameIncludes) parts.push(`a name containing "${query.nameIncludes}"`);
  if (query.namePattern) parts.push(`a name matching ${query.namePattern.toString()}`);
  return parts.length > 0 ? `an element with ${parts.join(' and ')}` : 'an element matching an empty query';
}

const DEFAULT_CANDIDATE_LIMIT = 10;

/** A short, human-readable listing of elements actually present, for diagnostics. */
export function describeElements(
  elements: readonly GoogleBrowserElement[],
  limit: number = DEFAULT_CANDIDATE_LIMIT,
): string {
  if (elements.length === 0) return 'no interactive elements were found in the snapshot';
  let safe: readonly GoogleBrowserElement[];
  try { safe = googleControlSnapshot(elements); } catch { return 'controls whose labels cannot safely be displayed'; }
  const sample = safe.slice(0, limit);
  const described = sample.map((element) => `${element.role} "${element.name}"`).join(', ');
  const remaining = elements.length - sample.length;
  return remaining > 0 ? `${described}, and ${String(remaining)} more` : described;
}

export interface GoogleElementFound {
  readonly found: true;
  readonly element: GoogleBrowserElement;
}

export interface GoogleElementNotFound {
  readonly found: false;
  readonly query: GoogleElementQuery;
  readonly candidateCount: number;
  /** Plain-language failure statement: what was looked for, what was there instead. */
  readonly message: string;
}

export type GoogleElementLookup = GoogleElementFound | GoogleElementNotFound;

/**
 * Like `findElement`, but the miss carries a typed, descriptive result instead
 * of `null`, the failure mode this module exists to make impossible to get
 * wrong silently.
 */
export async function requireElement(
  elements: readonly GoogleBrowserElement[],
  query: GoogleElementQuery,
  options: GoogleReadingOptions = {},
): Promise<GoogleElementLookup> {
  const element = await findElement(elements, query, options);
  if (element) return { found: true, element };
  const message = `Looked for ${describeQuery(query)}, but the page showed ${String(elements.length)} control${
    elements.length === 1 ? '' : 's'
  } instead: ${describeElements(elements)}.`;
  return { found: false, query, candidateCount: elements.length, message };
}

/** A settled typed page reading. Unknown/unavailable is never "signed in". */
export async function looksLikeGoogleSignIn(url: string, elements: readonly GoogleBrowserElement[], options: GoogleReadingOptions = {}): Promise<boolean> {
  try {
    return await decisionOrClassic(async () => {
      const state = snapshotJudgmentInput({ url, elements: googleControlSnapshot(elements) });
      const owner = googleReadingOwner('google.setup.sign-in-page', options);
      const run = await googleSignInPage.run(owner.port, state as never, { site: 'google.setup.sign-in-page', signal: owner.signal });
      const reading = run.readings.signIn;
      if (reading.outcome !== 'act' || reading.verdict === 'uncertain') throw new GoogleReadingError();
      run.recordAction('returned settled Google sign-in page state');
      return reading.verdict === 'yes';
    }, () => signInByAddress(url));
  } catch (error) { preserveGoogleDecisionFailure(error, options); throw new GoogleReadingError(); }
}

/**
 * The code reading of a sign-in wall: Google sends every sign-in, account
 * choice and reauthentication to accounts.google.com, and serves the account,
 * console and calendar pages from other hosts. An address that does not parse
 * is not read as either.
 */
function signInByAddress(url: string): boolean {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { throw new GoogleReadingError(); }
  return host === 'accounts.google.com';
}

/** One observation of a setup page: its address, its controls and its text, read once. */
export interface GooglePageCapture {
  readonly url: string;
  readonly elements: readonly GoogleBrowserElement[];
  readonly text: string;
}

/** Read the page once. The snapshot taken here is the one any later action on its controls is checked against. */
export async function captureGooglePage(browser: GoogleBrowserPort): Promise<GooglePageCapture> {
  const url = await browser.currentUrl();
  const elements = await browser.snapshot();
  const text = await browser.readText();
  return { url, elements, text };
}

function pageState(page: GooglePageCapture): unknown {
  admitGoogleControlMetadata({ url: page.url, text: page.text });
  if (page.text.length > 160_000) throw new GoogleReadingError();
  return snapshotJudgmentInput({ url: page.url, elements: googleControlSnapshot(page.elements), text: page.text });
}

/** Read the observed setting without changing it. */
export async function readGoogleTwoStepState(browser: GoogleBrowserPort, options: GoogleReadingOptions & { readonly page?: GooglePageCapture } = {}): Promise<'on' | 'off' | 'unknown'> {
  try {
    const page = options.page ?? await captureGooglePage(browser);
    return await decisionOrClassic<'on' | 'off' | 'unknown'>(async () => {
      const owner = googleReadingOwner(googleTwoStepPage.name, options);
      const state = pageState(page);
      const run = await googleTwoStepPage.run(owner.port, state as never, { site: googleTwoStepPage.name, signal: owner.signal });
      const { enabled, disabled } = run.readings;
      const on = enabled.verdict === 'yes' && enabled.outcome === 'act';
      const off = disabled.verdict === 'yes' && disabled.outcome === 'act';
      const setting = on === off ? 'unknown' : on ? 'on' : 'off';
      run.recordAction('Report the observed 2-Step Verification setting; no account setting was changed.');
      return setting;
    }, () => twoStepByText(page));
  } catch (error) { preserveGoogleDecisionFailure(error, options); return 'unknown'; }
}

/**
 * The code reading of the 2-Step Verification setting: Google's own status
 * sentence ("2-Step Verification is on" / "is off") or its "Turn on 2-Step
 * Verification" control. A page in another language, or one stating both, reads
 * as unknown.
 */
function twoStepByText(page: GooglePageCapture): 'on' | 'off' | 'unknown' {
  const on = /\b2-Step Verification is on\b/i.test(page.text);
  const off = /\b2-Step Verification is off\b/i.test(page.text)
    || page.elements.some(element => foldLabel(element.name) === 'turn on 2-step verification');
  return on === off ? 'unknown' : on ? 'on' : 'off';
}

export async function readGoogleAppPasswordState(browser: GoogleBrowserPort, label: string, options: GoogleReadingOptions & { readonly page?: GooglePageCapture } = {}): Promise<{ readonly twoStepRequired: boolean; readonly labelExists: boolean }> {
  const page = options.page ?? await captureGooglePage(browser);
  return decisionOrClassic(async () => {
    const labelState = snapshotJudgmentInput({ label });
    const owner = googleReadingOwner(googleAppPasswordPage.name, options);
    const state = pageState(page);
    const run = await googleAppPasswordPage.run(owner.port, { ...(state as object), ...(labelState as object) },
      { site: googleAppPasswordPage.name, signal: owner.signal });
    const { twoStepRequired, labelExists } = run.readings;
    if ([twoStepRequired, labelExists].some(reading => reading.outcome !== 'act' || reading.verdict === 'uncertain')) throw new GoogleReadingError();
    run.recordAction('Observe app-password prerequisites and label presence; browser writes require separate control selection.');
    return { twoStepRequired: twoStepRequired.verdict === 'yes', labelExists: labelExists.verdict === 'yes' };
  }, () => appPasswordPageByLabels(page, label));
}

/**
 * The code reading of the app-password page: an existing entry is a control
 * other than a text field whose label carries the requested label; 2-Step
 * Verification blocks creation only when there is no "App name" field and the
 * page says to turn it on or that it is off.
 */
function appPasswordPageByLabels(page: GooglePageCapture, label: string): { readonly twoStepRequired: boolean; readonly labelExists: boolean } {
  const wanted = foldLabel(label);
  const form = page.elements.some(element => element.role === 'textbox' && foldLabel(element.name).includes('app name'));
  const labelExists = wanted.length > 0 && page.elements.some(element => element.role !== 'textbox' && foldLabel(element.name).includes(wanted));
  const twoStepRequired = !form && /\b(?:turn on|set up) 2-Step Verification\b|\b2-Step Verification is off\b/i.test(page.text);
  return { twoStepRequired, labelExists };
}

/**
 * Read the page text until `found` recognises what an action produced, a few
 * times with a short pause between reads. A result dialog appears after the
 * network round trip its click starts, so the read straight after the click
 * often comes too early. Returns null when it never appears.
 */
export async function readTextUntil<T>(
  browser: GoogleBrowserPort,
  found: (text: string) => T | null,
  options: { readonly attempts?: number; readonly delayMs?: number; readonly signal?: AbortSignal | undefined } = {},
): Promise<T | null> {
  const attempts = options.attempts ?? RESULT_READ_ATTEMPTS;
  const delayMs = options.delayMs ?? RESULT_READ_DELAY_MS;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await pause(delayMs, options.signal);
    const result = found(await browser.readText());
    if (result !== null) return result;
  }
  return null;
}

const RESULT_READ_ATTEMPTS = 5;
const RESULT_READ_DELAY_MS = 250;

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = (): void => { clearTimeout(timer); reject(signal?.reason); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Best-effort DOM tag guessed from an accessible role. */
const ROLE_TAG_HINTS: Readonly<Record<string, string>> = {
  button: 'button',
  link: 'a',
  textbox: 'input',
  searchbox: 'input',
  combobox: 'select',
  checkbox: 'input',
  radio: 'input',
  switch: 'input',
  option: 'option',
  heading: 'h2',
  label: 'label',
  tab: 'div',
  menuitem: 'div',
};

/**
 * The shared role-to-tag guess.
 *
 * Exported because every `GoogleBrowserPort` implementation faces the same
 * problem, an accessibility snapshot reports a role, not a tag, and the
 * guess should be one shared answer rather than re-invented per surface.
 * Returns `'div'` for any role with no better guess.
 */
export function deriveTagFromRole(role: string): string {
  return ROLE_TAG_HINTS[role.toLowerCase()] ?? 'div';
}
