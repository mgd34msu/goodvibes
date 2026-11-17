/** Copilot sessions belong to one provider's observed source credential. Neither
 * the source credential nor its digest is a cache key or persisted session field.
 * A new provider exchanges once; subsequent callers share its live session. */
import { readJsonFileOrQuarantine, writeJsonFileAtomicSafe } from '../utils/atomic-json-store.js';
import { logger } from '../utils/logger.js';
import { ProviderAttemptDeniedError } from './attempt-guard.js';
import { VERSION } from '../version.js';

/**
 * Only a token the owner set for Copilot configures it. `GH_TOKEN` and
 * `GITHUB_TOKEN` are the GitHub CLI's and CI's repository credentials and are
 * never presented to the Copilot token endpoint.
 */
export const COPILOT_TOKEN_ENV_VARS = ['COPILOT_GITHUB_TOKEN'] as const;
const TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
const ACCOUNT_URL = 'https://api.github.com/copilot_internal/user';
const DEFAULT_API_BASE_URL = 'https://api.individual.githubcopilot.com';
const SESSION_EXPIRY_MARGIN_MS = 5 * 60 * 1000;
/** How long the account's Copilot API host is used before it is read again, for a token used directly. */
const DIRECT_SESSION_WINDOW_MS = 30 * 60 * 1000;
/** Exchange answers that mean "not an exchangeable token" rather than "bad token". */
const DIRECT_TOKEN_STATUSES: ReadonlySet<number> = new Set([403, 404]);
export const COPILOT_IO_TIMEOUT_MS = 15_000;

/** The client names itself: GoodVibes, at its own version. */
export function copilotIdeHeaders(includeApiVersion = false): Record<string, string> {
  return { 'Editor-Version': `GoodVibes/${VERSION}`, 'User-Agent': `GoodVibes/${VERSION}`,
    ...(includeApiVersion ? { 'X-Github-Api-Version': '2025-04-01' } : {}) };
}

export interface CopilotSession {
  readonly token: string;
  readonly baseUrl: string;
  readonly expiresAt: number;
}
/** Opaque native identity. It carries cancellation, never a source/session token. */
export interface CopilotCredentialOwner { readonly signal: AbortSignal }
interface OwnedCredential {
  readonly owner: CopilotCredentialOwner;
  readonly source: string;
  readonly abort: AbortController;
  session?: CopilotSession;
  pending?: Promise<CopilotSession>;
  /** The exchange refused this token; it is used directly as the Copilot API bearer. */
  direct?: boolean;
}
interface SessionOptions {
  readonly tokenCachePath: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  /** A Copilot token the registry resolved (environment, then the secrets store); read before the environment. */
  readonly token?: string | undefined;
}
function changed(): ProviderAttemptDeniedError {
  return new ProviderAttemptDeniedError(new Error('The original GitHub Copilot credential changed. Retry with the currently selected account.'));
}
function sourceToken(env: NodeJS.ProcessEnv, injected?: string): string | null {
  if (injected?.trim()) return injected.trim();
  for (const key of COPILOT_TOKEN_ENV_VARS) {
    const value = env[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}
function parseSession(value: unknown): CopilotSession {
  if (!value || typeof value !== 'object') throw new Error('Invalid Copilot session response');
  const record = value as Record<string, unknown>;
  const token = typeof record['token'] === 'string' ? record['token'].trim() : '';
  const raw = record['expires_at'];
  const expiry = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  const expiresAt = expiry < 100_000_000_000 ? expiry * 1000 : expiry;
  if (!token || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw new Error('Invalid Copilot session response');
  const endpoint = token.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i)?.[1];
  let baseUrl = DEFAULT_API_BASE_URL;
  if (endpoint) {
    try {
      const parsed = new URL(/^https?:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`);
      baseUrl = `https://${parsed.hostname.replace(/^proxy\./i, 'api.')}`;
    } catch { /* An absent/invalid optional endpoint uses the standard Copilot API. */ }
  }
  return Object.freeze({ token, expiresAt, baseUrl });
}

/** Caller cancellation stops this wait, without cancelling another caller's
 * shared exchange. The exchange keeps its own source owner and timeout. */
async function waitForSession<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    void pending.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}

export class CopilotSessions {
  #credential: OwnedCredential | null = null;
  #checkedPreviousCache = false;
  readonly #options: SessionOptions;
  constructor(options: SessionOptions) { this.#options = { ...options }; }

  capture(): CopilotCredentialOwner | null {
    const source = sourceToken(this.#options.env ?? process.env, this.#options.token);
    if (source === null && this.#credential === null) return null;
    if (source !== null && this.#credential?.source === source) return this.#credential.owner;
    const previous = this.#credential;
    const abort = new AbortController();
    this.#credential = source === null ? null : { source, abort, owner: Object.freeze({ signal: abort.signal }) };
    // Publish the replacement first: synchronous abort listeners cannot recover
    // the retired owner or revive its session when the old value is restored.
    previous?.abort.abort(changed());
    return this.#credential?.owner ?? null;
  }

  assertCurrent(owner: CopilotCredentialOwner): void {
    if (this.capture() !== owner) throw changed();
    owner.signal.throwIfAborted();
  }

  async resolve(owner: CopilotCredentialOwner, signal?: AbortSignal): Promise<CopilotSession> {
    signal?.throwIfAborted(); this.assertCurrent(owner);
    const credential = this.#credential;
    if (!credential || credential.owner !== owner) throw changed();
    if (credential.session && credential.session.expiresAt - Date.now() > SESSION_EXPIRY_MARGIN_MS) return credential.session;
    if (!credential.pending) {
      let resolve!: (session: CopilotSession) => void, reject!: (error: unknown) => void;
      const pending = new Promise<CopilotSession>((done, failed) => { resolve = done; reject = failed; });
      credential.pending = pending;
      // Reserve before calling injected fetch or cache diagnostics, which can
      // synchronously reenter model discovery or chat.
      void this.exchange(owner).then(session => {
        try { this.assertCurrent(owner); credential.session = session; resolve(session); }
        catch (error) { reject(error); }
      }, reject);
      const settled = () => { if (credential.pending === pending) delete credential.pending; };
      void pending.then(settled, settled);
    }
    const session = await waitForSession(credential.pending, signal);
    signal?.throwIfAborted(); this.assertCurrent(owner);
    return session;
  }

  private retirePreviousCache(owner: CopilotCredentialOwner): void {
    if (this.#checkedPreviousCache) return;
    this.#checkedPreviousCache = true;
    const assertCurrent = () => this.assertCurrent(owner);
    try {
      assertCurrent();
      const cached = readJsonFileOrQuarantine<'previous' | 'retired'>(this.#options.tokenCachePath, {
        label: 'providers/github-copilot-token-cache',
        recovery: 'Copilot sessions now belong to the live provider. A fresh session is exchanged on provider startup; saved source credentials are not changed.',
        validate(raw) {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid Copilot cache');
          const value = raw as Record<string, unknown>;
          if (value['version'] === 2 && value['storage'] === 'provider-memory' && Object.keys(value).length === 2) return 'retired';
          if (typeof value['token'] !== 'string' || !value['token'].trim()
            || typeof value['expiresAt'] !== 'number' || !Number.isFinite(value['expiresAt'])
            || typeof value['updatedAt'] !== 'number' || !Number.isFinite(value['updatedAt'])) throw new Error('Invalid Copilot cache');
          return 'previous';
        },
      });
      assertCurrent();
      if (cached === 'previous') {
        // Classify this write explicitly: it retires a credential cache and
        // contains no credential material, source token or source digest.
        writeJsonFileAtomicSafe(this.#options.tokenCachePath, { version: 2, storage: 'provider-memory' },
          { assertCurrent, label: 'providers/github-copilot-token-cache' });
        assertCurrent();
      }
    } catch {
      assertCurrent();
      logger.warn('[github-copilot] Previous token cache could not be retired; it will not be used.');
    }
  }

  private async exchange(owner: CopilotCredentialOwner): Promise<CopilotSession> {
    this.retirePreviousCache(owner); this.assertCurrent(owner);
    const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(COPILOT_IO_TIMEOUT_MS)]);
    const credential = this.#credential;
    if (!credential || credential.owner !== owner) throw changed();
    const source = credential.source;
    // A token the exchange already refused is used as it is; it is not offered to the exchange again.
    if (credential.direct) return this.directSession(owner, source, signal, null);
    let response: Response;
    try {
      response = await (this.#options.fetchFn ?? fetch)(TOKEN_URL, {
        method: 'GET', signal, redirect: 'error',
        headers: { Accept: 'application/json', Authorization: `Bearer ${source}`, ...copilotIdeHeaders(true) },
      });
    } catch {
      this.assertCurrent(owner); signal.throwIfAborted();
      throw new Error('GitHub Copilot session exchange could not reach GitHub. Check the configured account and connection.');
    }
    try {
      this.assertCurrent(owner); signal.throwIfAborted();
      if (DIRECT_TOKEN_STATUSES.has(response.status)) {
        await response.body?.cancel().catch(() => {});
        const session = await this.directSession(owner, source, signal, response.status);
        credential.direct = true;
        return session;
      }
      if (!response.ok) throw new Error(`Copilot token exchange failed: HTTP ${response.status}`);
      let raw: unknown;
      try { raw = await response.json(); }
      catch { this.assertCurrent(owner); signal.throwIfAborted(); throw new Error('Invalid Copilot session response'); }
      this.assertCurrent(owner); signal.throwIfAborted();
      return parseSession(raw);
    } finally {
      if (!response.bodyUsed) await response.body?.cancel().catch(() => {});
    }
  }

  /**
   * A GitHub sign-in token such as the GitHub CLI's `gho_` token is refused by
   * the exchange (HTTP 403, whatever the client identity) but is accepted by
   * the Copilot API itself as the bearer (checked live on 2026-11-17). The
   * account's Copilot API host is read from GitHub, and the token is sent only
   * to a `githubcopilot.com` host.
   * One account read per session window; the exchange is not asked again.
   */
  private async directSession(owner: CopilotCredentialOwner, source: string, signal: AbortSignal, exchangeStatus: number | null): Promise<CopilotSession> {
    const refused = exchangeStatus === null ? '' : `Copilot token exchange failed: HTTP ${exchangeStatus}, and `;
    let response: Response;
    try {
      response = await (this.#options.fetchFn ?? fetch)(ACCOUNT_URL, {
        method: 'GET', signal, redirect: 'error',
        headers: { Accept: 'application/json', Authorization: `Bearer ${source}`, ...copilotIdeHeaders(true) },
      });
    } catch {
      this.assertCurrent(owner); signal.throwIfAborted();
      throw new Error(`${refused}the GitHub Copilot account could not be read. Check the configured account and connection.`);
    }
    try {
      this.assertCurrent(owner); signal.throwIfAborted();
      if (!response.ok) throw new Error(`${refused}the GitHub Copilot account read returned HTTP ${response.status}. The token has no Copilot access.`);
      let raw: unknown;
      try { raw = await response.json(); }
      catch { this.assertCurrent(owner); signal.throwIfAborted(); throw new Error(`${refused}the GitHub Copilot account answer was not JSON.`); }
      this.assertCurrent(owner); signal.throwIfAborted();
      const endpoints = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)['endpoints'] : undefined;
      const api = endpoints && typeof endpoints === 'object' ? (endpoints as Record<string, unknown>)['api'] : undefined;
      let baseUrl = DEFAULT_API_BASE_URL;
      if (typeof api === 'string') {
        try {
          const parsed = new URL(api);
          if (parsed.protocol === 'https:' && (parsed.hostname === 'githubcopilot.com' || parsed.hostname.endsWith('.githubcopilot.com'))) baseUrl = `https://${parsed.hostname}`;
        } catch { /* An absent or foreign endpoint uses the standard Copilot API. */ }
      }
      return Object.freeze({ token: source, baseUrl, expiresAt: Date.now() + DIRECT_SESSION_WINDOW_MS });
    } finally {
      if (!response.bodyUsed) await response.body?.cancel().catch(() => {});
    }
  }
}
