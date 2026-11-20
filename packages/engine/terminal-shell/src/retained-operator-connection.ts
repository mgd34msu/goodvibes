import { createOperatorApiClient, type OperatorApiClient, type OperatorApiClientOptions } from '@goodvibes/engine/operator-client';
import { observeImportFile, assertImportFileCurrent, type ConfigManager, type ImportFileObservation } from '@goodvibes/engine/platform/platform/config';
import { OwnedSelectionObservation } from '@goodvibes/engine/platform/platform/runtime/client/selection-observation';
import { createNativeHostFetch } from './native/native-host-fetch.js';

/** Private selected credential. Never a public picker item, log field or cache key. */
export interface SelectedOperatorConnection {
  readonly baseUrl: string;
  readonly token: string;
  readonly identity: string;
  readonly expectedPrincipalId?: string;
}
export interface RetainedOperatorConnectionPolicy {
  readonly owner: () => ConfigManager;
  readonly home: () => string;
  readonly read: (observation: OwnedSelectionObservation) => SelectedOperatorConnection | null;
  /** Only actual credential sources, including absence when it selects a fallback. */
  readonly files: (selection: SelectedOperatorConnection, home: string) => readonly string[];
  readonly environment?: (() => readonly (string | undefined)[]) | undefined;
  readonly signal: AbortSignal;
  readonly fetchImpl?: OperatorApiClientOptions['fetchImpl'];
}

/**
 * Why a retained connection could not open or ended, each with its own next step.
 * `unavailable`: opening failed for another reason (a credential or pairing file could
 * not be read, the host address is not usable); `source-changed` is only a selection or
 * credential that changed after the connection opened.
 */
export type RetainedOperatorConnectionFailure = 'not-paired' | 'source-changed' | 'unavailable' | 'closed';

export class RetainedOperatorConnectionError extends Error {
  constructor(readonly reason: RetainedOperatorConnectionFailure) {
    super(reason === 'not-paired' ? 'No paired host is selected for this terminal.'
      : reason === 'source-changed' ? 'The selected host or its credential changed.'
        : reason === 'unavailable' ? 'The connection to the selected host could not be opened.'
          : 'The operator connection is closed.');
    this.name = 'RetainedOperatorConnectionError';
  }
}

/**
 * The sentence a command prints when its connection would not open or ended: the state and
 * the step that fixes it. `again` is the command that reopens the view, for example
 * "reopen /payments pending".
 */
export function describeRetainedConnectionFailure(error: unknown, again: string): string {
  const reason = error instanceof RetainedOperatorConnectionError ? error.reason : 'unavailable';
  if (reason === 'not-paired') return `No host is paired with this terminal. Pair it (/setup pair in the Agent, /devices pair host in the terminal app), then ${again}.`;
  if (reason === 'closed') return `The view closed before the host answered. Nothing more was sent; ${again}.`;
  if (reason === 'unavailable') {
    return `The connection to the selected host could not be opened: its pairing or credential file could not be read, or its address is not usable. Nothing was sent; check the pairing (/setup pair in the Agent, /devices pair host in the terminal app), then ${again}.`;
  }
  return `The selected host or its credential changed while this was open. Nothing more was sent; ${again} to use the current one.`;
}

/** A menu owns one host, credential source and configuration incarnation.
 * All requests use that connection; a host change retires it rather than
 * retargeting an already displayed owner choice. Configuration changes retire
 * it by event; the credential files and the selection are compared once, when a
 * request starts (a pairing written by another process has no change notice).
 */
export class RetainedOperatorConnection {
  private readonly observation = new OwnedSelectionObservation();
  private readonly abort = new AbortController();
  private readonly owner: ConfigManager;
  private readonly home: string;
  private readonly incarnation: number;
  private selection: SelectedOperatorConnection | undefined;
  private sources: readonly { readonly path: string; readonly observation: ImportFileObservation }[] = [];
  private environment: readonly (string | undefined)[] = [];
  private operator: OperatorApiClient | undefined;
  private readonly unsubscribers: (() => void)[] = [];
  private closed = false;
  private pending = 0;
  private drained: (() => void) | undefined;
  private readonly drainage: Promise<void>;

  constructor(private readonly policy: RetainedOperatorConnectionPolicy) {
    this.drainage = new Promise(resolve => { this.drained = resolve; });
    this.owner = policy.owner();
    this.home = policy.home();
    this.incarnation = this.owner.getConfigurationIncarnation();
    let reason: RetainedOperatorConnectionFailure = 'unavailable';
    try {
      if (policy.signal.aborted) { reason = 'closed'; throw new RetainedOperatorConnectionError(reason); }
      this.environment = [...(policy.environment?.() ?? [])];
      const selection = policy.read(this.observation);
      if (!selection) { reason = 'not-paired'; throw new RetainedOperatorConnectionError(reason); }
      this.selection = Object.freeze({ ...selection });
      // A file replaced between the read above and this observation is caught by the first request's check.
      this.sources = [...new Set(policy.files(selection, this.home))].map(path => ({ path, observation: observeImportFile(path) }));
      const close = () => { void this.close(); };
      policy.signal.addEventListener('abort', close, { once: true });
      this.unsubscribers.push(() => policy.signal.removeEventListener('abort', close));
      this.unsubscribers.push(this.owner.onDidInvalidate(close), this.owner.onDidChangeIncarnation(close));
      const fetchImpl = policy.fetchImpl;
      this.operator = createOperatorApiClient({
        baseUrl: selection.baseUrl,
        // The platform retains this accessor, never a second permanent bearer copy.
        getAuthToken: () => { this.assertCurrent(); return this.selection?.token; },
        retry: { maxAttempts: 1 },
        fetchImpl: createNativeHostFetch({ current: () => this.open(), ...(fetchImpl === undefined ? {} : { fetchImpl }) }),
      });
    } catch {
      void this.close();
      throw new RetainedOperatorConnectionError(reason);
    }
  }

  get signal(): AbortSignal { return this.abort.signal; }
  get expectedPrincipalId(): string | undefined { this.assertCurrent(); return this.selection?.expectedPrincipalId; }

  /** Not closed and not retired by a configuration change. Integer and identity compares only. */
  assertCurrent(): void {
    if (!this.open()) throw new RetainedOperatorConnectionError('closed');
  }

  private open(): boolean {
    return !this.closed && !this.policy.signal.aborted && this.policy.owner() === this.owner
      && this.policy.home() === this.home && this.owner.getConfigurationIncarnation() === this.incarnation;
  }

  /** The credential sources and the selection are still the ones this connection opened with. */
  private sourcesUnchanged(): boolean {
    const environment = this.policy.environment?.() ?? [];
    if (environment.length !== this.environment.length || environment.some((value, index) => value !== this.environment[index])) return false;
    try { for (const source of this.sources) assertImportFileCurrent(source.path, source.observation); }
    catch { return false; }
    const selected = this.policy.read(this.observation), original = this.selection;
    return !!selected && !!original && selected.baseUrl === original.baseUrl && selected.token === original.token
      && selected.identity === original.identity && selected.expectedPrincipalId === original.expectedPrincipalId;
  }

  /** Keep the actual accepted operation owned until its promise settles, even
   * if an injected transport ignores cancellation. Every caller supplies the
   * resulting signal to its platform requests and checks complete responses here.
   */
  async run<T>(work: (operator: OperatorApiClient, signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertCurrent();
    if (!this.sourcesUnchanged()) {
      void this.close();
      throw new RetainedOperatorConnectionError('source-changed');
    }
    const operator = this.operator;
    if (!operator) throw new RetainedOperatorConnectionError('closed');
    this.pending++;
    try {
      const result = await work(operator, this.signal);
      this.assertCurrent();
      return result;
    } finally {
      this.pending--;
      if (this.closed) this.release();
    }
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.abort.abort();
      for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
      this.selection = undefined;
      this.sources = [];
      this.environment = [];
      this.observation.retire();
    }
    this.release();
    return this.drainage;
  }

  private release(): void {
    if (!this.closed || this.pending !== 0) return;
    this.operator?.dispose();
    this.operator = undefined;
    this.drained?.();
    this.drained = undefined;
  }
}
