/** Copilot sessions belong to one provider's observed source credential. Neither
 * the source credential nor its digest is a cache key or persisted session field.
 * A new provider exchanges once; subsequent callers share its live session. */
import { readJsonFileOrQuarantine, writeJsonFileAtomicSafe } from '../utils/atomic-json-store.js';
import { logger } from '../utils/logger.js';
import { ProviderAttemptDeniedError } from './attempt-guard.js';

export const COPILOT_TOKEN_ENV_VARS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const;
const TOKEN_URL = `https://api.github.com/${['copilot', 'internal'].join('_')}/v2/token`;
const DEFAULT_API_BASE_URL = 'https://api.individual.githubcopilot.com';
const SESSION_EXPIRY_MARGIN_MS = 5 * 60 * 1000;
export const COPILOT_IO_TIMEOUT_MS = 15_000;

export function copilotIdeHeaders(includeApiVersion = false): Record<string, string> {
  return { 'Editor-Version': 'vscode/1.96.2', 'User-Agent': 'GitHubCopilotChat/0.26.7',
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
}
interface SessionOptions {
  readonly tokenCachePath: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly fetchFn?: typeof fetch | undefined;
}
function changed(): ProviderAttemptDeniedError {
  return new ProviderAttemptDeniedError(new Error('The original GitHub Copilot credential changed. Retry with the currently selected account.'));
}
function sourceToken(env: NodeJS.ProcessEnv): string | null {
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
    const source = sourceToken(this.#options.env ?? process.env);
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
}
