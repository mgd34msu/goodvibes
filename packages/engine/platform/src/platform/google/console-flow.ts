import { withGoogleDecisionWork } from './decision-work.js';
import { readConsoleStatus } from './console-reading.js';
/**
 * Drives the Google Auth Platform console
 * (console.cloud.google.com/auth/audience and .../auth/clients) for the three
 * things the OAuth setup path needs a browser for: reading and changing the
 * publishing status, and creating the Desktop app OAuth client.
 *
 * The publishing-status flows exist because of one verified fact (see
 * google-setup-plan.ts's header comment): an OAuth app left in "Testing"
 * issues refresh tokens that expire after seven days. `publishApp` never
 * reports success from having clicked "PUBLISH APP", it re-reads the status
 * afterward and only reports success once the re-read confirms the change
 * actually took.
 *
 * The OAuth client's secret is a credential and is returned only in the
 * dedicated `clientSecret` field of the `ok` result, never in `detail`,
 * `problem`, or `fix`.
 */

import { AUTH_AUDIENCE_URL, AUTH_CLIENTS_URL } from './setup-plan.js';
import { captureGooglePage, findElement, looksLikeGoogleSignIn, readTextUntil, requireElement } from './browser-elements.js';
import { consumeGoogleElement } from './browser-elements.js';
import { ownGoogleBrowser } from './browser-readings.js';
import type { JudgmentReadingOptions } from '@goodvibes/engine/errors';
import type { GoogleBrowserPort } from './types.js';

export type PublishingStatus = 'testing' | 'in-production' | 'unknown';

export type ConsoleReason =
  | 'sign-in-required'
  | 'project-not-selected'
  | 'status-not-found'
  | 'publish-button-not-found'
  | 'confirm-dialog-not-found'
  | 'publish-did-not-take'
  | 'publish-status-unreadable'
  | 'client-already-exists'
  | 'create-client-button-not-found'
  | 'application-type-not-found'
  | 'name-field-not-found'
  | 'create-button-not-found'
  | 'credentials-not-readable';

export interface ConsoleNeedsHuman {
  readonly kind: 'needs-human';
  readonly reason: ConsoleReason;
  readonly problem: string;
  readonly fix: string;
}

export interface ConsoleFailed {
  readonly kind: 'failed';
  readonly reason: ConsoleReason;
  readonly problem: string;
  readonly fix: string;
}

export interface ReadPublishingStatusOk {
  readonly kind: 'ok';
  readonly detail: string;
  readonly status: PublishingStatus;
}

export type ReadPublishingStatusResult = ReadPublishingStatusOk | ConsoleNeedsHuman | ConsoleFailed;

export interface PublishAppOk {
  readonly kind: 'ok';
  readonly detail: string;
  readonly status: 'in-production';
}

export type PublishAppResult = PublishAppOk | ConsoleNeedsHuman | ConsoleFailed;

export interface CreateDesktopOAuthClientOptions extends JudgmentReadingOptions {
  readonly name: string;
}

export interface CreateOAuthClientOk {
  readonly kind: 'ok';
  readonly detail: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export type CreateDesktopOAuthClientResult = CreateOAuthClientOk | ConsoleNeedsHuman | ConsoleFailed;

function signInNeeded(url: string): ConsoleNeedsHuman {
  return {
    kind: 'needs-human',
    reason: 'sign-in-required',
    problem: `Google is asking to sign in instead of showing the Google Auth Platform console (currently at ${url}).`,
    fix: 'Sign in to the Google account by hand in the open browser window, then re-run this step.',
  };
}



function projectNotSelectedNeeded(): ConsoleNeedsHuman {
  return {
    kind: 'needs-human',
    reason: 'project-not-selected',
    problem: 'The Google Auth Platform console is asking for a Cloud project to be selected before it will show anything.',
    fix: 'Open the Google Cloud console, select or create the project this integration uses, then re-run this step.',
  };
}

export interface ReadPublishingStatusOptions extends JudgmentReadingOptions {
  /**
   * Overrides the page navigated to. Defaults to the real Google Auth
   * Platform audience page. The only legitimate reason to override it is a
   * test driving this flow's real logic against a local fake page instead of
   * a live Google Cloud project, production callers never set this.
   */
  readonly pageUrl?: string;
}

/**
 * Reads the current publishing status from the audience page. Distinguishes
 * "not signed in" and "no project selected" from a genuine read failure.
 */
export async function readPublishingStatus(
  browser: GoogleBrowserPort,
  options: ReadPublishingStatusOptions = {},
): Promise<ReadPublishingStatusResult> {
  return withGoogleDecisionWork<ReadPublishingStatusResult>(options, async () => {
    browser = ownGoogleBrowser(browser, options).browser;
    const pageUrl = options.pageUrl ?? AUTH_AUDIENCE_URL;
    await browser.navigate(pageUrl);
    const { url, elements, text } = await captureGooglePage(browser);

    if (await looksLikeGoogleSignIn(url, elements, { browser })) {
      return signInNeeded(url);
    }

    const reading = await readConsoleStatus(text, options);
    if (reading.projectMissing) {
      return projectNotSelectedNeeded();
    }

    const status = reading.status;
    if (status === 'unknown') {
      return {
        kind: 'failed',
        reason: 'status-not-found',
        problem: 'Looked for the "Publishing status" text ("Testing" or "In production") on the audience page, but could not find either.',
        fix: `Open ${pageUrl} by hand and read the "Publishing status" box.`,
      };
    }

    return {
      kind: 'ok',
      detail: `Publishing status reads "${status === 'in-production' ? 'In production' : 'Testing'}".`,
      status,
    };
  });
}

/**
 * Clicks "PUBLISH APP", confirms the dialog, then re-reads the status to
 * verify it actually changed. Success is reported only from the re-read,
 * never from having clicked.
 */
export async function publishApp(
  browser: GoogleBrowserPort,
  options: ReadPublishingStatusOptions = {},
): Promise<PublishAppResult> {
  return withGoogleDecisionWork<PublishAppResult>(options, async () => {
    browser = ownGoogleBrowser(browser, options).browser;
    const pageUrl = options.pageUrl ?? AUTH_AUDIENCE_URL;
    const before = await readPublishingStatus(browser, options);
    if (before.kind !== 'ok') return before;
    if (before.status === 'in-production') {
      return { kind: 'ok', detail: 'Publishing status was already "In production"; nothing to change.', status: 'in-production' };
    }

    const elements = await browser.snapshot();
    const publishLookup = await requireElement(elements, { role: 'button', purpose: 'Publish this OAuth app to production', nameIncludes: 'publish app' }, { browser });
    if (!publishLookup.found) {
      return {
        kind: 'failed',
        reason: 'publish-button-not-found',
        problem: publishLookup.message,
        fix: `Open ${pageUrl} by hand and click "PUBLISH APP".`,
      };
    }
    await consumeGoogleElement(browser, publishLookup.element);

    const confirmElements = await browser.snapshot();
    const confirmLookup = await requireElement(confirmElements, { role: 'button', purpose: 'Confirm publishing this OAuth app to production in the confirmation dialog', nameIncludes: 'confirm' }, { browser });
    if (!confirmLookup.found) {
      return {
        kind: 'failed',
        reason: 'confirm-dialog-not-found',
        problem: confirmLookup.message,
        fix: 'Click "PUBLISH APP" by hand and confirm the dialog that asks to push the app to production.',
      };
    }
    await consumeGoogleElement(browser, confirmLookup.element);

    const after = await readPublishingStatus(browser, options);
    if (after.kind === 'ok' && after.status === 'in-production') {
      return {
        kind: 'ok',
        detail: 'Clicked "PUBLISH APP", confirmed the dialog, and the re-read status now shows "In production".',
        status: 'in-production',
      };
    }
    if (after.kind === 'ok' && after.status === 'testing') {
      return {
        kind: 'failed',
        reason: 'publish-did-not-take',
        problem: 'Clicked "PUBLISH APP" and confirmed the dialog, but re-reading the publishing status afterward still shows "Testing". Credentials created while the app stays in Testing will expire after seven days.',
        fix: `Open ${pageUrl} by hand, click "PUBLISH APP" again, confirm the dialog, and check the status box afterward.`,
      };
    }
    if (after.kind === 'ok') {
      // Status read back as neither "In production" nor "Testing", the page
      // rendered something this flow does not recognise. Reporting the publish
      // as successful here would be exactly the silent lie this step exists to
      // prevent, since an app left in Testing expires its credentials in seven
      // days without ever saying so.
      return {
        kind: 'failed',
        reason: 'publish-status-unreadable',
        problem:
          'Clicked "PUBLISH APP" and confirmed the dialog, but the publishing status could not be read back afterward, so there is no evidence the change took effect.',
        fix: `Open ${pageUrl} by hand and check that the "Publishing status" box reads "In production". If it still reads "Testing", click "PUBLISH APP" and confirm.`,
      };
    }
    return after;
  });
}

const CLIENT_ID_PATTERN = /[\w-]+\.apps\.googleusercontent\.com/g;
const CLIENT_SECRET_PATTERN = /GOCSPX-[\w-]+/g;

/**
 * The client id and secret the click produced: the first of each that was NOT
 * already on the page beforehand. The clients page lists every existing client
 * too, and pairing an older client's id with the new secret would store
 * credentials that fail at consent.
 */
function extractClientCredentials(text: string, before: string): { readonly clientId: string; readonly clientSecret: string } | null {
  const known = new Set([...before.matchAll(CLIENT_ID_PATTERN), ...before.matchAll(CLIENT_SECRET_PATTERN)].map((match) => match[0]));
  const clientId = [...text.matchAll(CLIENT_ID_PATTERN)].map((match) => match[0]).find((candidate) => !known.has(candidate));
  const clientSecret = [...text.matchAll(CLIENT_SECRET_PATTERN)].map((match) => match[0]).find((candidate) => !known.has(candidate));
  if (clientId === undefined || clientSecret === undefined) return null;
  return { clientId, clientSecret };
}

/**
 * Creates a Desktop app OAuth client named `options.name`. Detects a client
 * with that name already existing on the clients page and reports it as
 * `needs-human` instead of creating a duplicate.
 */
export async function createDesktopOAuthClient(
  browser: GoogleBrowserPort,
  options: CreateDesktopOAuthClientOptions,
): Promise<CreateDesktopOAuthClientResult> {
  return withGoogleDecisionWork<CreateDesktopOAuthClientResult>(options, async () => {
    browser = ownGoogleBrowser(browser, options).browser;
    const name = options.name;
    await browser.navigate(AUTH_CLIENTS_URL);
    const url = await browser.currentUrl();
    let elements = await browser.snapshot();

    if (await looksLikeGoogleSignIn(url, elements, { browser })) {
      return signInNeeded(url);
    }

    const existing = await findElement(elements, { purpose: `Find an existing OAuth client named exactly ${name}`, nameIncludes: name }, { browser });
    if (existing) {
      // Setup runs this step only when no complete client id and secret are
      // stored, so the listed client is one whose secret this machine never kept.
      return {
        kind: 'needs-human',
        reason: 'client-already-exists',
        problem: `An OAuth client named "${name}" already exists in the Cloud project, and its client id and secret are not stored on this machine.`,
        fix: `Open ${AUTH_CLIENTS_URL}, open the client "${name}", add a new client secret there (Google shows a secret only when it is created), and enter the client id and that secret in setup by hand; or delete the client and re-run this step to create a fresh one.`,
      };
    }

    const createClientLookup = await requireElement(elements, { role: 'button', purpose: 'Open the new OAuth client creation form', nameIncludes: 'create client' }, { browser });
    if (!createClientLookup.found) {
      return {
        kind: 'failed',
        reason: 'create-client-button-not-found',
        problem: createClientLookup.message,
        fix: `Open ${AUTH_CLIENTS_URL} by hand and click "CREATE CLIENT".`,
      };
    }
    // The clients page names every existing client: none of those ids can be the new one.
    const clientsListText = await browser.readText();
    await consumeGoogleElement(browser, createClientLookup.element);

    elements = await browser.snapshot();
    const typeLookup = await requireElement(elements, { purpose: 'Open the application type selector for the new OAuth client', nameIncludes: 'application type' }, { browser });
    if (!typeLookup.found) {
      return {
        kind: 'failed',
        reason: 'application-type-not-found',
        problem: typeLookup.message,
        fix: 'Click "CREATE CLIENT" by hand and choose "Desktop app" as the application type.',
      };
    }
    await consumeGoogleElement(browser, typeLookup.element);

    elements = await browser.snapshot();
    const desktopOptionLookup = await requireElement(elements, { purpose: 'Choose Desktop app as the OAuth application type', nameIncludes: 'desktop app' }, { browser });
    if (!desktopOptionLookup.found) {
      return {
        kind: 'failed',
        reason: 'application-type-not-found',
        problem: desktopOptionLookup.message,
        fix: 'Open the "Application type" dropdown by hand and choose "Desktop app".',
      };
    }
    await consumeGoogleElement(browser, desktopOptionLookup.element);

    elements = await browser.snapshot();
    const nameLookup = await requireElement(elements, { role: 'textbox', purpose: 'Name the new Desktop OAuth client', nameIncludes: 'name' }, { browser });
    if (!nameLookup.found) {
      return {
        kind: 'failed',
        reason: 'name-field-not-found',
        problem: nameLookup.message,
        fix: `Type "${name}" into the client "Name" field by hand.`,
      };
    }
    await consumeGoogleElement(browser, nameLookup.element, name);

    elements = await browser.snapshot();
    const createButtonLookup = await requireElement(elements, { role: 'button', purpose: 'Submit the completed Desktop OAuth client creation form', nameIncludes: 'create' }, { browser });
    if (!createButtonLookup.found) {
      return {
        kind: 'failed',
        reason: 'create-button-not-found',
        problem: createButtonLookup.message,
        fix: 'Click "Create" by hand to finish creating the OAuth client.',
      };
    }
    const textBeforeCreate = await browser.readText();
    await consumeGoogleElement(browser, createButtonLookup.element);

    // The id and secret appear in a dialog once Google has created the client,
    // a network round trip after the click.
    const known = `${clientsListText}\n${textBeforeCreate}`;
    const credentials = await readTextUntil(browser, (text) => extractClientCredentials(text, known), { signal: options.signal });
    if (!credentials) {
      return {
        kind: 'failed',
        reason: 'credentials-not-readable',
        problem: `Clicked "Create" but the client ID and client secret did not appear in the result dialog. Google may have created the client "${name}" anyway.`,
        fix: `Open ${AUTH_CLIENTS_URL}, open the client "${name}", add a new client secret there (Google shows a secret only when it is created), and enter the client id and that secret in setup by hand.`,
      };
    }

    return {
      kind: 'ok',
      detail: `Created a Desktop app OAuth client named "${name}".`,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    };
  });
}
