/**
 * First run, the same in both terminal apps: step 1 chooses a provider
 * (offering what was found in the environment and by the local scan), step 2
 * signs in, step 3 is the working conversation with its starting prompts.
 *
 * First run is "not done" exactly when the model the session will use is not
 * ready (resolveDefaultModelReadiness). Leaving at any step and starting
 * again resumes from the facts: a provider chosen but not signed in opens
 * step 2; nothing chosen opens step 1. The check marker stays the record that
 * first run finished.
 *
 * Nothing is printed into the transcript (a transcript row would retire the
 * splash): step 3's lines are drawn under the splash (splash-additions.ts).
 */
import type { ConfigManager, OAuthProviderConfig, SecretsManager, SubscriptionManager } from '@goodvibes-jev/engine/platform/platform/config';
import { createOAuthLocalListener, getSubscriptionProviderConfig } from '@goodvibes-jev/engine/platform/platform/config';
import { resolveDefaultModelReadiness, type ModelDefinition, type ProviderRegistry } from '@goodvibes-jev/engine/platform/platform/providers';
import { localScanState } from '@goodvibes-jev/engine/platform/platform/discovery';
import { openExternalUrl, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import type { InputToken } from '@goodvibes-jev/engine/platform/platform/core';
import type { SurfaceModal, SurfaceModalCloseReason, SurfaceModalHost } from '../surface-modal-host.js';
import type { SurfaceLayer } from '../renderer/surface-kit.js';
import { renderChooseStep, renderSignInStep, type SignInStepView } from '../renderer/first-run.js';
import { readAuthorizationInput } from '../settings-subscriptions.js';
import { copyToClipboard } from '../clipboard.js';
import { readFirstRunOffers, FIRST_SCREEN_PROVIDERS, LOCAL_OFFER_NAME, type DiscoveryView, type FirstRunOffers, type ProviderFact, type ProviderOffer, type ProviderRegistryView } from './offers.js';
import { setFirstRunScreen } from './splash-state.js';

type SelectedModel = { readonly id: string; readonly provider: string; readonly displayName: string; readonly registryKey: string };

/** What first run needs from the app it runs in. */
export interface FirstRunDeps {
  readonly providerRegistry: ProviderRegistry;
  readonly configManager: Pick<ConfigManager, 'get' | 'isExplicitlySet'>;
  readonly secrets: Pick<SecretsManager, 'set' | 'delete'>;
  readonly subscriptions?: Pick<SubscriptionManager, 'beginOAuthLogin' | 'completeOAuthLogin' | 'getPending'> | undefined;
  /** The service file entry for a provider (a custom OAuth block), when the app has a service registry. */
  readonly serviceConfig?: ((provider: string) => Parameters<typeof getSubscriptionProviderConfig>[1]) | undefined;
  readonly pushSurfaceModal?: ((modal: SurfaceModal) => void) | undefined;
  readonly renderRequest: () => void;
  readonly completeModelSelection?: ((selection: { model: SelectedModel; effort: string }) => void) | undefined;
  /** The full provider picker ("Another provider…"). */
  readonly openProviderPicker?: (() => void) | undefined;
  /** Look for model servers on this computer now, the app's own scan (one at a time). */
  readonly scanThisComputer?: (() => void) | undefined;
  /** Record that first run finished (the check marker). */
  readonly markDone: () => void;
  /** Whether first run already finished once (the check marker exists). */
  readonly isMarkedDone: () => boolean;
}

/** The model the session will use is ready now. */
export function sessionModelReady(deps: Pick<FirstRunDeps, 'providerRegistry' | 'configManager'>): boolean {
  const readiness = resolveDefaultModelReadiness(deps.providerRegistry, String(deps.configManager.get('provider.model') ?? '').trim());
  return readiness.kind === 'configured' || readiness.kind === 'keyless';
}

/** Model servers on this computer as step 1 reads them: memory reads only. */
function discoveryView(registry: ProviderRegistry): DiscoveryView {
  return {
    state: localScanState(),
    servers: registry.listDiscoveredServers().map((server) => ({ name: server.name, models: server.models.length })),
  };
}

/**
 * The registered providers as step 1 reads them: one configured-status
 * listing (the secret stores are read once), the model list for free models,
 * and the scan's servers. First run only.
 */
export async function gatherProviderFacts(registry: ProviderRegistry): Promise<ProviderRegistryView> {
  const discovered = new Set(registry.listDiscoveredServers().map((server) => server.name));
  const ids = registry.listProviders().map((provider) => provider.name).filter((id) => id !== 'decision-router');
  const statuses = await registry.describeConfiguredProviders(ids);
  const free = new Set(registry.listModels().filter((model) => model.tier === 'free').map((model) => model.provider));
  const providers: ProviderFact[] = ids.map((id) => {
    const status = statuses.get(id);
    return {
      id,
      routes: (status?.routes ?? []).map((route) => route.route),
      ready: status?.configured ?? false,
      configuredVia: status?.configuredVia,
      envVars: status?.envVars ?? [],
      hasFreeModel: free.has(id),
      discovered: discovered.has(id),
    };
  });
  return { providers };
}

/** The model a provider answers with when chosen in first run: its declared default, else its first selectable model. */
async function providerModel(registry: ProviderRegistry, providerId: string): Promise<SelectedModel | null> {
  const models = registry.getSelectableModels().filter((model) => model.provider === providerId);
  let preferred: string | undefined;
  try {
    preferred = (await registry.describeRuntime(providerId))?.models?.defaultModel;
  } catch { /* no runtime description: the first selectable model */ }
  const model: ModelDefinition | undefined = (preferred ? models.find((candidate) => candidate.id === preferred || candidate.registryKey === preferred) : undefined) ?? models[0];
  return model ? { id: model.id, provider: model.provider, displayName: model.displayName, registryKey: model.registryKey } : null;
}

/** Where a key typed into first run is kept, in plain words. */
function storedIn(configManager: Pick<ConfigManager, 'get'>): string {
  return configManager.get('storage.secretPolicy') === 'plaintext_allowed' ? 'the settings file' : 'secure storage';
}

/** Step 2's sentence for a model-list check that failed (2.5). */
function keyCheckFailure(name: string, error: string): string {
  const status = /\b(401|403)\b/.exec(error)?.[1];
  if (status) return `That key was refused by ${name} (${status}). Check it and paste it again.`;
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|Unable to connect|timed? ?out|network|socket/i.test(error)) {
    return `GoodVibes couldn't reach ${name}. Check your connection and try again.`;
  }
  return `${name} did not accept the key: ${error}`;
}

type Step =
  | { readonly kind: 'choose' }
  | { readonly kind: 'api-key'; readonly offer: ProviderOffer; typed: string; busy: boolean; error?: string | undefined }
  | {
    readonly kind: 'browser';
    readonly offer: ProviderOffer;
    url: string | null;
    opened: boolean;
    waiting: boolean;
    needsCode: boolean;
    code: string;
    busy: boolean;
    error?: string | undefined;
    config?: OAuthProviderConfig | undefined;
    pendingState?: string | undefined;
    close?: (() => void) | undefined;
  }
  | { readonly kind: 'local'; selected: number; error?: string | undefined };

/** The three steps as one kit modal. */
export class FirstRunModal implements SurfaceModal {
  readonly name = 'first-run';
  readonly waitingForOwner = true;
  private step: Step = { kind: 'choose' };
  private selected = 0;
  private facts: ProviderRegistryView | null = null;
  private host: SurfaceModalHost | undefined;
  private finished = false;
  private pickerOpened = false;
  private frameNo = 0;
  private spinner: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: FirstRunDeps, private readonly resumeProvider?: string | undefined) {}

  /** Read the providers' facts (async, once), then open step 2 when a chosen provider waits to be signed in. */
  async load(): Promise<void> {
    try {
      this.facts = await gatherProviderFacts(this.deps.providerRegistry);
    } catch {
      this.facts = { providers: [] };
    }
    if (this.resumeProvider) {
      const offer = this.offers()?.rows.find((row) => row.providerId === this.resumeProvider && row.route !== 'local');
      if (offer) this.openStep2(offer);
    }
    this.deps.renderRequest();
  }

  private offers(): FirstRunOffers | null {
    if (!this.facts) return null;
    const discovery = discoveryView(this.deps.providerRegistry);
    // A server the scan registered after the facts were read joins the local row.
    const known = new Set(this.facts.providers.map((provider) => provider.id));
    const late = discovery.servers.filter((server) => !known.has(server.name)).map((server): ProviderFact => ({
      id: server.name, routes: ['anonymous'], ready: server.models > 0, envVars: [], hasFreeModel: false, discovered: true,
    }));
    return readFirstRunOffers({ providers: [...this.facts.providers, ...late] }, discovery, { isSet: (name) => typeof process.env[name] === 'string' && process.env[name] !== '' });
  }

  // -- finishing ---------------------------------------------------------

  private finish(model: SelectedModel, signIn: 'signed in' | 'no sign-in needed'): void {
    if (this.finished) return;
    this.finished = true;
    const effort = this.deps.configManager.get('provider.reasoningEffort');
    this.deps.completeModelSelection?.({ model, effort: typeof effort === 'string' ? effort : '' });
    this.deps.markDone();
    setFirstRunScreen({ kind: 'set', model: model.displayName || model.id, signIn });
    this.stopSpinner();
    this.host?.close(this, 'done');
    this.deps.renderRequest();
  }

  private async finishWithProvider(providerId: string, signIn: 'signed in' | 'no sign-in needed'): Promise<string | undefined> {
    const model = await providerModel(this.deps.providerRegistry, providerId);
    if (!model) return 'No model of that provider can be chosen yet. Choose one with /model.';
    this.finish(model, signIn);
    return undefined;
  }

  // -- step 1 ------------------------------------------------------------

  private choose(): void {
    const offers = this.offers();
    if (!offers) return;
    if (this.selected >= offers.rows.length) {
      // "Another provider…": the full picker; when its choice makes the session's model ready, first run is done.
      this.pickerOpened = true;
      this.deps.openProviderPicker?.();
      return;
    }
    const offer = offers.rows[this.selected]!;
    if (offer.ready && offer.route !== 'local') {
      void this.finishWithProvider(offer.providerId, offer.route === 'none-needed' ? 'no sign-in needed' : 'signed in');
      return;
    }
    this.openStep2(offer);
  }

  private openStep2(offer: ProviderOffer): void {
    if (offer.route === 'local') {
      this.step = { kind: 'local', selected: 0 };
      if (offer.providerId === '' && localScanState() !== 'running') this.deps.scanThisComputer?.();
      return;
    }
    if (offer.route === 'browser-sign-in') {
      const step: Step = { kind: 'browser', offer, url: null, opened: false, waiting: false, needsCode: false, code: '', busy: true };
      this.step = step;
      void this.beginBrowserSignIn(step);
      return;
    }
    this.step = { kind: 'api-key', offer, typed: '', busy: false };
  }

  private useFoundKey(): void {
    const found = this.offers()?.foundKey;
    if (!found) return;
    void this.finishWithProvider(found.providerId, 'signed in');
  }

  // -- step 2: a key -----------------------------------------------------

  private envVarFor(providerId: string): string | undefined {
    return this.facts?.providers.find((provider) => provider.id === providerId)?.envVars[0];
  }

  private async saveKey(step: Extract<Step, { kind: 'api-key' }>): Promise<void> {
    const key = step.typed.trim();
    const variable = this.envVarFor(step.offer.providerId);
    if (!key || !variable) {
      step.error = key ? `${step.offer.name} takes no key here.` : 'Paste the key first.';
      this.deps.renderRequest();
      return;
    }
    step.busy = true;
    step.error = undefined;
    this.deps.renderRequest();
    const registry = this.deps.providerRegistry;
    try {
      await this.deps.secrets.set(variable, key, { scope: 'user' });
      await registry.refreshProviderCredentials();
      // One model-list request checks the key, first run only.
      const report = (await registry.refreshLiveModelDiscovery(step.offer.providerId, { force: true }))[0];
      if (report?.error) {
        await this.deps.secrets.delete(variable, { scope: 'user' }).catch(() => undefined);
        await registry.refreshProviderCredentials();
        step.error = keyCheckFailure(step.offer.name, report.error);
        step.typed = '';
      } else {
        const failed = await this.finishWithProvider(step.offer.providerId, 'signed in');
        if (failed) step.error = failed;
      }
    } catch (error) {
      step.error = `The key could not be stored: ${summarizeError(error)}`;
    } finally {
      step.busy = false;
      this.deps.renderRequest();
    }
  }

  // -- step 2: the browser -----------------------------------------------

  private async beginBrowserSignIn(step: Extract<Step, { kind: 'browser' }>): Promise<void> {
    const providerId = step.offer.providerId;
    const manager = this.deps.subscriptions;
    const resolved = getSubscriptionProviderConfig(providerId, this.deps.serviceConfig?.(providerId) ?? null);
    if (!manager || !resolved) {
      step.busy = false;
      step.error = `Signing in with a browser is not available for ${step.offer.name} here.`;
      this.deps.renderRequest();
      return;
    }
    let config: OAuthProviderConfig = resolved.oauth.localCallback ? resolved.oauth : resolved.oauth.manualRedirectUri ? { ...resolved.oauth, redirectUri: resolved.oauth.manualRedirectUri } : resolved.oauth;
    let listener: Awaited<ReturnType<typeof createOAuthLocalListener>> | null = null;
    try {
      if (resolved.oauth.localCallback) {
        listener = await createOAuthLocalListener({
          expectedState: '',
          host: resolved.oauth.localCallback.host,
          port: resolved.oauth.localCallback.port,
          path: resolved.oauth.localCallback.path,
        }).catch(() => null);
        if (listener) config = { ...config, redirectUri: listener.redirectUri };
        else if (resolved.oauth.manualRedirectUri) config = { ...resolved.oauth, redirectUri: resolved.oauth.manualRedirectUri };
      }
      const started = await manager.beginOAuthLogin(providerId, config);
      listener?.setExpectedState(started.pending.state);
      if (this.step !== step) { listener?.close(); return; }
      step.config = config;
      step.pendingState = started.pending.state;
      step.url = started.authorizationUrl;
      step.opened = await openExternalUrl(started.authorizationUrl);
      step.waiting = Boolean(listener) && step.opened && (resolved.oauth.localCallback?.autoComplete ?? true);
      step.needsCode = !step.waiting;
      step.busy = false;
      const active = listener;
      step.close = () => active?.close();
      if (step.waiting) this.startSpinner();
      if (step.waiting && active) {
        void active.waitForCode().then(async (callback) => {
          if (this.step !== step) return;
          await manager.completeOAuthLogin(providerId, config, callback.code);
          active.close();
          const failed = await this.finishWithProvider(providerId, 'signed in');
          if (failed) { step.error = failed; this.deps.renderRequest(); }
        }).catch(() => {
          if (this.step !== step || this.finished) return;
          active.close();
          step.waiting = false;
          step.needsCode = true;
          step.error = 'Sign-in was cancelled in the browser. Press ⏎ to start again.';
          this.stopSpinner();
          this.deps.renderRequest();
        });
      } else {
        listener?.close();
      }
    } catch (error) {
      listener?.close();
      step.busy = false;
      step.error = `The sign-in could not start: ${summarizeError(error)}`;
    }
    this.deps.renderRequest();
  }

  private async finishBrowserWithCode(step: Extract<Step, { kind: 'browser' }>): Promise<void> {
    const manager = this.deps.subscriptions;
    if (!manager) return;
    if (!step.code.trim()) {
      // Nothing pasted: start the sign-in again (the error said so).
      if (step.error && !step.waiting) {
        step.close?.();
        const next: Step = { kind: 'browser', offer: step.offer, url: null, opened: false, waiting: false, needsCode: false, code: '', busy: true };
        this.step = next;
        void this.beginBrowserSignIn(next);
      }
      return;
    }
    const providerId = step.offer.providerId;
    const resolved = getSubscriptionProviderConfig(providerId, this.deps.serviceConfig?.(providerId) ?? null);
    const authorization = readAuthorizationInput(step.code, manager.getPending(providerId)?.state ?? step.pendingState);
    if (!authorization.ok) { step.error = authorization.reason; this.deps.renderRequest(); return; }
    step.busy = true;
    this.deps.renderRequest();
    try {
      const config = resolved?.oauth.manualRedirectUri ? { ...resolved.oauth, redirectUri: resolved.oauth.manualRedirectUri } : (step.config ?? resolved?.oauth);
      if (!config) throw new Error('the sign-in is not set up');
      await manager.completeOAuthLogin(providerId, config, authorization.code);
      step.close?.();
      const failed = await this.finishWithProvider(providerId, 'signed in');
      if (failed) step.error = failed;
    } catch (error) {
      step.error = `${step.offer.name} did not accept that code: ${summarizeError(error)}`;
    } finally {
      step.busy = false;
      this.deps.renderRequest();
    }
  }

  private startSpinner(): void {
    if (this.spinner) return;
    this.spinner = setInterval(() => { this.frameNo += 1; this.deps.renderRequest(); }, 120);
    (this.spinner as { unref?: () => void }).unref?.();
  }

  private stopSpinner(): void {
    if (this.spinner) clearInterval(this.spinner);
    this.spinner = null;
  }

  // -- step 2: a model on this computer ----------------------------------

  private localModels(): readonly { readonly model: SelectedModel; readonly label: string; readonly detail: string }[] {
    return this.deps.providerRegistry.listDiscoveredServers().flatMap((server) => server.models.map((modelId) => {
      const window = server.modelContextWindows?.[modelId];
      return {
        model: { id: modelId, provider: server.name, displayName: modelId, registryKey: `${server.name}:${modelId}` },
        label: modelId,
        detail: [server.name, window ? `${Math.round(window / 1000)}k context` : ''].filter(Boolean).join(' · '),
      };
    }));
  }

  // -- keys ----------------------------------------------------------------

  handleToken(token: InputToken, host: SurfaceModalHost): void {
    this.host = host;
    const step = this.step;
    if (step.kind === 'choose') {
      if (token.type !== 'key' && !(token.type === 'text' && token.value === 'a')) return;
      if (token.type === 'text') { this.useFoundKey(); return; }
      const count = (this.offers()?.rows.length ?? 0) + 1;
      const key = token.logicalName;
      if (key === 'up') this.selected = (this.selected - 1 + count) % count;
      else if (key === 'down') this.selected = (this.selected + 1) % count;
      else if (key === 'enter') this.choose();
      return;
    }
    if (step.kind === 'api-key') {
      if (step.busy) return;
      if (token.type === 'text') { step.typed += token.value.replace(/[\r\n]/g, ''); step.error = undefined; return; }
      if (token.type !== 'key') return;
      if (token.logicalName === 'backspace') step.typed = step.typed.slice(0, -1);
      else if (token.logicalName === 'enter') void this.saveKey(step);
      return;
    }
    if (step.kind === 'browser') {
      if (step.busy) return;
      if (token.type === 'text') {
        if (!step.needsCode && token.value === 'c' && step.url) { copyToClipboard(step.url); return; }
        if (step.needsCode) {
          if (token.value === 'c' && step.code === '' && step.url) { copyToClipboard(step.url); return; }
          step.code += token.value.replace(/[\r\n]/g, '');
          step.error = undefined;
        }
        return;
      }
      if (token.type !== 'key') return;
      if (token.logicalName === 'backspace') step.code = step.code.slice(0, -1);
      else if (token.logicalName === 'enter') void this.finishBrowserWithCode(step);
      return;
    }
    // local
    const models = this.localModels();
    if (token.type !== 'key') return;
    if (models.length === 0) {
      if (token.logicalName === 'enter' && localScanState() !== 'running') this.deps.scanThisComputer?.();
      return;
    }
    if (token.logicalName === 'up') step.selected = (step.selected - 1 + models.length) % models.length;
    else if (token.logicalName === 'down') step.selected = (step.selected + 1) % models.length;
    else if (token.logicalName === 'enter') {
      const chosen = models[step.selected];
      if (chosen) this.finish(chosen.model, 'no sign-in needed');
    }
  }

  /** Esc: step 2 goes back to step 1; on step 1 the modal closes (set up later). */
  escape(): boolean {
    const step = this.step;
    if (step.kind === 'choose') return false;
    if (step.kind === 'browser') step.close?.();
    this.stopSpinner();
    this.step = { kind: 'choose' };
    return true;
  }

  onClose(reason: SurfaceModalCloseReason): void {
    this.stopSpinner();
    const step = this.step;
    if (step.kind === 'browser') step.close?.();
    if (!this.finished) {
      // Set up later: nothing is marked and nothing printed; the conversation says it is not set up.
      setFirstRunScreen(sessionModelReady(this.deps) ? undefined : { kind: 'not-ready' });
      if (reason !== 'cleared') this.deps.renderRequest();
    }
  }

  // -- drawing -------------------------------------------------------------

  render(screenWidth: number, screenHeight: number): SurfaceLayer {
    // The full picker chose a model that is ready: first run is done.
    if (this.pickerOpened && !this.finished && sessionModelReady(this.deps)) {
      this.pickerOpened = false;
      const current = this.deps.providerRegistry.getCurrentModel();
      queueMicrotask(() => this.finish({ id: current.id, provider: current.provider, displayName: current.displayName, registryKey: current.registryKey }, 'signed in'));
    }
    const step = this.step;
    if (step.kind === 'choose') {
      const offers = this.offers();
      if (offers) this.selected = Math.min(this.selected, offers.rows.length);
      return renderChooseStep(screenWidth, screenHeight, { offers, selected: this.selected });
    }
    return renderSignInStep(screenWidth, screenHeight, this.signInView(step));
  }

  private signInView(step: Exclude<Step, { kind: 'choose' }>): SignInStepView {
    if (step.kind === 'api-key') {
      return { kind: 'api-key', name: step.offer.name, typed: step.typed.length, storedIn: storedIn(this.deps.configManager), busy: step.busy, error: step.error };
    }
    if (step.kind === 'browser') {
      return {
        kind: 'browser', name: step.offer.name, opened: step.opened, url: step.url, needsCode: step.needsCode, waiting: step.waiting,
        code: step.code, busy: step.busy, error: step.error, frame: this.frameNo,
      };
    }
    const models = this.localModels();
    step.selected = Math.min(step.selected, Math.max(0, models.length - 1));
    return {
      kind: 'local', name: LOCAL_OFFER_NAME,
      models: models.map((entry) => ({ label: entry.label, detail: entry.detail })),
      selected: step.selected, none: models.length === 0, scanning: localScanState() === 'running', error: step.error,
    };
  }
}

/**
 * Start first run when the session's model is not ready; otherwise record
 * nothing to show but the starting prompts. Waits for the provider registry
 * (custom providers load in the background) before deciding. Returns true
 * when first run opened.
 */
export async function startFirstRun(deps: FirstRunDeps): Promise<boolean> {
  try {
    await deps.providerRegistry.ready();
  } catch { /* decided from what is registered */ }
  if (sessionModelReady(deps)) {
    // A ready model on a first launch: first run has nothing to ask; it is recorded as done.
    if (!deps.isMarkedDone()) deps.markDone();
    setFirstRunScreen(undefined);
    return false;
  }
  if (!deps.pushSurfaceModal) {
    setFirstRunScreen({ kind: 'not-ready' });
    return false;
  }
  setFirstRunScreen({ kind: 'pending' });
  // A provider the person chose (provider.model set by them) that is not signed in: step 2 for it.
  const readiness = resolveDefaultModelReadiness(deps.providerRegistry, String(deps.configManager.get('provider.model') ?? '').trim());
  const chosen = deps.configManager.isExplicitlySet('provider.model') && readiness.kind === 'needs-key'
    && FIRST_SCREEN_PROVIDERS.some((entry) => entry.providerId === readiness.provider)
    ? readiness.provider
    : undefined;
  const modal = new FirstRunModal(deps, chosen);
  deps.pushSurfaceModal(modal);
  if (localScanState() === 'off') deps.scanThisComputer?.();
  await modal.load();
  return true;
}
