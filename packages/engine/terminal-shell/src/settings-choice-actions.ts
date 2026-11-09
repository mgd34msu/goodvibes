import type { ConfigKey, ConfigManager, JudgmentFallbackSettings } from '@goodvibes-jev/engine/sdk/platform/config';
import { CONFIG_SCHEMA } from '@goodvibes-jev/engine/sdk/platform/config';
import { DECISION_MODEL_PROFILES, captureJudgmentBackendSettings, type DecisionModelProfile } from '@goodvibes-jev/judgment';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { OpenSelection, SelectionItem } from './selection-modal.js';

export type SettingsChoiceAction = 'judgment-provider' | 'judgment-model' | 'decision-policy' | 'permission-mode' | 'decision-router' | 'judgment-fallbacks';
export interface SettingsChoiceContext {
  readonly platform: { readonly configManager: Pick<ConfigManager, 'get' | 'setDynamic'> };
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
});
const PROVIDERS = [
  { id: 'system-one', label: 'System One', detail: 'TypeSafe Jev or a compatible hosted/local System One deployment.' },
  { id: 'cloudflare-workers-ai', label: 'Cloudflare Workers AI', detail: 'Clef and Clef-flash using your Cloudflare account and token reference.' },
  { id: 'laya', label: 'Laya', detail: 'A local Laya decision service using its declared protocol.' },
] as const;
const POLICY_DETAILS: Readonly<Record<string, string>> = {
  'Default - On': 'Use the configured decision models; halt and report availability problems if the whole chain fails.',
  Preferred: 'Try the configured decision chain, then continue in Classic only when all targets are unavailable.',
  'Classic - Off': 'Make no decision-model requests. Ordinary chat and tools remain available with the chosen execution permissions.',
  'safe-owner': 'Ordinary work runs automatically; dangerous actions require your approval.',
  'safe-jev': 'Use a decision model for approval judgments. Classic uses owner approval instead.',
  yolo: 'Run without general execution approval prompts. Authentication, workspace boundaries and spending rules still apply.',
  plan: 'Inspect and plan without executing changes.',
};

/** Shared terminal controls; selecting decision models never changes the chat model. */
export function openSettingsChoice(
  ctx: SettingsChoiceContext,
  action: Exclude<SettingsChoiceAction, 'decision-router'>,
  changed: () => void = ctx.renderRequest,
  setExecutionMode?: ((value: string) => void) | undefined,
): boolean {
  const open = ctx.openSelection;
  if (!open) return false;
  const config = ctx.platform.configManager;
  const watchedKeys: readonly ConfigKey[] = action === 'judgment-fallbacks' ? ['judgment.fallbacks']
    : action === 'decision-policy' ? ['judgment.policy'] : action === 'permission-mode' ? ['permissions.mode']
    : ['judgment.model', 'judgment.backend', 'judgment.endpoint', 'judgment.keySource', 'judgment.keyName'];
  const revision = () => JSON.stringify(watchedKeys.map(key => config.get(key)));
  const openedRevision = revision();
  const current = () => {
    if (revision() === openedRevision) return true;
    ctx.print('Settings changed while this picker was open. Reopen it before saving.');
    changed(); ctx.renderRequest(); return false;
  };
  let fallbackIndex: number | null = null;
  const fallbackChain = (): readonly JudgmentFallbackSettings[] => config.get('judgment.fallbacks');
  const editingFallback = () => action === 'judgment-fallbacks' && fallbackIndex !== null ? fallbackChain()[fallbackIndex] : undefined;
  const save = (patch: ReadonlyArray<readonly [ConfigKey, unknown]>) => {
    if (!current()) return;
    const previous = patch.map(([key]) => [key, config.get(key)] as const);
    const written: number[] = [];
    try {
      for (let index = 0; index < patch.length; index++) {
        const entry = patch[index];
        if (!entry) continue;
        config.setDynamic(entry[0], entry[1]); written.push(index);
      }
      changed(); ctx.renderRequest();
    } catch (error) {
      for (const index of written.reverse()) {
        const entry = previous[index];
        if (entry) { try { config.setDynamic(entry[0], entry[1]); } catch { /* Report the original persistence failure. */ } }
      }
      ctx.print('Unable to save settings: ' + summarizeError(error)); ctx.renderRequest();
    }
  };
  if (action === 'decision-policy' || action === 'permission-mode') {
    const key = action === 'decision-policy' ? 'judgment.policy' : 'permissions.mode';
    const values = CONFIG_SCHEMA.find(setting => setting.key === key)?.enumValues ?? [];
    open(action === 'decision-policy' ? 'Decision models' : 'Execution permissions',
      values.map(value => ({ id: value, label: value === 'yolo' ? 'YOLO' : value, detail: POLICY_DETAILS[value] ?? '', primaryAction: 'select' })),
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
        const url = new URL(text);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return false;
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
          ['judgment.keySource', 'none'], ['judgment.keyName', keyName || config.get('judgment.keyName') || 'TYPESAFE_API_KEY'],
          ['judgment.endpoint', endpoint], ['judgment.model', profile.model],
          ['judgment.backend', backend],
          ['judgment.keySource', keySource],
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
          open('Credential reference name — never the key value', [], {
            allowSearch: true, customItem: query => validName(query) ? { id: query, label: `Use reference: ${query}` } : null,
          }, reference => { if (reference) persist(source, reference.item.id); });
        });
      });
  };
  const chooseModel = (adapter?: string) => {
    const previousTarget = editingFallback();
    const profiles = DECISION_MODEL_PROFILES.filter(profile => !adapter || profile.adapter === adapter);
    const items: SelectionItem[] = profiles.map(profile => ({ id: profile.id, label: profile.name, detail: profile.model, category: PROVIDERS.find(provider => provider.id === profile.adapter)?.label ?? profile.adapter, primaryAction: 'select' }));
    open('Choose decision model', items, {
      allowSearch: true,
      preSelectId: profiles.find(profile => profile.model === (previousTarget?.model ?? config.get('judgment.model')))?.id,
      customItem: query => adapter !== 'cloudflare-workers-ai' && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/.test(query)
        ? { id: `custom:${query}`, label: `Custom model: ${query}`, detail: 'Use the current endpoint and protocol.', primaryAction: 'select' } : null,
    }, result => {
      if (!result) return;
      const profile = profiles.find(profile => profile.id === result.item.id);
      if (profile) chooseEndpoint(profile);
      else if (result.item.id.startsWith('custom:')) {
        const existing = captureJudgmentBackendSettings(previousTarget ? previousTarget.backend : config.get('judgment.backend'));
        const selectedAdapter = PROVIDERS.find(provider => provider.id === adapter)?.id ?? existing.adapter ?? 'system-one';
        chooseEndpoint({ id: 'custom', name: 'Custom model', model: result.item.id.slice(7), adapter: selectedAdapter,
          ...(selectedAdapter === 'laya' ? { responseModels: existing.responseModels ?? ['laya-rl-agent'] } : {}), documentation: '' });
      }
    });
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
  } else if (action === 'judgment-model') chooseModel();
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
