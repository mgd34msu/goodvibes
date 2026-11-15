import { withGoogleDecisionWork } from './decision-work.js';
/**
 * Drives Google's app-password page (https://myaccount.google.com/apppasswords)
 * to create a 16-character app password with a known label.
 *
 * Three states are not "ready" and are detected and returned distinctly
 * instead of retried in a loop:
 *
 *  - `sign-in-required` , Google redirected to a sign-in page.
 *  - `two-step-required`, the account has no 2-Step Verification, so Google
 *                           makes app passwords unavailable outright.
 *  - `label-already-exists`, an app password with this label is already
 *                              listed. Google never re-displays an existing
 *                              password, so the only way forward is reusing
 *                              the one already stored, or deleting that entry
 *                              and re-running. Detecting this is what makes
 *                              the flow idempotent instead of piling up
 *                              duplicate app passwords on every re-run.
 *
 * The created password is returned only in the dedicated `password` field of
 * the `ok` result. It is never written into `detail`, `problem`, or `fix`,
 * those are the strings that get logged and shown in error messages.
 */

import { APP_PASSWORD_LABEL, APP_PASSWORD_URL, TWO_STEP_URL } from './setup-plan.js';
import { captureGooglePage, describeElements, findElement, looksLikeGoogleSignIn, readGoogleAppPasswordState, readTextUntil, requireElement } from './browser-elements.js';
import { consumeGoogleElement } from './browser-elements.js';
import { ownGoogleBrowser } from './browser-readings.js';
import type { JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import type { GoogleBrowserPort } from './types.js';

export type AppPasswordReason =
  | 'sign-in-required'
  | 'two-step-required'
  | 'label-already-exists'
  | 'create-form-not-found'
  | 'result-dialog-not-found';

export interface AppPasswordOk {
  readonly kind: 'ok';
  readonly detail: string;
  readonly password: string;
}

export interface AppPasswordNeedsHuman {
  readonly kind: 'needs-human';
  readonly reason: AppPasswordReason;
  readonly problem: string;
  readonly fix: string;
}

export interface AppPasswordFailed {
  readonly kind: 'failed';
  readonly reason: AppPasswordReason;
  readonly problem: string;
  readonly fix: string;
}

export type CreateAppPasswordResult = AppPasswordOk | AppPasswordNeedsHuman | AppPasswordFailed;

export interface CreateAppPasswordOptions extends JudgmentReadingOptions {
  readonly label?: string;
  /**
   * Overrides the page navigated to. Defaults to Google's real app-password
   * page. The only legitimate reason to override it is a test driving this
   * flow's real logic against a local fake page instead of a live Google
   * account, production callers never set this.
   */
  readonly pageUrl?: string;
}

function signInNeeded(url: string): AppPasswordNeedsHuman {
  return {
    kind: 'needs-human',
    reason: 'sign-in-required',
    problem: `Google is asking to sign in instead of showing the app-password page (currently at ${url}).`,
    fix: 'Sign in to the Google account by hand in the open browser window, complete any 2-Step Verification prompt, then re-run this step.',
  };
}

function twoStepNeeded(): AppPasswordNeedsHuman {
  return {
    kind: 'needs-human',
    reason: 'two-step-required',
    problem: 'This Google account does not have 2-Step Verification on, so Google does not offer app passwords at all.',
    fix: `Open ${TWO_STEP_URL}, turn on 2-Step Verification, then re-run this step.`,
  };
}

function alreadyExists(label: string, pageUrl: string): AppPasswordNeedsHuman {
  return {
    kind: 'needs-human',
    reason: 'label-already-exists',
    problem: `An app password labeled "${label}" is already listed on this page. Google never re-displays an existing app password's value.`,
    fix: `Reuse the app password already stored for "${label}", or delete that entry on ${pageUrl} and re-run this step to create a fresh one.`,
  };
}

/**
 * Google renders the password in four groups of four letters, e.g. "abcd efgh ijkl mnop".
 * The lookahead makes every word start a candidate window, so a run of prose
 * words ending just before the password cannot swallow its first group.
 */
const RAW_PASSWORD_PATTERN = /\b(?=([A-Za-z]{4})[\s-]([A-Za-z]{4})[\s-]([A-Za-z]{4})[\s-]([A-Za-z]{4})\b)/g;

interface PasswordCandidate {
  readonly words: readonly string[];
  readonly password: string;
}

function passwordCandidates(text: string): PasswordCandidate[] {
  return [...text.matchAll(RAW_PASSWORD_PATTERN)].map((match) => {
    const words = [match[1], match[2], match[3], match[4]].map((word) => (word ?? '').toLowerCase());
    return { words, password: words.join('') };
  });
}

/**
 * The first four-by-four-letter group made only of words that were NOT on the
 * page before "Create" was clicked: ordinary prose can look like one ("Name
 * that will help with"), and only text the click brought in can be the new
 * password.
 */
function extractPassword(text: string, wordsBefore: ReadonlySet<string>): string | null {
  const found = passwordCandidates(text).find((candidate) => candidate.words.every((word) => !wordsBefore.has(word)));
  return found === undefined ? null : found.password;
}

function wordsOnPage(text: string): ReadonlySet<string> {
  return new Set((text.toLowerCase().match(/[a-z]+/g) ?? []));
}

/**
 * Creates a Google app password under `label` (default: `APP_PASSWORD_LABEL`).
 * Never throws for any of the three known non-ready states; each is reported
 * as a typed `needs-human` result instead.
 */
export async function createAppPassword(
  browser: GoogleBrowserPort,
  options: CreateAppPasswordOptions = {},
): Promise<CreateAppPasswordResult> {
  return withGoogleDecisionWork<CreateAppPasswordResult>(options, async () => {
    browser = ownGoogleBrowser(browser, options).browser;
    const label = options.label ?? APP_PASSWORD_LABEL;
    const pageUrl = options.pageUrl ?? APP_PASSWORD_URL;

    await browser.navigate(pageUrl);
    // One observation for every reading of this page and the first action on it.
    const observed = await captureGooglePage(browser);
    let elements = observed.elements;

    if (await looksLikeGoogleSignIn(observed.url, elements, { browser })) {
      return signInNeeded(observed.url);
    }

    const page = await readGoogleAppPasswordState(browser, label, { page: observed });
    if (page.twoStepRequired) return twoStepNeeded();
    if (page.labelExists) return alreadyExists(label, pageUrl);

    const nameFieldLookup = await requireElement(elements, { role: 'textbox', purpose: 'Name the new Google app password', nameIncludes: 'app name' }, { browser });
    if (!nameFieldLookup.found) {
      const createLookup = await requireElement(elements, { role: 'button', purpose: 'Create the app password using the completed app-name form' }, { browser });
      if (!createLookup.found) return { kind: 'needs-human', reason: 'create-form-not-found', problem: 'The app-password creation form is unavailable; the page does not establish why.', fix: `Open ${pageUrl} and review the account’s app-password availability.` };
      return {
        kind: 'failed', reason: 'create-form-not-found', problem: nameFieldLookup.message,
        fix: `Open ${pageUrl} by hand, type "${label}" into the "App name" field, and click "Create".`,
      };
    }

    await consumeGoogleElement(browser, nameFieldLookup.element, label);
    elements = await browser.snapshot();
    const createButtonLookup = await requireElement(elements, { role: 'button', purpose: 'Create the app password using the completed app-name form' }, { browser });
    if (!createButtonLookup.found) return { kind: 'failed', reason: 'create-form-not-found', problem: createButtonLookup.message, fix: 'Review the app-password form by hand.' };
    const textBeforeCreate = wordsOnPage(await browser.readText());
    await consumeGoogleElement(browser, createButtonLookup.element);

    const passwordText = await readTextUntil(browser, (text) => extractPassword(text, textBeforeCreate), { signal: options.signal });

    if (!passwordText) {
      elements = await browser.snapshot();
      return {
        kind: 'failed',
        reason: 'result-dialog-not-found',
        problem: `Clicked "Create" but no 16-character app password could be read back afterward. The page showed ${describeElements(elements)}.`,
        fix: `Open ${pageUrl} by hand, check whether an app password named "${label}" was created, and store it manually if so.`,
      };
    }

    return {
      kind: 'ok',
      detail: `Created an app password labeled "${label}".`,
      password: passwordText,
    };
  });
}

// Re-exported so tests and other flow modules can build fake snapshots that
// exercise the same matching this flow relies on, without duplicating it.
export { findElement };
