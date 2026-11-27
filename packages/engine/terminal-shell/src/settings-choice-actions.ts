import type { ConfigChange, ConfigKey, ConfigManager, JudgmentFallbackSettings, SecretsManager } from '@goodvibes/engine/platform/platform/config';
import { CONFIG_SCHEMA, decisionModelSet, decisionModelSettings, localOwnerActor } from '@goodvibes/engine/platform/platform/config';
import { DECISION_MODEL_PROFILES, captureJudgmentBackendSettings, validEndpointURL, type DecisionModelProfile } from '@goodvibes/judgment';
import type { OpenSelection, SelectionItem } from './selection-modal.js';
import type { ModelPickerChoice } from './model-picker-types.js';
import { gatePresetLabel, presetForMode } from '@goodvibes/engine/platform/platform/gate/presets';
import { purchaseModeChoices } from '@goodvibes/engine/platform/platform/payments/browser';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';

export type SettingsChoiceAction = 'judgment-provider' | 'judgment-model' | 'decision-policy' | 'permission-mode' | 'decision-router' | 'judgment-fallbacks' | 'payments-mode';
export interface SettingsChoiceContext {
  readonly platform: {
    readonly configManager: Pick<ConfigManager, 'get' | 'setMany'>;
    /** Lists the stored credential names the reference picker offers. */
    readonly secretsManager?: Pick<SecretsManager, 'listDetailed'> | null | undefined;
  };
  readonly openSelection?: OpenSelection | undefined;
  readonly print: (message: string) => void;
  readonly renderRequest: () => void;
}
export const SETTINGS_CHOICE_ACTIONS: Readonly<Record<string, SettingsChoiceAction>> = Object.freeze({
  'judgment.backend': 'judgment-provider',
  'judgment.model': 'judgment-model',
  'judgment.fallbacks': 'judgment-fallbacks',
  'judgment.policy': 'decision-policy',
  'permissions.mode': 'permission-mode',
  'provider.decisionRouter': 'decision-router',
  // Turning payments on is choosing how purchases run (payments.confirmEveryPurchase) at the same time.
  'payments.enabled': 'payments-mode',
});
const PROVIDERS = [
  { id: 'system-one', label: 'System One', detail: 'TypeSafe Jev or a compatible hosted/local System One deployment.' },
  { id: 'cloudflare-workers-ai', label: 'Cloudflare Workers AI', detail: 'Clef and Clef-flash using your Cloudflare account and token reference.' },
  { id: 'laya', label: 'Laya', detail: 'A local Laya decision service using its declared protocol.' },
] as const;
const POLICY_DETAILS: Readonly<Record<string, string>> = {
  Hybrid: 'While the decision model fails, a call it would read or decide is decided as Ask me decides it, asking you where Ask me asks (in Just vibes it is held to the end of the run). The failure is shown once with the model, what failed and the next step.',
  'Decision Model Only': 'While the decision model fails, a call it would read or decide is refused with the reason, in every mode, and the turn goes on.',
  'ask-me': 'With a working decision model, ordinary work runs automatically and dangerous actions and owner-only decisions ask you; without one, every action asks you except a read inside the workspace and a change to files inside it that can be undone.',
  'jev-decides': 'A decision model decides every action the permission rules do not settle, critical ones included; owner-only decisions ask you. With no working decision model it behaves as Ask me.',
  'just-vibes': 'Does as much as it can without interrupting you; anything that needs you is held and listed at the end.',
  yolo: 'Run without general execution approval prompts. Authentication, workspace boundaries and spending rules still apply.',
  plan: 'Inspect and plan: every action that is not a read is refused.',
};

/** The entry that clears the primary decision model. */
const NO_DECISION_MODEL = {
  id: '__none__',
  label: 'No decision model',
  detail: 'Nothing is sent to a decision model, even with a decision model key or server address in this computer\'s environment; decisions take their fallbacks (Jev decides asks you as Ask me does, Just vibes holds what needs a decision). What is set up stays as it is; choosing a decision model here again uses it.',
} as const;

/** The entry that puts back the decision model an earlier version had set up while decision models were switched off (judgment.setAside). */
const SET_ASIDE_ID = '__set_aside__';

/** The settings `judgment.setAside` holds, as the writes that put them back (and empty it); null when nothing is set aside. */
function setAsideRestore(config: Pick<ConfigManager, 'get'>): { readonly label: string; readonly detail: string; readonly writes: ReadonlyArray<readonly [ConfigKey, unknown]> } | null {
  const held = config.get('judgment.setAside') as unknown as Readonly<Record<string, unknown>> | undefined;
  if (!held || typeof held !== 'object' || Object.keys(held).length === 0) return null;
  const fields = ['endpoint', 'model', 'keySource', 'keyName', 'backend', 'fallbacks'] as const;
  const writes: Array<readonly [ConfigKey, unknown]> = fields.filter((field) => held[field] !== undefined).map((field) => [`judgment.${field}` as ConfigKey, held[field]] as const);
  writes.push(['judgment.setAside', {}], ['judgment.noDecisionModel', false]);
  const model = typeof held['model'] === 'string' && held['model'] ? held['model'] : 'the default model';
  const endpoint = typeof held['endpoint'] === 'string' && held['endpoint'] ? held['endpoint'] : 'the hosted endpoint';
  return {
    label: 'Use the decision model you had before',
    detail: `${model} at ${endpoint}: what an earlier version had set up while decision models were switched off, kept aside since. Choosing it sets it again.`,
    writes,
  };
}

/** A decision model profile as one list entry: its name, its model id and the service it runs on. */
function decisionProfileEntry(profile: DecisionModelProfile): { readonly id: string; readonly label: string; readonly detail: string; readonly category: string } {
  return { id: profile.id, label: profile.name, detail: profile.model, category: PROVIDERS.find(provider => provider.id === profile.adapter)?.label ?? profile.adapter };
}

/**
 * The primary decision model's entries as the model picker lists them, the
 * clearing entry first, with the one in force marked: the same entries Settings
 * offers (openSettingsChoice 'judgment-model'), and choosing one goes through
 * that same choice (its `pick` start), so the judgment.* settings have one writer.
 */
export function decisionModelChoices(config: Pick<ConfigManager, 'get'>, env: Readonly<Record<string, string | undefined>> = process.env): readonly ModelPickerChoice[] {
  const set = decisionModelSet(decisionModelSettings(key => config.get(key)), env);
  const model = String(config.get('judgment.model') ?? '');
  const restore = setAsideRestore(config);
  return [
    ...(restore ? [{ id: SET_ASIDE_ID, label: restore.label, detail: restore.detail, current: false }] : []),
    { ...NO_DECISION_MODEL, current: !set },
    ...DECISION_MODEL_PROFILES.map(profile => {
      const entry = decisionProfileEntry(profile);
      return { id: entry.id, label: entry.label, detail: `${entry.detail} · ${entry.category}`, current: set && profile.model === model };
    }),
  ];
}

/** Shared terminal controls; selecting decision models never changes the chat model. */
export function openSettingsChoice(
  ctx: SettingsChoiceContext,
  action: Exclude<SettingsChoiceAction, 'decision-router'>,
  changed: () => void = ctx.renderRequest,
  setExecutionMode?: ((value: string) => void) | undefined,
  /** 'judgment-model' only: the entry already chosen (a decisionModelChoices id); the choice continues from it. */
  start?: { readonly pick: string } | undefined,
): boolean {
  const open = ctx.openSelection;
  if (!open) return false;
  const config = ctx.platform.configManager;
  const watchedKeys: readonly ConfigKey[] = action === 'judgment-fallbacks' ? ['judgment.fallbacks']
    : action === 'decision-policy' ? ['judgment.policy'] : action === 'permission-mode' ? ['permissions.mode']
    : action === 'payments-mode' ? ['payments.enabled', 'payments.confirmEveryPurchase']
    : ['judgment.model', 'judgment.backend', 'judgment.endpoint', 'judgment.keySource', 'judgment.keyName', 'judgment.setAside', 'judgment.noDecisionModel'];
  const revision = () => JSON.stringify(watchedKeys.map(key => config.get(key)));
  const openedRevision = revision();
  const current = () => {
    if (revision() === openedRevision) return true;
    ctx.print('Settings changed while this picker was open. Reopen it before saving.');
    changed(); ctx.renderRequest(); return false;
  };
  let fallbackIndex: number | null = null;
  // The names that exist, and why they could not be read when the secret store would not list them.
  const existingReferenceNames = async (source: 'env' | 'secret'): Promise<{ readonly names: readonly string[]; readonly error?: string }> => {
    if (source === 'env') {
      return { names: Object.keys(process.env).filter(name => process.env[name] && /(?:_API_KEY|_TOKEN|_KEY|_SECRET)$/.test(name)).sort() };
    }
    const secrets = ctx.platform.secretsManager;
    if (!secrets) return { names: [], error: 'this session has no secret store' };
    try {
      const records = await secrets.listDetailed();
      return { names: [...new Set(records.filter(record => record.source !== 'env').map(record => record.key))].sort() };
    } catch (error) {
      return { names: [], error: summarizeError(error) };
    }
  };
  const fallbackChain = (): readonly JudgmentFallbackSettings[] => config.get('judgment.fallbacks');
  const editingFallback = () => action === 'judgment-fallbacks' && fallbackIndex !== null ? fallbackChain()[fallbackIndex] : undefined;
  // One choice is one settings write: every key is checked first and written
  // together, or nothing is written and the refusal says why. Keys the daemon
  // owns go to it as one update it takes whole; its refusal is printed when it
  // answers, with the keys already back at their previous values.
  const save = (patch: ReadonlyArray<readonly [ConfigKey, unknown]>) => {
    if (!current()) return;
    const changes: ConfigChange[] = patch.map(([key, value]) => ({ key, value }));
    // The person's own choice on the screen: their press goes with the daemon's keys.
    const result = config.setMany(changes, localOwnerActor(), { press: { personAsked: true } });
    if (!result.ok) ctx.print(`Not saved: ${result.refusal.reason} ${result.refusal.next.join(' ')}`.trim());
    if (result.saved.length > 0) changed();
    ctx.renderRequest();
    if (!result.pending) return;
    void result.pending.settle().then((refused) => {
      // Applied by the daemon: a view showing what the daemon holds reads it again.
      if (refused.length === 0) { changed(); ctx.renderRequest(); return; }
      const byReason = new Map<string, string[]>();
      for (const refusal of refused) {
        const reason = summarizeError(refusal.error);
        byReason.set(reason, [...(byReason.get(reason) ?? []), refusal.key]);
      }
      for (const [reason, keys] of byReason) {
        ctx.print(`Not saved: the daemon refused ${keys.join(', ')} (${reason}); ${keys.length === 1 ? 'it is' : 'they are'} back at the previous value.`);
      }
      changed();
      ctx.renderRequest();
    });
  };
  if (action === 'payments-mode') {
    // Off, or on in one of the two ways. Turned off, the list opens on Off, so
    // turning payments on is always picking one of the two ways; nobody's
    // stored choice changes until a way is picked here.
    const enabled = config.get('payments.enabled') === true;
    const ask = config.get('payments.confirmEveryPurchase') === true;
    const modes = purchaseModeChoices(Number(config.get('payments.windows.vetoMinutes')));
    // Both ways and what each means stay in view whichever row is highlighted.
    const meanings = ['Off: nothing is bought.', ...modes.map((mode) => `${mode.label}: ${mode.detail}`)].join('\n');
    open('Purchases', [
      { id: 'off', label: 'Off', detail: meanings, primaryAction: 'select' },
      ...modes.map((mode) => ({ id: mode.id, label: mode.label, detail: meanings, primaryAction: 'select' as const })),
    ], { preSelectId: !enabled ? 'off' : ask ? 'ask' : 'veto', allowSearch: false }, (result) => {
      if (!result) return;
      const mode = modes.find((entry) => entry.id === result.item.id);
      if (!mode) { if (enabled) save([['payments.enabled', false]]); return; }
      save([['payments.confirmEveryPurchase', mode.confirmEveryPurchase], ['payments.enabled', true]]);
    });
    return true;
  }
  if (action === 'decision-policy' || action === 'permission-mode') {
    const key = action === 'decision-policy' ? 'judgment.policy' : 'permissions.mode';
    const setting = CONFIG_SCHEMA.find(entry => entry.key === key);
    const values = setting?.enumValues ?? [];
    open(action === 'decision-policy' ? 'When the decision model is missing or fails' : 'When GoodVibes asks',
      // The schema's word for each stored value; the default carries "(default)", which is never stored. A mode's row says what it does.
      values.map(value => ({ id: value, label: key === 'permissions.mode' ? gatePresetLabel(value)
        : `${setting?.enumLabels?.[value] ?? value}${value === setting?.default ? ' (default)' : ''}`,
      detail: key === 'permissions.mode' ? presetForMode(value).short : POLICY_DETAILS[value] ?? '', primaryAction: 'select' })),
      { preSelectId: String(config.get(key)), allowSearch: true },
      result => { if (!result) return;
        if (key === 'permissions.mode' && setExecutionMode) { if (current()) { setExecutionMode(result.item.id); changed(); } }
        else save([[key, result.item.id]]);
      });
    return true;
  }
  const chooseEndpoint = (profile: DecisionModelProfile) => {
    const previousTarget = editingFallback();
    const current = previousTarget?.endpoint ?? String(config.get('judgment.endpoint') ?? '');
    const hosted = profile.id === 'jev' ? 'https://api.typesafe.ai' : '';
    const valid = (text: string): boolean => {
      try {
        if (!validEndpointURL(text)) return false;
        const url = new URL(text);
        return profile.adapter !== 'cloudflare-workers-ai'
          || url.hostname === 'api.cloudflare.com' && url.pathname.endsWith(`/ai/run/@cf/cloudflare/${profile.model}`);
      } catch { return false; }
    };
    const urls = [...new Set([current, hosted].filter(value => value && valid(value)))];
    open('Decision endpoint — type or paste its URL',
      urls.map(url => ({ id: url, label: url, detail: url === hosted ? 'Hosted TypeSafe endpoint' : 'Configured endpoint', primaryAction: 'select' })),
      { allowSearch: true, preSelectId: current, customItem: query => valid(query) ? { id: query, label: `Use ${query}`, primaryAction: 'select' } : null },
      result => {
        if (!result) return;
        const endpoint = result.item.id;
        const persist = (keySource: JudgmentFallbackSettings['keySource'], keyName: string) => {
        const priorBackend = endpoint === current ? captureJudgmentBackendSettings(previousTarget ? previousTarget.backend : config.get('judgment.backend')) : {};
        const limits = { ...(priorBackend.maxInputBytes === undefined ? {} : { maxInputBytes: priorBackend.maxInputBytes }), ...(priorBackend.maxQuestions === undefined ? {} : { maxQuestions: priorBackend.maxQuestions }) };
        const backend = { ...limits, adapter: profile.adapter, ...(profile.responseModels ? { responseModels: profile.responseModels } : {}) };
        if (action === 'judgment-fallbacks') {
          const target: JudgmentFallbackSettings = {
            endpoint, model: profile.model, keySource: keySource as JudgmentFallbackSettings['keySource'], keyName: String(keyName),
            backend,
          };
          const chain = [...fallbackChain()];
          if (fallbackIndex === null) chain.push(target); else chain[fallbackIndex] = target;
          save([['judgment.fallbacks', chain]]);
          return;
        }
        save([
          ['judgment.keyName', keyName || config.get('judgment.keyName') || 'TYPESAFE_API_KEY'],
          ['judgment.endpoint', endpoint], ['judgment.model', profile.model],
          ['judgment.backend', backend],
          ['judgment.keySource', keySource],
          // Another decision model chosen: what was set aside is no longer offered.
          ...(setAsideRestore(config) ? [['judgment.setAside', {}] as const] : []),
          // A decision model chosen: no longer "no decision model".
          ...(config.get('judgment.noDecisionModel') === true ? [['judgment.noDecisionModel', false] as const] : []),
        ]);
        };
        const currentSource = previousTarget?.keySource ?? config.get('judgment.keySource');
        const currentName = previousTarget?.keyName ?? config.get('judgment.keyName');
        const officialKey = endpoint === 'https://api.typesafe.ai' ? 'TYPESAFE_API_KEY'
          : profile.adapter === 'cloudflare-workers-ai' ? 'CLOUDFLARE_API_TOKEN' : '';
        open('Decision credentials — references only', [
          { id: 'none', label: 'No authentication', detail: 'Use only for a service that does not require a credential.' },
          ...(endpoint === current && currentSource !== 'none' && currentName ? [{ id: 'current', label: `Keep ${currentSource} reference: ${currentName}` }] : []),
          ...(officialKey ? [{ id: 'official', label: `Environment: ${officialKey}` }] : []),
          { id: 'env', label: 'Choose environment variable' }, { id: 'secret', label: 'Choose secret-store entry' },
        ], { allowSearch: false }, credential => {
          if (!credential) return;
          const source = credential.item.id;
          if (source === 'none') { persist('none', ''); return; }
          if (source === 'current') { persist(currentSource, String(currentName)); return; }
          if (source === 'official') { persist('env', officialKey); return; }
          if (source !== 'env' && source !== 'secret') return;
          const validName = (name: string) => source === 'env' ? /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) : /^[A-Za-z0-9][A-Za-z0-9_./:-]{0,255}$/.test(name);
          // The names that exist, read once when the picker opens: set environment
          // variables named like a credential, or the keys in the secret store. A
          // name that resolves to nothing is saved only by choosing "use anyway".
          void existingReferenceNames(source).then(({ names, error }) => {
            const known = new Set(names);
            open(error === undefined ? 'Credential reference name — never the key value' : `Credential reference name (the stored names could not be read: ${error})`,
              names.map(name => ({ id: name, label: name, detail: source === 'env' ? 'Set in this environment' : 'Stored in the secret store', primaryAction: 'select' as const })), {
                allowSearch: true,
                customItem: query => !validName(query) || known.has(query) ? null : error !== undefined ? {
                  id: query, label: `Use ${query} (not checked)`,
                  detail: 'The secret store could not be listed, so this name was not checked.',
                } : {
                  id: query, label: `Use anyway: ${query}`,
                  detail: source === 'env' ? 'No environment variable of this name is set; decisions fail until it is.' : 'No stored secret of this name exists; decisions fail until it is stored.',
                },
              }, reference => { if (reference) persist(source, reference.item.id); });
          });
        });
      });
  };
  const chooseModel = (adapter?: string, picked?: string) => {
    const previousTarget = editingFallback();
    const profiles = DECISION_MODEL_PROFILES.filter(profile => !adapter || profile.adapter === adapter);
    const chosen = (id: string): void => {
      if (id === SET_ASIDE_ID) {
        const restore = setAsideRestore(config);
        if (restore) save(restore.writes);
        return;
      }
      if (id === NO_DECISION_MODEL.id) {
        // The choice itself, stored: it wins over the decision model settings and the environment (decision-model-set.ts).
        save([['judgment.noDecisionModel', true]]);
        return;
      }
      const profile = profiles.find(profile => profile.id === id);
      if (profile) chooseEndpoint(profile);
      else if (id.startsWith('custom:')) {
        const existing = captureJudgmentBackendSettings(previousTarget ? previousTarget.backend : config.get('judgment.backend'));
        const selectedAdapter = PROVIDERS.find(provider => provider.id === adapter)?.id ?? existing.adapter ?? 'system-one';
        chooseEndpoint({ id: 'custom', name: 'Custom model', model: id.slice(7), adapter: selectedAdapter,
          ...(selectedAdapter === 'laya' ? { responseModels: existing.responseModels ?? ['laya-rl-agent'] } : {}), documentation: '' });
      }
    };
    if (picked !== undefined) { chosen(picked); return; }
    const items: SelectionItem[] = profiles.map(profile => ({ ...decisionProfileEntry(profile), primaryAction: 'select' }));
    // The primary model can be cleared as well as chosen; a fallback target is removed from its own menu.
    if (action !== 'judgment-fallbacks' && !adapter) items.unshift({ ...NO_DECISION_MODEL, primaryAction: 'select' });
    // A decision model an earlier version set aside is offered back first.
    const restore = action !== 'judgment-fallbacks' && !adapter ? setAsideRestore(config) : null;
    if (restore) items.unshift({ id: SET_ASIDE_ID, label: restore.label, detail: restore.detail, primaryAction: 'select' });
    open('Choose decision model', items, {
      allowSearch: true,
      preSelectId: profiles.find(profile => profile.model === (previousTarget?.model ?? config.get('judgment.model')))?.id,
      customItem: query => adapter !== 'cloudflare-workers-ai' && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/.test(query)
        ? { id: `custom:${query}`, label: `Custom model: ${query}`, detail: 'Use the current endpoint and protocol.', primaryAction: 'select' } : null,
    }, result => { if (result) chosen(result.item.id); });
  };
  if (action === 'judgment-fallbacks') {
    open('Decision fallback order', [
      ...fallbackChain().map((target, index) => ({ id: String(index), label: `${index + 1}. ${target.model}`, detail: target.endpoint, primaryAction: 'select' as const })),
      { id: 'add', label: 'Add fallback', detail: 'Choose another model and endpoint to try when an earlier target is unavailable.', primaryAction: 'select' },
    ], { allowSearch: false }, result => {
      if (!result) return;
      if (result.item.id === 'add') { fallbackIndex = null; chooseModel(); return; }
      const index = Number(result.item.id);
      open('Edit fallback', [
        { id: 'edit', label: 'Change model / endpoint' }, { id: 'up', label: 'Move earlier' },
        { id: 'down', label: 'Move later' }, { id: 'remove', label: 'Remove fallback' },
      ], { allowSearch: false }, operation => {
        if (!operation) return;
        const chain = [...fallbackChain()];
        if (!chain[index]) return;
        if (operation.item.id === 'edit') { fallbackIndex = index; chooseModel(); return; }
        if (operation.item.id === 'remove') chain.splice(index, 1);
        else {
          const destination = index + (operation.item.id === 'up' ? -1 : 1);
          const target = chain[index], other = chain[destination];
          if (!target || !other) return;
          chain[index] = other; chain[destination] = target;
        }
        save([['judgment.fallbacks', chain]]);
      });
    });
  } else if (action === 'judgment-model') chooseModel(undefined, start?.pick);
  else open('Choose decision provider', [
    ...PROVIDERS.map(provider => ({ ...provider, primaryAction: 'select' as const })),
    { id: '__advanced__', label: 'Advanced provider limits / aliases', detail: 'Edit the complete provider capability object as validated JSON.' },
  ], { allowSearch: true }, result => {
    if (!result) return;
    if (result.item.id !== '__advanced__') { chooseModel(result.item.id); return; }
    const current = JSON.stringify(config.get('judgment.backend'));
    open('Advanced decision provider — JSON', [{ id: current, label: current }], {
      allowSearch: true, customItem: query => {
        try { captureJudgmentBackendSettings(JSON.parse(query)); return { id: query, label: 'Use provider configuration', detail: query }; }
        catch { return null; }
      },
    }, selected => { if (selected) save([['judgment.backend', captureJudgmentBackendSettings(JSON.parse(selected.item.id))]]); });
  });
  return true;
}
