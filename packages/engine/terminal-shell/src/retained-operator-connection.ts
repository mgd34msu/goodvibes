import { createOperatorApiClient, type OperatorApiClient, type OperatorApiClientOptions } from '@goodvibes-jev/engine/operator-client';
import { observeImportFile, assertImportFileCurrent, type ConfigManager, type ImportFileObservation } from '@goodvibes-jev/engine/platform/platform/config';
import { OwnedSelectionObservation } from '@goodvibes-jev/engine/platform/platform/runtime/client';
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

/** A menu owns one host, credential source and configuration incarnation.
 * All requests use that connection; a host change retires it rather than
 * retargeting an already displayed owner choice. File metadata plus exact
 * private bytes detect source replacement/restoration without hashing tokens.
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
    try {
      policy.signal.throwIfAborted();
      this.environment = [...(policy.environment?.() ?? [])];
      const selection = policy.read(this.observation);
      if (!selection) throw new Error('No paired operator connection is selected.');
      this.selection = Object.freeze({ ...selection });
      this.sources = [...new Set(policy.files(selection, this.home))].map(path => ({ path, observation: observeImportFile(path) }));
      this.assertCurrent();
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
        fetchImpl: createNativeHostFetch({ current: () => this.current(), ...(fetchImpl === undefined ? {} : { fetchImpl }) }),
      });
      this.assertCurrent();
    } catch {
      void this.close();
      throw new Error('The selected paired host is unavailable or changed. Check host pairing and reopen /payments pending.');
    }
  }

  get signal(): AbortSignal { return this.abort.signal; }
  get expectedPrincipalId(): string | undefined { this.assertCurrent(); return this.selection?.expectedPrincipalId; }

  assertCurrent(): void {
    if (this.closed || this.policy.signal.aborted || this.policy.owner() !== this.owner
      || this.policy.home() !== this.home || this.owner.getConfigurationIncarnation() !== this.incarnation) {
      throw new Error('The selected operator connection ended.');
    }
    const environment = this.policy.environment?.() ?? [];
    if (environment.length !== this.environment.length || environment.some((value, index) => value !== this.environment[index])) {
      throw new Error('The selected operator credential changed.');
    }
    for (const source of this.sources) assertImportFileCurrent(source.path, source.observation);
    const selected = this.policy.read(this.observation), original = this.selection;
    if (!selected || !original || selected.baseUrl !== original.baseUrl || selected.token !== original.token
      || selected.identity !== original.identity || selected.expectedPrincipalId !== original.expectedPrincipalId) {
      throw new Error('The selected operator connection changed.');
    }
  }

  private current(): boolean {
    try { this.assertCurrent(); return true; }
    catch { void this.close(); return false; }
  }

  /** Keep the actual accepted operation owned until its promise settles, even
   * if an injected transport ignores cancellation. Every caller supplies the
   * resulting signal to its platform requests and checks complete responses here.
   */
  async run<T>(work: (operator: OperatorApiClient, signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertCurrent();
    const operator = this.operator;
    if (!operator) throw new Error('The operator connection is closed.');
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
