import { cdpEndpointCandidates, cdpWebSocketHandshakeWorks, debuggerWebSocket, firstReachableCdpEndpoint, type ReachableCdpEndpoint } from './browser-cdp.js';
export { cdpEndpointCandidates } from './browser-cdp.js';
export type { ReachableCdpEndpoint } from './browser-cdp.js';
import { assertProvisionCurrent, ownProvisionLifetime, type BrowserProvisionLifetime } from './browser-failure-reading.js';
import { readBrowserLaunchCause } from './launch-reading.js';
import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { OwnedWork } from '../utils/owned-work.js';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { resolveSurfaceDirectory } from '../runtime/surface-root.js';
import { BrowserHostClient, remoteContext, type BrowserHostOptions } from './browser-host-client.js';
import { createBrowserProvisionIo, DRIVER_VERSION, loadDriverModule } from './browser-provision-io.js';
import { ensureBrowserBinary } from './browser-provisioning.js';
import type {
  BrowserLaunchResult,
  BrowserPageInfo,
  BrowserProvisionIo,
  BrowserProvisionReport,
  BrowserSessionInfo,
  BrowserSessionOrigin,
} from './browser-types.js';

/**
 * Chromium flags that stop the profile from advertising itself as
 * remote-controlled. Sites that refuse to sign in inside an automated browser
 * key off exactly these signals; a persistent profile is useless if the user
 * cannot complete a login in it once.
 */
const STEALTH_ARGS: readonly string[] = [
  '--disable-blink-features=AutomationControlled',
  '--no-default-browser-check',
  '--no-first-run',
];

/** Default flags Playwright adds that mark the browser as automated. */
const SUPPRESSED_DEFAULT_ARGS: readonly string[] = ['--enable-automation'];

export interface BrowserLaunchOptions extends BrowserProvisionLifetime {
  readonly profileName?: string | undefined;
  readonly headless?: boolean | undefined;
  readonly viewport?: { readonly width: number; readonly height: number } | undefined;
}

export interface BrowserAttachOptions {
  /** A CDP endpoint of a browser the user already has running. */
  readonly cdpEndpoint: string;
}

export class BrowserSessionError extends Error {
  constructor(message: string, readonly fix: string | null = null) {
    super(message);
    this.name = 'BrowserSessionError';
  }
}

interface TrackedPage {
  readonly pageId: string;
  readonly page: Page;
}

interface TrackedSession {
  readonly sessionId: string;
  readonly origin: BrowserSessionOrigin;
  readonly context: BrowserContext;
  readonly browser: Browser | null;
  readonly profileDirectory: string | null;
  readonly cdpEndpoint: string | null;
  readonly executablePath: string | null;
  readonly source: BrowserProvisionReport['source'];
  readonly headless: boolean;
  readonly startedAt: string;
  readonly pages: Map<string, TrackedPage>;
  activePageId: string | null;
  pageCounter: number;
}

/**
 * Where saved browser profiles live under a home directory the caller owns.
 *
 * The surface root is the product's own segment under `~/.goodvibes/`, passed
 * in rather than hardcoded, so two surfaces sharing a machine never share a
 * profile directory.
 */
export function browserProfileRoot(homeDirectory: string, surfaceRoot: string): string {
  return resolveSurfaceDirectory(homeDirectory, surfaceRoot, 'browser', 'profiles');
}

/**
 * Where screenshots go: the platform's surface-scoped storage root, alongside
 * profiles. Not a visible folder in someone's project, a surface's own files
 * belong in that surface's own place, and session write provenance is what lets
 * it read them back.
 */
export function browserScreenshotRoot(homeDirectory: string, surfaceRoot: string): string {
  return resolveSurfaceDirectory(homeDirectory, surfaceRoot, 'browser', 'screenshots');
}

/**
 * Turns a caller-supplied profile name into the one path segment under
 * `profileRoot` it is allowed to land in, never anywhere else, and never a
 * real browser's own profile directory, which is a completely different part
 * of the filesystem this function never touches.
 *
 * Every character outside `[A-Za-z0-9._-]` is replaced, which already removes
 * every `/` and `\`, so no multi-segment path can survive. That alone still
 * leaves one escape: a name that sanitizes down to nothing but dots, `"."`
 * or `".."`, is a single segment with no separator in it, but `path.join`
 * still reads it as "this directory" or "the parent directory" rather than
 * as a literal folder name. Collapsing a dots-only result to `'default'`
 * closes that, so the returned path is always `profileRoot/<segment>`, never
 * `profileRoot` itself or anything above it.
 */
function profileDirectoryFor(profileRoot: string, profileName: string): string {
  const sanitized = profileName.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64) || 'default';
  const safe = /^\.+$/.test(sanitized) ? 'default' : sanitized;
  return join(profileRoot, safe);
}

interface DriverApi {
  readonly chromium: {
    readonly launchPersistentContext: (userDataDir: string, options: Record<string, unknown>) => Promise<BrowserContext>;
    readonly connectOverCDP: (endpoint: string, options?: Record<string, unknown>) => Promise<Browser>;
  };
}

/** Retire only our CDP client transport, never the user's browser/context. */
function detachBrowser(browser: Browser): void {
  const connection = browser as unknown as { readonly _connection?: { close?: () => void } };
  connection._connection?.close?.();
}

async function describeLaunchFailure(message: string, profileDirectory: string, options: BrowserProvisionLifetime): Promise<BrowserSessionError> {
  const cause = await readBrowserLaunchCause(message, options).catch(() => { assertProvisionCurrent(options); return 'unknown' as const; });
  if (cause === 'profile_in_use') {
    return new BrowserSessionError(
      `The browser profile at ${profileDirectory} is already open in another browser window.`,
      'Attach to the running browser with action:"attach", or launch with a different profileName.',
    );
  }
  if (cause === 'display_unavailable') {
    return new BrowserSessionError(
      'This machine has no graphical display, so a visible browser window cannot be opened.',
      'Call action:"launch" with headless:true, which needs no display.',
    );
  }
  if (cause === 'missing_library') {
    return new BrowserSessionError(
      `The browser could not start because a system library is missing: ${message.split('\n')[0]}`,
      'Install the browser system dependencies (Debian/Ubuntu: apt-get install libnss3 libatk-bridge2.0-0 libgtk-3-0 libasound2; Arch: pacman -S nss atk at-spi2-atk gtk3 alsa-lib).',
    );
  }
  return new BrowserSessionError(`The browser failed to start: ${message.split('\n')[0]}`, null);
}

export interface BrowserSessionManagerDeps {
  /** Directory that holds saved browser profiles. Owned by the composition root. */
  readonly profileRoot: string;
  /**
   * The product's storage root segment under `~/.goodvibes/`, used for the
   * managed driver directory. Required rather than defaulted: a driver this
   * process installs has to land in a directory a named surface owns.
   */
  readonly surfaceRoot: string;
  readonly io?: BrowserProvisionIo;
  /** Loads the Playwright driver. Injected so ownership rules are testable offline. */
  readonly loadDriver?: () => DriverApi | null;
  /** Finds which candidate endpoint has a browser behind it. */
  readonly probeEndpoint?: (candidates: readonly string[], signal?: AbortSignal) => Promise<ReachableCdpEndpoint | null>;
  /** Home directory owning the managed browser cache. Defaults to the profile root's owner. */
  readonly homeDirectory?: string;
  /** Where the node-hosted browser host lives, for a build that stages it itself. */
  readonly host?: BrowserHostOptions;
}

/**
 * Owns every live browser connection.
 *
 * The safety rule this class exists to enforce structurally: a browser the
 * agent did not start has no code path that ends it. `closeSession` refuses
 * attached sessions outright, and shutdown only closes what this manager
 * launched. Ownership is recorded at connect time, not decided later.
 */
export class BrowserSessionManager {
  readonly #creations = new OwnedWork();
  readonly #operations = new OwnedWork();
  readonly #retiring = new AbortController();
  #closing: Promise<void> | null = null;
  readonly #unpublishedContexts = new Set<BrowserContext>();
  readonly #unpublishedBrowsers = new Set<Browser>();
  readonly #unpublishedPages = new Set<Page>();
  readonly #pageClosures = new Map<Page, Promise<void>>();
  readonly #contextClosures = new Map<BrowserContext, Promise<void>>();
  readonly #unpublishedHosts = new Set<BrowserHostClient>();
  readonly #hostRetirements = new Map<BrowserHostClient, Promise<void>>();
  private readonly sessions = new Map<string, TrackedSession>();
  /** Node-hosted driver processes, one per session that needed one. */
  private readonly hosts = new Map<string, BrowserHostClient>();
  /** Saved tool/journal references must never select another manager's first
   * browser after a restart. Local ordinals belong to this owner only. */
  readonly #incarnation = opaqueUuid();
  #sessionCounter = 0;
  private lastProvision: BrowserProvisionReport | null = null;
  /**
   * A launch already in progress, so a second `launch()` call made while the
   * first is still opening a browser waits on the SAME attempt instead of
   * starting a second browser process against the same profile directory.
   * This is what turned "the model called launch three times while the
   * first was still opening" into three windows.
   */
  private launchInFlight: Promise<BrowserLaunchResult> | null = null;
  /**
   * Consecutive launch failures, reset to 0 on any success. Capped at
   * `MAX_CONSECUTIVE_LAUNCH_FAILURES`, after that many failures in a row,
   * `launch()` refuses to try again on its own rather than opening another
   * window that will fail the same way. One value 2 means one real retry
   * after the first failure, not open-ended retrying.
   */
  private consecutiveLaunchFailures = 0;
  private static readonly MAX_CONSECUTIVE_LAUNCH_FAILURES = 2;
  private readonly io: BrowserProvisionIo;
  private readonly profileRoot: string;
  private readonly homeDirectory: string;
  private readonly loadDriver: () => DriverApi | null;
  private readonly probeEndpoint: (candidates: readonly string[], signal?: AbortSignal) => Promise<ReachableCdpEndpoint | null>;
  private readonly hostOptions: BrowserHostOptions;

  constructor(deps: BrowserSessionManagerDeps) {
    this.profileRoot = deps.profileRoot;
    this.homeDirectory = deps.homeDirectory ?? deps.profileRoot;
    this.hostOptions = deps.host ?? {};
    this.io = deps.io ?? createBrowserProvisionIo({
      homeDirectory: this.homeDirectory,
      surfaceRoot: deps.surfaceRoot,
    });
    // The driver may live beside the executable or in this surface's own
    // storage under this home, which is why the loader is told both.
    this.loadDriver = deps.loadDriver
      ?? (() => loadDriverModule({ surfaceRoot: deps.surfaceRoot, homeDirectory: this.homeDirectory }) as DriverApi | null);
    this.probeEndpoint = deps.probeEndpoint ?? firstReachableCdpEndpoint;
  }

  #assertOpen(): void {
    if (this.#closing) throw new BrowserSessionError('The browser service is shutting down.', 'Reconnect before starting new browser work.');
  }

  private ownLifetime<T extends BrowserProvisionLifetime>(input: T): T {
    const original = Object.freeze({ ...input });
    return ownProvisionLifetime(Object.freeze({ ...original,
      signal: original.signal ? AbortSignal.any([original.signal, this.#retiring.signal]) : this.#retiring.signal,
      assertCurrent: () => { this.#assertOpen(); assertProvisionCurrent(original); this.#assertOpen(); },
    }));
  }

  /** Install-kind-aware remediation, from the same injected IO the policy uses. */
  private driverFix(): string {
    return this.io.driverFix?.() ?? 'Install the browser driver beside the executable, or install bun or npm so it can be installed automatically.';
  }

  provisionReport(): BrowserProvisionReport | null {
    return this.lastProvision;
  }

  async provision(options: BrowserProvisionLifetime & { readonly repair?: boolean | undefined; readonly allowDownload?: boolean | undefined } = {}): Promise<BrowserProvisionReport> {
    this.#assertOpen();
    return this.#creations.run(() => this.provisionOwned(options));
  }

  private async provisionOwned(options: BrowserProvisionLifetime & { readonly repair?: boolean | undefined; readonly allowDownload?: boolean | undefined }): Promise<BrowserProvisionReport> {
    const captured = this.ownLifetime(options);
    const { allowDownload, ...lifetime } = captured;
    const report = await ensureBrowserBinary(this.io, {
      ...lifetime,
      forceReinstall: captured.repair === true,
      ...(allowDownload === undefined ? {} : { allowDownload }),
    });
    assertProvisionCurrent(captured);
    this.lastProvision = report;
    return report;
  }

  private driver(): DriverApi {
    const driver = this.loadDriver();
    if (!driver) {
      throw new BrowserSessionError(
        'The browser driver is not present and could not be installed automatically.',
        this.driverFix(),
      );
    }
    const resolution = this.io.resolveDriver();
    if (!resolution.available || resolution.version !== DRIVER_VERSION) {
      throw new BrowserSessionError(
        'This browser driver does not support the action cancellation required by this build.',
        'Install the supported browser driver for this build before opening a browser session.',
      );
    }
    return driver;
  }

  /**
   * Whether this manager's own record still reflects a live browser.
   *
   * `isClosed` is read defensively rather than assumed: a driver double that
   * does not implement it (every existing test fixture) is treated as alive
   * rather than dead, because the failure mode of wrongly calling a live
   * session dead is a second browser process fighting the first one over the
   * same profile directory, the exact bug this method exists to prevent.
   * Only an explicit `true` counts as dead.
   */
  private isSessionAlive(session: TrackedSession): boolean {
    const candidate = session.context as unknown as { readonly isClosed?: () => boolean };
    if (typeof candidate.isClosed !== 'function') return true;
    try {
      return candidate.isClosed() !== true;
    } catch {
      return true;
    }
  }

  /**
   * The live launched session to reuse, if any. A dead one found along the
   * way is dropped from the registry first, so a stale entry never blocks a
   * fresh launch from going ahead.
   */
  private liveLaunchedSession(): TrackedSession | null {
    for (const session of this.sessions.values()) {
      if (session.origin !== 'launched') continue;
      if (this.isSessionAlive(session)) return session;
      this.sessions.delete(session.sessionId);
    }
    return null;
  }

  /**
   * Opens a managed browser, or hands back the one already open.
   *
   * Three rules live here, in order:
   *   1. One live launched session at a time, a second call reuses it
   *      instead of opening another window on the same profile directory.
   *   2. A launch already in flight is awaited rather than duplicated, so
   *      concurrent calls cannot start two browser processes at once.
   *   3. Failures are counted; after MAX_CONSECUTIVE_LAUNCH_FAILURES in a row
   *      launch refuses to try again on its own, and says so in plain words,
   *      instead of opening one more window that will fail the same way.
   */
  async launch(options: BrowserLaunchOptions = {}): Promise<BrowserLaunchResult> {
    this.#assertOpen();
    return this.#creations.run(() => this.launchOwned(options));
  }

  private async launchOwned(options: BrowserLaunchOptions): Promise<BrowserLaunchResult> {
    options = this.ownLifetime(options);
    assertProvisionCurrent(options);
    const existing = this.liveLaunchedSession();
    if (existing) {
      return { ...this.describe(existing), reused: true };
    }

    if (this.launchInFlight) {
      const result = await this.launchInFlight;
      assertProvisionCurrent(options);
      return result;
    }

    if (this.consecutiveLaunchFailures >= BrowserSessionManager.MAX_CONSECUTIVE_LAUNCH_FAILURES) {
      throw new BrowserSessionError(
        `The browser failed to launch ${String(this.consecutiveLaunchFailures)} times in a row, so this agent stopped retrying automatically.`,
        'Call action:"status" to see what went wrong, fix it, then call action:"launch" once more, automatic retries are capped at one.',
      );
    }

    // Publish single-flight ownership before a provision/driver callback can
    // reenter launch or shutdown. All admitted callers remain in the drain.
    const attempt = Promise.resolve().then(() => this.performLaunch(options))
      .then((info): BrowserLaunchResult => {
        this.consecutiveLaunchFailures = 0;
        return { ...info, reused: false };
      })
      .catch((error: unknown) => {
        this.consecutiveLaunchFailures += 1;
        throw error;
      })
      .finally(() => {
        if (this.launchInFlight === attempt) this.launchInFlight = null;
      });
    this.launchInFlight = attempt;
    return attempt;
  }

  private async performLaunch(options: BrowserLaunchOptions): Promise<BrowserSessionInfo> {
    const provision = await this.provision(options);
    assertProvisionCurrent(options);
    if (!provision.ok || !provision.executablePath) {
      throw new BrowserSessionError(provision.problem ?? 'No usable browser is available.', provision.fix);
    }
    const profileDirectory = profileDirectoryFor(this.profileRoot, options.profileName ?? 'default');
    mkdirSync(profileDirectory, { recursive: true });
    const headless = options.headless ?? !hasDisplay();
    const driver = this.driver();
    assertProvisionCurrent(options);
    let context: BrowserContext;
    try {
      context = await driver.chromium.launchPersistentContext(profileDirectory, {
        headless,
        executablePath: provision.executablePath,
        args: [...STEALTH_ARGS],
        ignoreDefaultArgs: [...SUPPRESSED_DEFAULT_ARGS],
        viewport: options.viewport ?? { width: 1280, height: 900 },
      });
    } catch (error) {
      throw await describeLaunchFailure(error instanceof Error ? error.message : String(error), profileDirectory, options);
    }
    this.#unpublishedContexts.add(context);
    try {
      assertProvisionCurrent(options);
      const info = this.register({
        origin: 'launched',
        context,
        browser: null,
        profileDirectory,
        cdpEndpoint: null,
        executablePath: provision.executablePath,
        source: provision.source,
        headless,
      });
      this.#unpublishedContexts.delete(context);
      return info;
    } catch (error) {
      try { await this.closeContext(context); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'The new browser could not be retired cleanly'); }
      throw error;
    }
  }

  /**
   * Connects to a browser the user already has running. The returned session is
   * permanently marked attached, which is what makes closing it impossible.
   */
  async attach(options: BrowserAttachOptions): Promise<BrowserSessionInfo> {
    this.#assertOpen();
    const requestedEndpoint = options.cdpEndpoint;
    return this.#creations.run(() => this.attachOwned(requestedEndpoint));
  }

  private async attachOwned(requestedEndpoint: string): Promise<BrowserSessionInfo> {
    this.#assertOpen();
    const driver = this.driver();
    this.#assertOpen();
    const candidates = cdpEndpointCandidates(requestedEndpoint);
    const reachable = await this.probeEndpoint(candidates, this.#retiring.signal);
    this.#assertOpen();
    if (!reachable) {
      throw new BrowserSessionError(
        `No browser is listening at ${requestedEndpoint} (tried ${candidates.join(', ')}).`,
        'Start the browser with a remote debugging port (chromium --remote-debugging-port=9222 --user-data-dir=<profile>) and pass that port, or use action:"launch" to have the agent start its own browser with a saved profile.',
      );
    }
    // Capture the browser WebSocket from this discovery before connecting.
    // Connecting via HTTP again would rediscover whatever later owns that
    // address/port, including during the Node-host fallback after a failure.
    const endpoint = reachable.endpoint;
    const webSocket = debuggerWebSocket(reachable.webSocketDebuggerUrl);
    if (!webSocket) throw new BrowserSessionError(
      'The debugger did not identify a usable browser WebSocket.',
      'Use the browser WebSocket from its /json/version response, or restart its remote debugging endpoint and attach again.',
    );
    let browser: Browser | null = null;
    let lastMessage = '';
    try {
      this.#assertOpen();
      // The endpoint is already known to answer, so a long connect timeout only
      // delays an honest answer.
      browser = await driver.chromium.connectOverCDP(webSocket, { timeout: 8_000 });
      this.#unpublishedBrowsers.add(browser);
    } catch (error) {
      this.#assertOpen();
      lastMessage = error instanceof Error ? error.message : String(error);
    }
    try { this.#assertOpen(); }
    catch (error) {
      if (browser) { detachBrowser(browser); this.#unpublishedBrowsers.delete(browser); }
      throw error;
    }
    if (!browser) {
      // This runtime cannot complete a CDP WebSocket handshake, so the
      // connection is made by a Node process instead and driven over a pipe.
      // The result is the same session, with the same operations.
      const hosted = await this.attachThroughHost(webSocket, requestedEndpoint).catch((error: unknown) => {
        lastMessage = `${lastMessage} | host: ${error instanceof Error ? error.message : String(error)}`;
        return null;
      });
      this.#assertOpen();
      if (hosted) return hosted;
    }
    if (!browser) {
      // The browser answered on HTTP, so the endpoint is right and the browser
      // is alive. Distinguish "this runtime cannot complete the debugger
      // handshake" from a genuine connection problem, because the two have
      // completely different answers and only one of them is the user's doing.
      const handshake = await cdpWebSocketHandshakeWorks(webSocket, this.#retiring.signal);
      this.#assertOpen();
      throw new BrowserSessionError(
        handshake
          ? `The browser at ${endpoint} is running and reachable, but this build cannot complete the debugger handshake: ${lastMessage.split('\n')[0]}`
          : `Could not connect to the browser at ${endpoint}: ${lastMessage.split('\n')[0]}`,
        handshake
          ? 'Use action:"launch" with a profileName instead. The agent opens its own browser with a saved profile, and a sign-in done there persists across runs.'
          : 'Restart the browser with --remote-debugging-port and try again, or use action:"launch".',
      );
    }
    try {
      const contexts = browser.contexts();
      const context = contexts[0];
      if (!context) throw new BrowserSessionError(
        `The browser at ${requestedEndpoint} exposed no browsing context to attach to.`,
        'Open a tab in that browser and attach again.',
      );
      const info = this.register({
        origin: 'attached',
        context,
        browser,
        profileDirectory: null,
        cdpEndpoint: requestedEndpoint,
        executablePath: null,
        source: null,
        headless: false,
      });
      this.#unpublishedBrowsers.delete(browser);
      return info;
    } catch (error) {
      try { detachBrowser(browser); this.#unpublishedBrowsers.delete(browser); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'The attached browser client could not be retired cleanly'); }
      throw error;
    }
  }

  /**
   * Attaches by way of the Node-hosted driver.
   *
   * Used when the in-process client cannot complete the handshake. The session
   * it produces is an ordinary attached session: origin 'attached', so nothing
   * here can close the user's browser.
   */
  private async attachThroughHost(endpoint: string, requestedEndpoint: string): Promise<BrowserSessionInfo | null> {
    this.#assertOpen();
    const client = new BrowserHostClient(this.hostOptions);
    this.#unpublishedHosts.add(client);
    const abort = (): void => { void this.retireHost(client).catch(() => {}); };
    this.#retiring.signal.addEventListener('abort', abort, { once: true });
    try {
      await client.start();
      this.#assertOpen();
      const attached = await client.call<{ pages: { pages: { pageId: string; url: string }[] } }>('attach', { endpoint });
      this.#assertOpen();
      const pages = attached.pages.pages;
      if (pages.length === 0) {
        const created = await client.call<{ pageId: string }>('newPage');
        this.#assertOpen();
        pages.push({ pageId: created.pageId, url: 'about:blank' });
      }
      const context = remoteContext(client, pages);
      const info = this.register({
          origin: 'attached',
          context,
          browser: null,
          profileDirectory: null,
          cdpEndpoint: requestedEndpoint,
          executablePath: null,
          source: null,
          headless: false,
      });
      this.hosts.set(info.sessionId, client);
      this.#unpublishedHosts.delete(client);
      return info;
    } catch (error) {
      try { await this.retireHost(client); this.#unpublishedHosts.delete(client); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'The browser helper could not be retired cleanly'); }
      throw error;
    } finally { this.#retiring.signal.removeEventListener('abort', abort); }
  }

  /** Synchronous release keeps its real asynchronous retirement owned here. */
  private retireHost(client: BrowserHostClient): Promise<void> {
    const existing = this.#hostRetirements.get(client);
    if (existing) return existing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    const retirement = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    this.#hostRetirements.set(client, retirement);
    const done = (): void => { this.#hostRetirements.delete(client); resolve(); };
    try { void client.close().then(done, reject); } catch (error) { reject(error); }
    // Failed retirements stay retained so root shutdown reports them.
    void retirement.catch(() => {});
    return retirement;
  }

  private register(input: {
    readonly origin: BrowserSessionOrigin;
    readonly context: BrowserContext;
    readonly browser: Browser | null;
    readonly profileDirectory: string | null;
    readonly cdpEndpoint: string | null;
    readonly executablePath: string | null;
    readonly source: BrowserProvisionReport['source'];
    readonly headless: boolean;
  }): BrowserSessionInfo {
    this.#assertOpen();
    if (this.#sessionCounter >= Number.MAX_SAFE_INTEGER) throw new BrowserSessionError('Browser session references are exhausted.');
    this.#sessionCounter += 1;
    const sessionId = `b${this.#incarnation}.${String(this.#sessionCounter)}`;
    const session: TrackedSession = {
      sessionId,
      origin: input.origin,
      context: input.context,
      browser: input.browser,
      profileDirectory: input.profileDirectory,
      cdpEndpoint: input.cdpEndpoint,
      executablePath: input.executablePath,
      source: input.source,
      headless: input.headless,
      startedAt: new Date().toISOString(),
      pages: new Map(),
      activePageId: null,
      pageCounter: 0,
    };
    this.sessions.set(sessionId, session);
    try {
      for (const page of input.context.pages()) this.trackPage(session, page);
      input.context.on('page', (page: Page) => { this.trackPage(session, page); });
      this.#assertOpen();
      return this.describe(session);
    } catch (error) {
      if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
      throw error;
    }
  }

  private trackPage(session: TrackedSession, page: Page): void {
    if (this.#closing || this.sessions.get(session.sessionId) !== session) return;
    for (const tracked of session.pages.values()) if (tracked.page === page) return;
    if (session.pageCounter >= Number.MAX_SAFE_INTEGER) throw new BrowserSessionError('Browser page references are exhausted.');
    session.pageCounter += 1;
    const pageId = `${session.sessionId}p${String(session.pageCounter)}`;
    const tracked = { pageId, page };
    session.pages.set(pageId, tracked);
    session.activePageId ??= pageId;
    try { page.on('close', () => { this.forgetPage(session, tracked); }); }
    catch (error) { this.forgetPage(session, tracked); throw error; }
  }

  private forgetPage(session: TrackedSession, tracked: TrackedPage): void {
    if (session.pages.get(tracked.pageId) !== tracked) return;
    session.pages.delete(tracked.pageId);
    if (session.activePageId === tracked.pageId) session.activePageId = session.pages.keys().next().value ?? null;
  }

  private describe(session: TrackedSession): BrowserSessionInfo {
    return {
      sessionId: session.sessionId,
      origin: session.origin,
      profileDirectory: session.profileDirectory,
      cdpEndpoint: session.cdpEndpoint,
      executablePath: session.executablePath,
      source: session.source,
      headless: session.headless,
      startedAt: session.startedAt,
      pageCount: session.pages.size,
      activePageId: session.activePageId,
      closableByAgent: session.origin === 'launched',
    };
  }

  list(): readonly BrowserSessionInfo[] {
    return [...this.sessions.values()].map((session) => this.describe(session));
  }

  info(sessionId: string): BrowserSessionInfo {
    return this.describe(this.require(sessionId));
  }

  hasSessions(): boolean {
    return this.sessions.size > 0;
  }

  /** The session a call should act on when none is named. */
  defaultSessionId(): string | null {
    const first = this.sessions.keys().next();
    return first.done === true ? null : first.value;
  }

  private require(sessionId: string): TrackedSession {
    this.#assertOpen();
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new BrowserSessionError(
        `No browser session named ${sessionId}.`,
        'Call the browser tool with action:"launch" to start one, or action:"status" to list the live sessions.',
      );
    }
    return session;
  }

  requireContext(sessionId: string): BrowserContext {
    return this.require(sessionId).context;
  }

  private assertSessionCurrent(session: TrackedSession): void {
    this.#assertOpen();
    if (this.sessions.get(session.sessionId) !== session) throw new BrowserSessionError(
      'The browser session was released or closed while this operation was pending.',
      'Select a live browser session before starting another operation.',
    );
  }

  async page(sessionId: string, pageId?: string): Promise<{ readonly pageId: string; readonly page: Page }> {
    const session = this.require(sessionId);
    return this.#operations.run(() => this.pageOwned(session, pageId));
  }

  private async pageOwned(session: TrackedSession, pageId?: string): Promise<TrackedPage> {
    this.assertSessionCurrent(session);
    if (pageId) {
      const tracked = session.pages.get(pageId);
      if (!tracked) {
        throw new BrowserSessionError(
          `Session ${session.sessionId} has no page ${pageId}.`,
          'Call action:"tabs" to list the pages this session controls.',
        );
      }
      return { pageId: tracked.pageId, page: tracked.page };
    }
    if (session.activePageId) {
      const tracked = session.pages.get(session.activePageId);
      if (tracked) return { pageId: tracked.pageId, page: tracked.page };
    }
    return this.createPage(session, false);
  }

  async newPage(sessionId: string): Promise<{ readonly pageId: string; readonly page: Page }> {
    const session = this.require(sessionId);
    return this.#operations.run(() => this.createPage(session, true));
  }

  private async createPage(session: TrackedSession, activate: boolean): Promise<TrackedPage> {
    this.assertSessionCurrent(session);
    const page = await session.context.newPage();
    this.#unpublishedPages.add(page);
    try {
      this.assertSessionCurrent(session);
      this.trackPage(session, page);
      this.assertSessionCurrent(session);
      const registered = [...session.pages.values()].find((entry) => entry.page === page);
      if (!registered) throw new BrowserSessionError('The browser did not return a usable page.', null);
      if (activate) session.activePageId = registered.pageId;
      this.#unpublishedPages.delete(page);
      return { pageId: registered.pageId, page: registered.page };
    } catch (error) {
      // This page was created by this exact pending operation. Never close
      // another existing tab or the attached context/browser to clean it up.
      try {
        await this.retirePage(page);
        for (const tracked of session.pages.values()) if (tracked.page === page) this.forgetPage(session, tracked);
      }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'The unpublished browser page could not be retired cleanly'); }
      throw error;
    }
  }

  /** Close only the selected original tab; keep its actual native work owned. */
  async closePage(sessionId: string, pageId: string): Promise<void> {
    const session = this.require(sessionId);
    return this.#operations.run(async () => {
      this.assertSessionCurrent(session);
      const tracked = session.pages.get(pageId);
      if (!tracked) throw new BrowserSessionError(
        `Session ${sessionId} has no page ${pageId}.`,
        'Call action:"tabs" to list the pages this session controls.',
      );
      await this.retirePage(tracked.page);
      this.forgetPage(session, tracked);
    });
  }

  private retirePage(page: Page): Promise<void> {
    const existing = this.#pageClosures.get(page);
    if (existing) return existing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    const closing = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    this.#unpublishedPages.add(page);
    this.#pageClosures.set(page, closing);
    const done = (): void => { this.#pageClosures.delete(page); this.#unpublishedPages.delete(page); resolve(); };
    const failed = (error: unknown): void => { this.#pageClosures.delete(page); reject(error); };
    try { void Promise.resolve(page.close()).then(done, failed); } catch (error) { failed(error); }
    void closing.catch(() => {});
    return closing;
  }

  setActivePage(sessionId: string, pageId: string): void {
    const session = this.require(sessionId);
    if (!session.pages.has(pageId)) {
      throw new BrowserSessionError(
        `Session ${sessionId} has no page ${pageId}.`,
        'Call action:"tabs" to list the pages this session controls.',
      );
    }
    session.activePageId = pageId;
  }

  async pageList(sessionId: string): Promise<readonly BrowserPageInfo[]> {
    const session = this.require(sessionId);
    return this.#operations.run(() => this.pageListOwned(session));
  }

  private async pageListOwned(session: TrackedSession): Promise<readonly BrowserPageInfo[]> {
    const infos: BrowserPageInfo[] = [];
    for (const tracked of [...session.pages.values()]) {
      this.assertSessionCurrent(session);
      let title = '';
      try {
        title = await tracked.page.title();
      } catch {
        title = '';
      }
      this.assertSessionCurrent(session);
      if (session.pages.get(tracked.pageId) !== tracked) continue;
      const url = tracked.page.url();
      this.assertSessionCurrent(session);
      infos.push({
        pageId: tracked.pageId,
        url,
        title,
        active: tracked.pageId === session.activePageId,
      });
    }
    this.assertSessionCurrent(session);
    return infos;
  }

  /**
   * Ends a browser this agent started. Attached browsers are refused: the agent
   * has no path to end a session a person is using. Closing a TAB inside an
   * attached browser is a separate, page-scoped action.
   */
  async closeSession(sessionId: string): Promise<BrowserSessionInfo> {
    const session = this.require(sessionId);
    if (session.origin === 'attached') {
      throw new BrowserSessionError(
        `Session ${sessionId} is an attached browser that this agent did not start, so it cannot be closed from here.`,
        'Use action:"release" to disconnect from it and leave the browser running, or close the browser yourself.',
      );
    }
    const info = this.describe(session);
    this.sessions.delete(sessionId);
    return this.#operations.run(async () => { await this.closeContext(session.context); return info; });
  }

  /** Retain failures and coalesce actual native context closure across callers. */
  private closeContext(context: BrowserContext): Promise<void> {
    const existing = this.#contextClosures.get(context);
    if (existing) return existing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    const closing = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    this.#unpublishedContexts.add(context);
    this.#contextClosures.set(context, closing);
    const done = (): void => {
      this.#contextClosures.delete(context); this.#unpublishedContexts.delete(context); resolve();
    };
    const failed = (error: unknown): void => { this.#contextClosures.delete(context); reject(error); };
    try { void Promise.resolve(context.close()).then(done, failed); } catch (error) { failed(error); }
    void closing.catch(() => {});
    return closing;
  }

  /**
   * Disconnects from a session without ending the browser. For attached
   * browsers this is the ONLY exit: the CDP transport is dropped and the
   * user's browser keeps running with its tabs and login intact.
   */
  release(sessionId: string): BrowserSessionInfo {
    const session = this.require(sessionId);
    const info = this.describe(session);
    this.sessions.delete(sessionId);
    const host = this.hosts.get(sessionId);
    if (host) {
      // Ends the helper process, never the browser it was talking to.
      void this.retireHost(host).catch(() => {});
      this.hosts.delete(sessionId);
    }
    const browser = session.browser;
    if (browser) {
      // Retire the transport before another admitted continuation can run.
      // A failed detach remains owned for shutdown retry/reporting.
      this.#unpublishedBrowsers.add(browser);
      detachBrowser(browser);
      this.#unpublishedBrowsers.delete(browser);
    }
    return info;
  }

  /** Closes only what this agent launched. Attached browsers are left running. */
  shutdown(): Promise<void> {
    if (this.#closing) return this.#closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    // Publish retirement before cancellation can reenter this owner.
    this.#closing = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    this.#retiring.abort(new BrowserSessionError('The browser service is shutting down.'));
    // Stop published and not-yet-published helpers before joining creation:
    // their pending CDP attach/RPC may otherwise keep creation waiting forever.
    const helpers = new Set([...this.hosts.values(), ...this.#unpublishedHosts, ...this.#hostRetirements.keys()]);
    void Promise.allSettled([...helpers].map(host => this.retireHost(host))).then(async results => {
      const errors: unknown[] = [];
      for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
      if (!errors.length) {
        await this.#creations.join();
        this.hosts.clear();
        this.#unpublishedHosts.clear();
      }
      // A failed helper retirement must be reported without skipping cleanup
      // of other browsers already owned by the manager. Its unresolved work
      // and helper remain retained; failure never becomes successful drainage.
      // Issue existing tab cleanup before disconnect, but do not join a close
      // RPC before the disconnect that may be needed to settle that RPC.
      // A failed first attempt stays in the set and is retried after admitted
      // work settles; only unresolved cleanup makes shutdown fail.
      const pageCleanups = [...this.#unpublishedPages].map(page => this.retirePage(page).catch(() => {}));
      for (const session of [...this.sessions.values()]) {
        this.sessions.delete(session.sessionId);
        try {
          if (session.origin === 'launched') await this.closeContext(session.context);
          else if (session.browser) detachBrowser(session.browser);
        } catch (error) { errors.push(error); }
      }
      for (const context of this.#unpublishedContexts) {
        try { await this.closeContext(context); } catch (error) { errors.push(error); }
      }
      for (const browser of this.#unpublishedBrowsers) {
        try { detachBrowser(browser); this.#unpublishedBrowsers.delete(browser); } catch (error) { errors.push(error); }
      }
      await Promise.all(pageCleanups);
      // Retiring the native connection/context interrupts its pending RPCs.
      // Joining first could wait forever for a read that needs that disconnect.
      if (!errors.length) await this.#operations.join();
      // A dependency may ignore disconnect and still yield an owned new tab.
      // Its creation callback cleans it; retry a failed cleanup before success.
      for (const page of this.#unpublishedPages) {
        try { await this.retirePage(page); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'Browser ownership did not retire cleanly');
    }).then(resolve, reject);
    void this.#closing.catch(() => {});
    return this.#closing;
  }
}

export function hasDisplay(): boolean {
  if (process.platform === 'win32' || process.platform === 'darwin') return true;
  return Boolean(process.env.DISPLAY?.trim() || process.env.WAYLAND_DISPLAY?.trim());
}
