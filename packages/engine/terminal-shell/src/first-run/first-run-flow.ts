/**
 * First run, the same in both terminal apps: step 1 chooses a provider
 * (offering what was found in the environment and by the local scan), step 2
 * signs in, step 3 is the working conversation.
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
import type { ConfigManager, OAuthProviderConfig, SecretsManager, SubscriptionManager } from '@goodvibes/engine/platform/platform/config';
import { createOAuthLocalListener, getSubscriptionProviderConfig, readAuthorizationInput } from '@goodvibes/engine/platform/platform/config';
import { resolveDefaultModelReadiness, type ModelDefinition, type ProviderRegistry } from '@goodvibes/engine/platform/platform/providers';
import { localScanState } from '@goodvibes/engine/platform/platform/discovery';
import { decisionModelReadiness, storeDecisionModelKey, type DecisionModelReadiness, type JudgmentSettingsSource } from '@goodvibes/engine/platform/platform/runtime/judgment-services';
import { logger, openExternalUrl, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import type { InputToken } from '@goodvibes/engine/platform/platform/core';
import type { SurfaceModal, SurfaceModalCloseReason, SurfaceModalHost } from '../surface-modal-host.js';
import type { SurfaceLayer } from '../renderer/surface-kit.js';
import { renderChooseStep, renderDecideStep, renderSignInStep, type SignInStepView } from '../renderer/first-run.js';
import { copyToClipboard } from '../clipboard.js';
import { runPickedCommand } from '../command-registry.js';
import { choosableProviderIds, readFirstRunOffers, readUsableProvider, FIRST_SCREEN_PROVIDERS, INTERNAL_PROVIDER_IDS, LOCAL_OFFER_NAME, type DiscoveryView, type FirstRunOffers, type ProviderFact, type ProviderOffer, type ProviderRegistryView, type UsableProvider } from './offers.js';
import { setFirstRunScreen } from './splash-state.js';

/** How often first run looks again for a model server on this computer while it has found none. */
const LOOK_AGAIN_EVERY_MS = 2_000;

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
  readonly completeModelSelection?: ((selection: { model: SelectedModel; effort: string; quiet?: boolean }) => void) | undefined;
  /** The full provider picker ("Another provider…"). */
  readonly openProviderPicker?: (() => void) | undefined;
  /** Look for model servers on this computer now, the app's own scan (one at a time). */
  readonly scanThisComputer?: (() => void) | undefined;
  /** Draw the conversation again (the splash's model line names the model now in use). */
  readonly redrawConversation?: (() => void) | undefined;
  /** Record that first run finished (the check marker). */
  readonly markDone: () => void;
  /** Whether first run already finished once (the check marker exists). */
  readonly isMarkedDone: () => boolean;
  /**
   * Who decides when GoodVibes would otherwise stop and ask: whether a decision
   * model can be asked now, storing a pasted TypeSafe key, and choosing Ask me
   * (firstRunDecisionModel). Absent: first run has no such step.
   */
  readonly decisionModel?: FirstRunDecisionModel | undefined;
  /**
   * "Another decision model…": the decision-models settings (Cloudflare and the
   * other backends the judgment port supports). First run goes on once one is usable.
   */
  readonly openDecisionModelSettings?: (() => void) | undefined;
  /**
   * Whether "Who decides" was answered or put off (Esc) already: then it is not
   * opened again by itself; the status line's mode segment opens it.
   */
  readonly whoDecidesAsked: () => boolean;
  /** Record that "Who decides" was answered, or put off for now. */
  readonly recordWhoDecides: (how: 'answered' | 'put-off') => void;
}

/** "Who decides" opens by itself: it is needed now and was never answered or put off. */
async function whoDecidesDue(deps: FirstRunDeps): Promise<boolean> {
  if (!deps.decisionModel || deps.whoDecidesAsked()) return false;
  try { return await deps.decisionModel.needsChoice(); } catch { return true; }
}

/**
 * Open "Who decides" alone, for the model in use, when it is needed now (the
 * status line's mode segment; first start). False when it is not needed or
 * cannot open here.
 */
export async function openWhoDecides(deps: FirstRunDeps): Promise<boolean> {
  if (!deps.decisionModel || !deps.pushSurfaceModal) return false;
  let needed: boolean;
  try { needed = await deps.decisionModel.needsChoice(); } catch { needed = true; }
  if (!needed) return false;
  pushWhoDecides(deps, deps.pushSurfaceModal);
  return true;
}

/**
 * A click on the status line's mode segment: "Who decides" while no decision
 * model can be asked (the segment then reads "Jev decides: no decision model
 * set"); otherwise /permissions, what is in force and why. Always settles.
 */
export async function openModeSegment(context: {
  readonly openWhoDecides?: (() => Promise<boolean>) | undefined;
  readonly executeCommand?: ((name: string, args: string[]) => Promise<boolean>) | undefined;
  readonly print: (message: string) => void;
}): Promise<void> {
  try {
    if (await context.openWhoDecides?.()) return;
  } catch (error) {
    logger.warn('[first-run] "Who decides" could not open; /permissions instead', { error: summarizeError(error) });
  }
  await runPickedCommand(context.executeCommand, 'permissions', [], (message) => context.print(message));
}

/** "Who decides" alone, for the model in use. */
function pushWhoDecides(deps: FirstRunDeps, push: (modal: SurfaceModal) => void): void {
  const current = deps.providerRegistry.getCurrentModel();
  push(new FirstRunModal(deps, undefined, { id: current.id, provider: current.provider, displayName: current.displayName, registryKey: current.registryKey }));
}

/** What first run's "Who decides" step reads and writes. */
export interface FirstRunDecisionModel {
  /**
   * Whether "Who decides" is asked: the mode lets the decision model decide
   * (Jev decides, Just vibes) and none can be asked now. A usable key, or Ask
   * me chosen already, asks nothing.
   */
  readonly needsChoice: () => Promise<boolean>;
  /** Whether a decision model is usable now; with `check`, one request to it. */
  readonly readiness: (check?: { readonly signal: AbortSignal }) => Promise<DecisionModelReadiness>;
  /** Store a pasted TypeSafe key and point the decision model at it. */
  readonly storeKey: (pasted: string) => Promise<{ readonly ok: true } | { readonly ok: false; readonly sentence: string }>;
  /** "Ask me": GoodVibes stops and asks you (permissions.mode ask-me). */
  readonly askMe: () => void;
  /**
   * A decision model was picked here (a TypeSafe key, or one set in Settings):
   * Jev decides is recorded as the person's own choice, not the shipped default,
   * so it is in force at once whatever model answers.
   */
  readonly chooseJevDecides: () => void;
}

/** The "Who decides" step's reads and writes from a program's settings and secret store. */
export function firstRunDecisionModel(
  config: JudgmentSettingsSource['config'] & Pick<ConfigManager, 'setMany' | 'set' | 'get'>,
  secrets: JudgmentSettingsSource['secrets'] & Pick<SecretsManager, 'set'>,
): FirstRunDecisionModel {
  const source: JudgmentSettingsSource = { config, secrets, env: process.env };
  return {
    needsChoice: async () => {
      const mode = String(config.get('permissions.mode') ?? '');
      if (mode !== 'jev-decides' && mode !== 'just-vibes') return false;
      const readiness = await decisionModelReadiness(source);
      return !readiness.usable;
    },
    readiness: (check) => decisionModelReadiness(source, check),
    storeKey: (pasted) => storeDecisionModelKey({ secrets, config }, pasted),
    askMe: () => { config.set('permissions.mode', 'ask-me'); },
    chooseJevDecides: () => { config.set('permissions.mode', 'jev-decides'); },
  };
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
  const ids = registry.listProviders().map((provider) => provider.name).filter((id) => !INTERNAL_PROVIDER_IDS.has(id));
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
      label: registry.providerDisplayName(id),
    };
  });
  return { providers, pickerProviders: choosableProviderIds(registry) };
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
  | { readonly kind: 'local'; selected: number; error?: string | undefined }
  /** Who decides when GoodVibes would otherwise stop and ask: Jev (a key) or Ask me. */
  | { readonly kind: 'decide'; selected: number; readonly model: SelectedModel; readonly signIn: 'signed in' | 'no sign-in needed'; error?: string | undefined }
  /** Jev chosen: the TypeSafe key, checked with one request. */
  | { readonly kind: 'jev-key'; readonly model: SelectedModel; readonly signIn: 'signed in' | 'no sign-in needed'; typed: string; busy: boolean; error?: string | undefined };

/** The "Who decides" step's rows, in order (renderer/first-run.ts DECIDE_CHOICES). */
const DECIDE_ROWS = ['jev', 'ask-me', 'other'] as const;

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
  /** While "no model server on this computer" shows: look again (loopback only) every two seconds. */
  private lookAgain: ReturnType<typeof setInterval> | null = null;
  /** The "Who decides" step comes after the model: no decision model can be asked yet (read once, locally). */
  private deciderNeeded = false;
  /** The model is already in use (chosen before the "Who decides" step). */
  private modelSelected = false;
  /** The "Who decides" step was answered or put off (or there was none). */
  private decided = false;
  /** How "Who decides" ended: a choice, or Esc (later). */
  private decideAnswer: 'answered' | 'put-off' = 'answered';
  /** The decision-models settings were opened from "Who decides": first run goes on once one is usable. */
  private settingsOpened = false;
  /** A readiness read for that is in flight. */
  private settingsChecking = false;
  /** First run shows only "Who decides" (the model was ready, or taken without asking). */
  private readonly decideOnly: boolean;

  /**
   * `decideFor`: the session's model is ready already, so first run is only
   * its "Who decides" step, for that model. `using`: that model was taken
   * without asking, and this is the line that says so once first run is done.
   */
  constructor(private readonly deps: FirstRunDeps, private readonly resumeProvider?: string | undefined, decideFor?: SelectedModel,
    private readonly using?: string | undefined) {
    this.decideOnly = decideFor !== undefined;
    if (decideFor) {
      this.deciderNeeded = true;
      this.modelSelected = true;
      this.step = { kind: 'decide', selected: 0, model: decideFor, signIn: 'signed in' };
    }
  }

  /** Read the providers' facts (async, once), then open step 2 when a chosen provider waits to be signed in. */
  async load(): Promise<void> {
    try {
      this.facts = await gatherProviderFacts(this.deps.providerRegistry);
    } catch {
      this.facts = { providers: [] };
    }
    // A local read: when no decision model can be asked and "Who decides" was never answered or put off, the model is followed by it.
    if (this.deps.decisionModel && this.step.kind !== 'decide') this.deciderNeeded = await whoDecidesDue(this.deps);
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
    return readFirstRunOffers({ providers: [...this.facts.providers, ...late], pickerProviders: this.facts.pickerProviders }, discovery);
  }

  // -- finishing ---------------------------------------------------------

  private selectModel(model: SelectedModel): void {
    if (this.modelSelected) return;
    this.modelSelected = true;
    const effort = this.deps.configManager.get('provider.reasoningEffort');
    // Quiet: a line in the conversation would retire the splash; "You're set" says it instead.
    this.deps.completeModelSelection?.({ model, effort: typeof effort === 'string' ? effort : '', quiet: true });
  }

  private finish(model: SelectedModel, signIn: 'signed in' | 'no sign-in needed'): void {
    if (this.finished) return;
    // No decision model can be asked yet: the model is in use, and "Who decides" comes next.
    if (this.deciderNeeded && !this.decided) {
      this.selectModel(model);
      this.stopSpinner();
      this.stopLookingAgain();
      this.step = { kind: 'decide', selected: 0, model, signIn };
      this.deps.renderRequest();
      return;
    }
    this.finished = true;
    this.selectModel(model);
    // Answered or put off: "Who decides" is not opened again by itself (the status line's mode segment opens it).
    if (this.deciderNeeded) this.deps.recordWhoDecides(this.decideAnswer);
    this.deps.markDone();
    setFirstRunScreen({ kind: 'set', model: model.displayName || model.id, signIn, steps: this.deciderNeeded ? 4 : 3, ...(this.using ? { using: this.using } : {}) });
    this.deps.redrawConversation?.();
    this.stopSpinner();
    this.stopLookingAgain();
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
        const stopWaiting = (message: string): void => {
          if (this.step !== step || this.finished) return;
          active.close();
          step.waiting = false;
          step.needsCode = true;
          step.error = message;
          this.stopSpinner();
          this.deps.renderRequest();
        };
        void active.waitForCode().then(async (callback) => {
          if (this.step !== step) return;
          try {
            await manager.completeOAuthLogin(providerId, config, callback.code);
            active.close();
            const failed = await this.finishWithProvider(providerId, 'signed in');
            if (failed) { step.error = failed; this.deps.renderRequest(); }
          } catch (error) {
            const reason = summarizeError(error).replace(/[.\s]+$/, '');
            logger.warn('[first-run] browser sign-in came back but could not be completed', { provider: providerId, error: reason });
            stopWaiting(`The sign-in came back but ${step.offer.name} did not complete it: ${reason}. Press ⏎ to start again.`);
          }
        }, (error: unknown) => {
          const reason = summarizeError(error).replace(/[.\s]+$/, '');
          if (this.step !== step || this.finished) return;
          logger.warn('[first-run] browser sign-in did not return a code', { provider: providerId, error: reason });
          const refused = /^OAuth callback returned error: (.*)$/s.exec(reason);
          if (refused) stopWaiting(`${step.offer.name} refused the sign-in: ${refused[1]}. Press ⏎ to start again.`);
          else stopWaiting(`The sign-in could not wait for the browser: ${reason}. Press ⏎ to start again.`);
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

  /**
   * The step that found no model server looks for one by itself: every two seconds while it
   * shows, the app's scan of this computer (loopback addresses only) runs again, and the
   * step shows the models the moment one answers. It stops when a server is found, the step
   * is left or first run closes.
   */
  private startLookingAgain(): void {
    if (this.lookAgain) return;
    this.lookAgain = setInterval(() => {
      if (this.finished || this.step.kind !== 'local' || this.localModels().length > 0) {
        this.stopLookingAgain();
        this.deps.renderRequest();
        return;
      }
      if (localScanState() !== 'running') this.deps.scanThisComputer?.();
      this.deps.renderRequest();
    }, LOOK_AGAIN_EVERY_MS);
    (this.lookAgain as { unref?: () => void }).unref?.();
  }

  private stopLookingAgain(): void {
    if (this.lookAgain) clearInterval(this.lookAgain);
    this.lookAgain = null;
  }

  // -- step 2: a model on this computer ----------------------------------

  private localModels(): readonly { readonly model: SelectedModel; readonly label: string; readonly detail: string }[] {
    return this.deps.providerRegistry.listDiscoveredServers().flatMap((server) => server.models.map((modelId) => {
      const window = server.modelContextWindows?.[modelId];
      return {
        model: { id: modelId, provider: server.name, displayName: modelId, registryKey: `${server.name}:${modelId}` },
        label: modelId,
        // Size only where the server reported one in the listing the scan read.
        detail: [server.name, server.modelSizes?.[modelId] ?? '', window ? `${Math.round(window / 1000)}k context` : ''].filter(Boolean).join(' · '),
      };
    }));
  }

  // -- keys ----------------------------------------------------------------

  handleToken(token: InputToken, host: SurfaceModalHost): void {
    this.host = host;
    const step = this.step;
    // Shift+Tab is a second back key on step 2, as the key row says (Esc is the first; escape() below).
    if (step.kind !== 'choose' && token.type === 'key' && token.logicalName === 'tab' && token.shift) {
      if (this.escape()) this.deps.renderRequest();
      return;
    }
    if (step.kind === 'choose') {
      if (token.type !== 'key') return;
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
    if (step.kind === 'decide') {
      if (token.type !== 'key') return;
      const key = token.logicalName;
      if (key === 'up') step.selected = (step.selected - 1 + DECIDE_ROWS.length) % DECIDE_ROWS.length;
      else if (key === 'down') step.selected = (step.selected + 1) % DECIDE_ROWS.length;
      else if (key === 'enter') this.decide(step);
      return;
    }
    if (step.kind === 'jev-key') {
      if (step.busy) return;
      if (token.type === 'text') { step.typed += token.value.replace(/[\r\n]/g, ''); step.error = undefined; return; }
      if (token.type !== 'key') return;
      if (token.logicalName === 'backspace') step.typed = step.typed.slice(0, -1);
      else if (token.logicalName === 'enter') void this.saveDecisionKey(step);
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

  // -- who decides ---------------------------------------------------------

  private decide(step: Extract<Step, { kind: 'decide' }>): void {
    const row = DECIDE_ROWS[step.selected];
    if (row === 'jev') {
      this.step = { kind: 'jev-key', model: step.model, signIn: step.signIn, typed: '', busy: false };
      return;
    }
    if (row === 'other') {
      // The decision-models settings; first run goes on by itself once one is usable (render).
      if (!this.deps.openDecisionModelSettings) { step.error = 'Settings cannot be opened here: choose a decision model later in /settings.'; return; }
      step.error = undefined;
      this.settingsOpened = true;
      this.deps.openDecisionModelSettings();
      return;
    }
    // Ask me: GoodVibes stops and asks; the status line then reads that mode alone.
    this.deps.decisionModel?.askMe();
    this.decided = true;
    this.finish(step.model, step.signIn);
  }

  /** Store the pasted key, then one request checks it; a refusal says what failed and the key can be pasted again. */
  private async saveDecisionKey(step: Extract<Step, { kind: 'jev-key' }>): Promise<void> {
    const decision = this.deps.decisionModel;
    if (!decision) return;
    if (!step.typed.trim()) { step.error = 'Paste the key first.'; this.deps.renderRequest(); return; }
    step.busy = true;
    step.error = undefined;
    this.deps.renderRequest();
    try {
      const stored = await decision.storeKey(step.typed);
      if (!stored.ok) { step.error = stored.sentence; return; }
      const checked = await decision.readiness({ signal: new AbortController().signal });
      if (!checked.usable) { step.error = checked.sentence; step.typed = ''; return; }
      decision.chooseJevDecides();
      this.decided = true;
      this.finish(step.model, step.signIn);
    } catch (error) {
      step.error = `The key could not be checked: ${summarizeError(error)}`;
    } finally {
      step.busy = false;
      this.deps.renderRequest();
    }
  }

  /** Esc: step 2 goes back to step 1; on step 1 the modal closes (set up later). */
  escape(): boolean {
    const step = this.step;
    if (step.kind === 'choose') return false;
    // The key goes back to "Who decides"; "Who decides" itself is left for later (Settings), first run done.
    if (step.kind === 'jev-key') { this.step = { kind: 'decide', selected: 0, model: step.model, signIn: step.signIn }; return true; }
    if (step.kind === 'decide') {
      this.decided = true;
      this.decideAnswer = 'put-off';
      // finish() closes the modal through its host when it has one; without one the caller closes it.
      const closesItself = this.host !== undefined;
      this.finish(step.model, step.signIn);
      return closesItself;
    }
    if (step.kind === 'browser') step.close?.();
    this.stopSpinner();
    this.stopLookingAgain();
    this.step = { kind: 'choose' };
    return true;
  }

  onClose(reason: SurfaceModalCloseReason): void {
    this.stopSpinner();
    this.stopLookingAgain();
    const step = this.step;
    if (step.kind === 'browser') step.close?.();
    if (!this.finished) {
      // Closed while "Who decides" showed: put off, as Esc would.
      if (step.kind === 'decide' || step.kind === 'jev-key') this.deps.recordWhoDecides('put-off');
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
    // A decision model was set in Settings from "Who decides": once it is usable, first run is done.
    if (this.settingsOpened && !this.finished && !this.settingsChecking && this.deps.decisionModel && this.step.kind === 'decide') {
      this.settingsChecking = true;
      const step = this.step;
      void this.deps.decisionModel.readiness().then((readiness) => {
        this.settingsChecking = false;
        if (!readiness.usable || this.finished || this.step !== step) return;
        this.settingsOpened = false;
        this.deps.decisionModel?.chooseJevDecides();
        this.decided = true;
        this.finish(step.model, step.signIn);
      }, () => { this.settingsChecking = false; });
    }
    const step = this.step;
    const total = this.deciderNeeded ? 4 : 3;
    if (step.kind === 'choose') {
      const offers = this.offers();
      if (offers) this.selected = Math.min(this.selected, offers.rows.length);
      return renderChooseStep(screenWidth, screenHeight, { offers, selected: this.selected, total });
    }
    if (step.kind === 'decide' || step.kind === 'jev-key') {
      return renderDecideStep(screenWidth, screenHeight, step.kind === 'decide'
        ? { kind: 'decide', selected: step.selected, total, only: this.decideOnly, error: step.error }
        : { kind: 'jev-key', typed: step.typed.length, busy: step.busy, error: step.error, total, only: this.decideOnly });
    }
    return renderSignInStep(screenWidth, screenHeight, this.signInView(step), total);
  }

  private signInView(step: Exclude<Step, { kind: 'choose' | 'decide' | 'jev-key' }>): SignInStepView {
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
    // The first look shows "Looking…"; once it found nothing, the looks that follow keep the
    // "found none" text steady instead of flickering between the two.
    const scanning = localScanState() === 'running';
    if (models.length === 0 && !this.finished && !scanning) this.startLookingAgain();
    else if (models.length > 0) this.stopLookingAgain();
    return {
      kind: 'local', name: LOCAL_OFFER_NAME,
      models: models.map((entry) => ({ label: entry.label, detail: entry.detail })),
      selected: step.selected, none: models.length === 0, scanning: scanning && this.lookAgain === null, error: step.error,
    };
  }
}

/**
 * First run with a usable provider already there (a key in the environment, a
 * stored key or a sign-in): the first one in the order step 1 lists them is
 * used with its own model, and the choice is said in one line under the
 * splash, never asked. "Who decides" follows when it is still needed.
 * 'opened' when that step opened, 'used' when first run is done, undefined
 * when no provider is usable.
 */
async function useUsableProvider(deps: FirstRunDeps): Promise<'opened' | 'used' | undefined> {
  let usable: UsableProvider | undefined;
  try {
    usable = readUsableProvider(await gatherProviderFacts(deps.providerRegistry), { isSet: (name) => typeof process.env[name] === 'string' && process.env[name] !== '' });
  } catch (error) {
    logger.warn('[first-run] the providers could not be read; first run asks', { error: summarizeError(error) });
    return undefined;
  }
  if (!usable) return undefined;
  const model = await providerModel(deps.providerRegistry, usable.providerId);
  if (!model) return undefined;
  const using = `Using ${usable.name} (${model.displayName || model.id}) from ${usable.from}; change it with the model control.`;
  const effort = deps.configManager.get('provider.reasoningEffort');
  deps.completeModelSelection?.({ model, effort: typeof effort === 'string' ? effort : '', quiet: true });
  if (deps.pushSurfaceModal && await whoDecidesDue(deps)) {
    setFirstRunScreen({ kind: 'pending' });
    deps.pushSurfaceModal(new FirstRunModal(deps, undefined, model, using));
    return 'opened';
  }
  deps.markDone();
  setFirstRunScreen({ kind: 'set', model: model.displayName || model.id, signIn: 'signed in', using });
  deps.redrawConversation?.();
  deps.renderRequest();
  return 'used';
}

/**
 * Start first run when the session's model is not ready; otherwise record
 * nothing to show under the splash. Decides from what a request would
 * use, so it waits for the provider registry first: custom providers load in
 * the background, and the keys kept in the secret stores are applied by the
 * boot credential refresh (no request is made; the stores are read once, by
 * that refresh). Returns true when first run opened.
 */
export async function startFirstRun(deps: FirstRunDeps): Promise<boolean> {
  await Promise.allSettled([deps.providerRegistry.ready(), deps.providerRegistry.credentialsResolved()]);
  if (sessionModelReady(deps)) {
    // A first launch whose model is ready only as the product's default: the usable providers are
    // taken in the order step 1 lists them, and the choice is said in one line, as below.
    if (!deps.isMarkedDone() && !deps.configManager.isExplicitlySet('provider.model')) {
      const used = await useUsableProvider(deps);
      if (used !== undefined) return used === 'opened';
    }
    // A ready model with no decision model to ask, and "Who decides" never answered or put off: it opens alone,
    // once (on a first launch, and on a home that first ran before this step existed).
    if (deps.pushSurfaceModal && await whoDecidesDue(deps)) {
      setFirstRunScreen({ kind: 'pending' });
      pushWhoDecides(deps, deps.pushSurfaceModal);
      return true;
    }
    // A ready model on a first launch, and a decision model that can be asked: nothing to ask; recorded as done.
    if (!deps.isMarkedDone()) deps.markDone();
    setFirstRunScreen(undefined);
    return false;
  }
  // A provider the person chose (provider.model set by them) that is not signed in: step 2 for it.
  const readiness = resolveDefaultModelReadiness(deps.providerRegistry, String(deps.configManager.get('provider.model') ?? '').trim());
  const chosen = deps.configManager.isExplicitlySet('provider.model') && readiness.kind === 'needs-key'
    && FIRST_SCREEN_PROVIDERS.some((entry) => entry.providerId === readiness.provider)
    ? readiness.provider
    : undefined;
  // Otherwise a provider key in the environment, a stored key or a sign-in is a choice already made:
  // it is used with its own model and nothing is asked about it; the card shows only when none is usable.
  if (chosen === undefined) {
    const used = await useUsableProvider(deps);
    if (used !== undefined) return used === 'opened';
  }
  if (!deps.pushSurfaceModal) {
    setFirstRunScreen({ kind: 'not-ready' });
    return false;
  }
  setFirstRunScreen({ kind: 'pending' });
  const modal = new FirstRunModal(deps, chosen);
  deps.pushSurfaceModal(modal);
  if (localScanState() === 'off') deps.scanThisComputer?.();
  await modal.load();
  return true;
}
