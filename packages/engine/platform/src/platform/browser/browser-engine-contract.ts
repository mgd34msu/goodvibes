/**
 * browser-engine-contract.ts, the engine's option/target types, its error, and
 * the two pure helpers that neither read nor hold engine state.
 *
 * Split out of browser-engine.ts, which crossed the 800-line cap once the
 * untrusted-content boundary and the card-field guard both landed in it. Each
 * of those lanes kept the file under the cap on its own; the union did not.
 * Nothing here touches `BrowserEngine` state, so this is a move, not a
 * redesign: `readElementData` runs inside the page and closes over nothing,
 * and `normalizeUrl` is a pure string check.
 *
 * Every public name is re-exported from browser-engine.ts so the
 * `platform/browser` barrel's surface is unchanged, the same convention
 * orchestrator-runner.ts used when its context-window unit moved out.
 */
import { BrowserSessionError } from './browser-sessions.js';
import type { CardFieldGuard, OwnerApproval, UntrustedContentPort } from './browser-types.js';

/**
 * The one deadline table for every browser call, in-process and through the
 * attach host alike. Playwright reads 0 as "never", so no default here is 0:
 * a page that never finishes loading ends the call with a stated deadline
 * instead of holding the turn until someone closes the window.
 */
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
export const DEFAULT_ACTION_TIMEOUT_MS = 15_000;
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
/** The longest deadline a caller may ask for on one call. */
export const MAX_CALL_TIMEOUT_MS = 600_000;
export const DEFAULT_TEXT_LIMIT = 20_000;

/** A caller's timeoutMs when it is a usable deadline, otherwise the default. */
export function deadlineFor(requested: number | undefined, fallback: number): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return fallback;
  return Math.min(Math.ceil(requested), MAX_CALL_TIMEOUT_MS);
}

function seconds(ms: number): string {
  return ms % 1000 === 0 ? `${String(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Whether an error is the driver's own deadline. Playwright names it
 * `TimeoutError`; the attach host forwards that name as `timedOut`.
 */
export function isDeadlineError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'TimeoutError' || (error as { readonly timedOut?: unknown }).timedOut === true;
}

/**
 * Runs one browser wait to a deadline, and ends it at once when the caller's
 * signal aborts. The driver is given the same deadline, so its own work ends
 * too; the race only stops the caller waiting on a driver that does not take a
 * signal (navigation, load waits, page reads).
 */
export async function boundedBrowserCall<T>(
  call: { readonly action: string; readonly deadlineMs: number; readonly next: string; readonly signal?: AbortSignal | undefined },
  run: () => Promise<T>,
): Promise<T> {
  const { signal } = call;
  if (signal?.aborted) throw cancelledError(call.action);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const work = run();
  // A late failure of the abandoned driver call is already answered by the race.
  work.catch(() => undefined);
  const stop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(deadlineError(call)), call.deadlineMs + 1_000);
    onAbort = () => reject(cancelledError(call.action));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work, stop]);
  } catch (error) {
    if (isDeadlineError(error)) throw deadlineError(call);
    throw error;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

/** The refusal for a browser call that passed its deadline: the action, the deadline and the next step. */
export function deadlineError(call: { readonly action: string; readonly deadlineMs: number; readonly next: string }): BrowserSessionError {
  return new BrowserSessionError(
    `browser action:"${call.action}" did not finish within its ${seconds(call.deadlineMs)} deadline.`,
    `${call.next} To allow longer, pass timeoutMs (up to ${String(MAX_CALL_TIMEOUT_MS)}).`,
  );
}

function cancelledError(action: string): BrowserSessionError {
  return new BrowserSessionError(`browser action:"${action}" was cancelled.`, 'Nothing more is waiting on the page.');
}

/**
 * Schemes a page may be sent to.
 *
 * `javascript:` is refused outright. A javascript: URL is not navigation, it is
 * script injection into whatever is currently loaded, and it is exactly how a
 * bookmarklet ended up executing somewhere it was never meant to. Script that
 * needs to run in a page goes through action:"evaluate", which is scoped to a
 * page this engine controls and is reported as such.
 */
const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:', 'file:', 'about:']);

/** How far a URL reaches beyond the public web. */
export type NavigationReach = 'public' | 'local' | 'link-local';

function reachOfIpv4(octets: readonly number[]): NavigationReach {
  const [a = 0, b = 0] = octets;
  if (a === 169 && b === 254) return 'link-local';
  if (a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return 'local';
  return 'public';
}

/**
 * Whether opening this URL would read from the machine or its private network
 * instead of the public web. A page the agent navigates to is read back into
 * the conversation, so `file:` and private hosts are a way to read files and
 * internal services that the read tool's own filters never see.
 *
 * 'link-local' covers the cloud metadata addresses, which are never a page the
 * owner wants. The URL parser has already turned decimal, hex and octal IPv4
 * spellings into dotted form. A name that only resolves to a private address
 * through DNS is not detected here. Redirects and frames are: the engine
 * classifies the address the page ended on and every frame it reads, not only
 * the one requested.
 */
export function classifyNavigationTarget(url: string): NavigationReach {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return 'public'; }
  if (parsed.protocol === 'file:') return 'local';
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'public';
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'metadata.google.internal') return 'link-local';
  if (host === 'localhost' || host.endsWith('.localhost')) return 'local';
  const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (dotted) return reachOfIpv4(dotted.slice(1).map(Number));
  if (!host.includes(':')) return 'public';
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) {
    const high = Number.parseInt(mapped[1]!, 16), low = Number.parseInt(mapped[2]!, 16);
    return reachOfIpv4([high >> 8, high & 255, low >> 8, low & 255]);
  }
  if (/^fe[89ab][0-9a-f]:/.test(host) || host.startsWith('fd00:ec2:')) return 'link-local';
  if (host === '::1' || host === '::' || /^f[cd][0-9a-f]{2}:/.test(host)) return 'local';
  return 'public';
}

export interface BrowserTarget {
  readonly sessionId?: string | undefined;
  readonly pageId?: string | undefined;
  /** The caller's cancellation, normally the tool call's: aborting it ends every wait of this call. */
  readonly signal?: AbortSignal | undefined;
}

export interface BrowserEngineOptions {
  /** Where screenshots are written. Must be a directory the product's read path can open. */
  readonly screenshotDirectory: string;
  /**
   * The product's untrusted-content contract. Required, and deliberately not
   * defaulted: an engine with no port would read pages and label nothing, which
   * is the boundary silently absent rather than a compile error. The
   * implementation is expected to be backed by the process-wide ledger every
   * other surface that reads stranger-written text also writes to, the email
   * surface most of all, so "read a page, then send a message" is visible as
   * one composition rather than two unrelated acts.
   */
  readonly untrusted: UntrustedContentPort;
  /** An owner approval covering an outward action in this turn, when one exists. */
  readonly approval?: OwnerApproval | null;
  /**
   * Records that this session wrote a file, so the product's read path can open
   * it afterwards. Optional: a surface with no session write ledger passes
   * nothing and screenshots are simply written and reported.
   */
  readonly recordSessionWrite?: ((path: string) => void) | undefined;
  /**
   * Keeps card material out of everything a page hands back.
   *
   * Optional here so every existing caller keeps working, and NOT optional in
   * practice: the checkout flow refuses to type a card into an engine that
   * has none. A browser used for ordinary automation needs no guard; a browser
   * used to pay for something cannot be made to run without one.
   */
  readonly cardFieldGuard?: CardFieldGuard | undefined;
}

/** Fields the extraction contract can ask for. Nothing here can invoke anything. */
export type BrowserExtractField = 'text' | 'html' | 'value' | 'attributes';

/**
 * Runs in the page. Fixed, shipped in this file, and never assembled from
 * caller input: the caller only chooses which of these fields it wants.
 */
export function readElementData(element: Element, fields: string[]): Record<string, unknown> {
  const data: Record<string, unknown> = { tag: element.tagName.toLowerCase() };
  for (const field of fields) {
    if (field === 'text') {
      const text = (element as HTMLElement).innerText ?? element.textContent ?? '';
      data.text = text.replace(/\s+/g, ' ').trim().slice(0, 20_000);
    } else if (field === 'html') {
      data.html = element.outerHTML.slice(0, 20_000);
    } else if (field === 'value') {
      const input = element as HTMLInputElement;
      const type = (element.getAttribute('type') ?? '').toLowerCase();
      data.value = type === 'password' ? null : (input.value ?? null);
    } else if (field === 'attributes') {
      const attributes: Record<string, string> = {};
      for (const attribute of Array.from(element.attributes)) {
        attributes[attribute.name] = attribute.value.slice(0, 2_000);
      }
      data.attributes = attributes;
    }
  }
  return data;
}

export class UntrustedEffectError extends Error {
  constructor(message: string, readonly fix: string) {
    super(message);
    this.name = 'UntrustedEffectError';
  }
}

/**
 * Identity-provider hosts whose own sign-in routes this engine refuses to
 * click or type on, matched by hostname so a subdomain still counts.
 *
 * This is deliberately not specific to Google. The Google flows in
 * `platform/google/` already carry their own sign-in check
 * (`looksLikeGoogleSignIn` in `browser-elements.ts`) and bail out before this
 * code ever runs. This list exists for the path those flows do not cover: the
 * browser tool driven directly, one click/type call at a time, with no
 * structured flow watching for a sign-in redirect at all.
 */
const KNOWN_IDENTITY_PROVIDER_HOSTS: readonly RegExp[] = [
  /(^|\.)accounts\.google\.com$/i,
  /(^|\.)login\.microsoftonline\.com$/i,
  /(^|\.)login\.live\.com$/i,
  /(^|\.)appleid\.apple\.com$/i,
  /(^|\.)login\.yahoo\.com$/i,
  /(^|\.)github\.com$/i,
];

/** Path or query shape that reads as a sign-in step rather than ordinary browsing. */
const SIGN_IN_ROUTE_PATTERN = /(sign[\s_-]?in|log[\s_-]?in|authorize|oauth)/i;

/**
 * Legacy synchronous URL helper. Runtime browser actions use the snapshot's
 * password fact and the credential-page reading, never this predicate: a
 * sign-in route pattern also matches documentation about sign-in.
 * @deprecated Use the current native page observation in BrowserEngine.
 *
 * Two independent signals, either sufficient on its own:
 *   - a password-type field is present right now, which works for any site
 *     and needs no provider list at all;
 *   - the URL is on a known identity provider's own sign-in route, which
 *     catches the page before a password field has necessarily rendered yet
 *     (an email/identifier step, an account picker).
 *
 * `hasPasswordField` is supplied by the caller rather than computed here: the
 * engine already has either a stored snapshot or a live page to ask, and
 * which one it uses is a decision this pure function should not have to make.
 */
export function looksLikeCredentialPage(url: string, hasPasswordField: boolean): boolean {
  if (hasPasswordField) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!KNOWN_IDENTITY_PROVIDER_HOSTS.some((pattern) => pattern.test(parsed.hostname))) return false;
  return SIGN_IN_ROUTE_PATTERN.test(parsed.pathname) || SIGN_IN_ROUTE_PATTERN.test(parsed.search);
}

/**
 * What `launch()` tells the caller happened. Reuse is called out explicitly,
 * only one managed session runs at a time, so a second launch call getting
 * the same session back is a normal outcome, not a silent no-op.
 */
export function launchNote(session: { readonly reused: boolean; readonly headless: boolean; readonly sessionId: string }): string {
  if (session.reused) {
    return `Reusing the browser session already open (${session.sessionId}). Only one managed session runs at a time; call action:"close" first if a different profile is needed.`;
  }
  return session.headless
    ? 'Started headless. Pass headless:false to open a visible window for a sign-in.'
    : 'Started a visible window. Sign in once here and the profile keeps the login for later runs.';
}

export function normalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new BrowserSessionError('No url was given to navigate to.', 'Pass url:"https://example.com".');
  }
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new BrowserSessionError(`"${rawUrl}" is not a usable URL.`, 'Pass a full URL such as https://example.com.');
  }
  if (parsed.protocol === 'javascript:') {
    throw new BrowserSessionError(
      'Navigating to a javascript: URL is not supported, because it runs script against whatever page is currently open instead of loading a page.',
      'Use action:"evaluate" to run script in a page this tool controls.',
    );
  }
  if (!ALLOWED_URL_SCHEMES.has(parsed.protocol)) {
    throw new BrowserSessionError(
      `The ${parsed.protocol} scheme is not supported by the browser tool.`,
      'Use an http, https, file, or about URL.',
    );
  }
  return parsed.toString();
}

/** Retained caller observation checked at the final interactive effect boundary. */
export interface BrowserActionLifetime {
  readonly assertCurrent: () => void;
  readonly signal?: AbortSignal | undefined;
  readonly snapshotId?: string | undefined;
  /** Host-owned final observation, after other asynchronous checks, before dispatch. */
  readonly beforeDispatch?: (() => Promise<void>) | undefined;
}
