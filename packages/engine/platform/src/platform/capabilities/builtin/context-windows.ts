/**
 * The context window size of a model: what it is, a size you set for it, and
 * going back to the automatic size. The daemon keeps these in one file
 * (`context-window-overrides.json` under its state root, `~/.goodvibes/tui/`),
 * the one every program's turns read: a change here is announced
 * (LIST_CHANGED `context-windows`) and each running program reads the file
 * again on that notice, so its next turn works from the new size with no
 * restart (terminal-shell `context-windows-follow.ts`). The programs never
 * write the file themselves (providers/registry.ts `contextWindows.writes`).
 *
 * The model is the asking program's conversation's model (`caller.model`,
 * sent by its capability binding) unless one is named; a caller with neither
 * (the web UI, a script) acts on the daemon's own default model.
 */
import { noteListChanged } from '../../runtime/list-changes.js';
import { MAX_CONTEXT_WINDOW_OVERRIDE } from '../../providers/context-window-overrides.js';
import { describeContextWindowSource } from '../../providers/context-window-catalog.js';
import { findModelDefinition } from '../../providers/registry-models.js';
import type { ModelDefinition } from '../../providers/registry-types.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import { CapabilityRefusal, type CapabilityCaller, type CapabilityDefinition, type InputDescription } from '../types.js';

/** What the context window capabilities read: the daemon's provider registry. */
export interface ContextWindowsCapabilityServices {
  readonly models: {
    readonly providerRegistry: Pick<ProviderRegistry, 'getCurrentModel' | 'listModels' | 'getKnownContextWindowForModel'
      | 'getModelContextCap' | 'getObservedContextWindow' | 'setModelContextCap' | 'clearModelContextCap'>;
  };
}

/**
 * A size as a person writes it: a token count (`120000`), thousands (`200k`, `12.5k`) or millions (`1m`). Null for
 * anything else or outside 1 to the largest window a model can be given.
 */
export function parseContextWindowSize(raw: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(raw.trim().replace(/[,_]/g, ''));
  if (!match) return null;
  const suffix = match[2]?.toLowerCase();
  const value = Math.round(Number(match[1]) * (suffix === 'm' ? 1_000_000 : suffix === 'k' ? 1_000 : 1));
  if (!Number.isInteger(value) || value <= 0 || value > MAX_CONTEXT_WINDOW_OVERRIDE) return null;
  return value;
}

const MODEL: InputDescription = {
  id: 'model', label: 'Model', help: 'The model, as provider:model; empty: the model this conversation uses',
  kind: 'text', freeTextReason: 'a model as provider:model',
  required: { default: '', defaultMeans: 'the model this conversation uses' }, typed: { flag: '--model' },
};

type Registry = ContextWindowsCapabilityServices['models']['providerRegistry'];

/** The model a call acts on: the one named, else the asking conversation's, else the daemon's default. */
function modelOf(registry: Registry, named: string | undefined, caller: CapabilityCaller): { readonly key: string; readonly definition: ModelDefinition | undefined } {
  const key = (named ?? '').trim() || caller.model?.trim() || '';
  if (!key) {
    const current = registry.getCurrentModel();
    return { key: current.registryKey, definition: current };
  }
  return { key, definition: findModelDefinition(key, registry.listModels()) };
}

const tokens = (count: number): string => `${count.toLocaleString('en-US')} tokens`;

function nameOf(key: string, definition: ModelDefinition | undefined): string {
  return definition && definition.displayName !== key ? `${definition.displayName} (${key})` : key;
}

/** Announce the change: every running program reads the file again before its next turn. */
function changed(key: string): void {
  noteListChanged({ list: 'context-windows', change: 'changed', id: key });
}

export const CONTEXT_WINDOW: CapabilityDefinition<ContextWindowsCapabilityServices> = {
  capability: { id: 'context.window', group: 'conversation', home: 'daemon', repeat: 'safe' },
  actionId: 'see-window', label: 'See the context window size', word: 'window', inputs: [MODEL],
  sentence: 'Shows how large the model\'s context window is (how much of the conversation it can take in): what its maker says, any size you set and any limit learned from the provider.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(values, services, caller) {
    const registry = services.models.providerRegistry;
    const { key, definition } = modelOf(registry, values.model, caller);
    if (!definition) throw new CapabilityRefusal(`No model named ${key} is known here, so its window cannot be read.`, 'Name a model as provider:model, as the model list shows it');
    const known = registry.getKnownContextWindowForModel(definition);
    const set = registry.getModelContextCap(key);
    const learned = registry.getObservedContextWindow(key);
    const resolved = known === null
      ? definition.contextWindowProvenance === 'accepted_floor'
        ? `unknown (the provider accepted ${tokens(definition.contextWindow)}, more than the stated window)`
        : definition.contextWindowOrigin?.kind === 'family_default'
          ? `unknown (no catalog lists this model; ${tokens(definition.contextWindow)} is a guess from its family)`
          : 'unknown (no catalog or provider states it)'
      : tokens(known);
    const source = known === null && definition.contextWindowProvenance === 'accepted_floor' ? null : describeContextWindowSource(definition);
    return {
      text: [
        `Context window for ${nameOf(key, definition)}:`,
        `  size: ${resolved}`,
        ...(source === null ? [] : [`  from: ${source}`]),
        `  size you set: ${set === null ? 'none (automatic)' : tokens(set)}`,
        ...(learned === null ? [] : [`  learned limit: ${tokens(learned)} (the provider refused a longer request; it rises again as longer requests succeed)`]),
      ].join('\n'),
      data: { model: key, window: known, set, learned },
    };
  },
};

export const CONTEXT_SET_WINDOW: CapabilityDefinition<ContextWindowsCapabilityServices> = {
  capability: { id: 'context.set-window', group: 'conversation', home: 'daemon', repeat: 'safe' },
  actionId: 'set-window', label: 'Set the context window size', word: 'set-window',
  inputs: [
    { id: 'size', label: 'Size', help: 'Tokens, such as 120000, 200k or 1m', kind: 'text', freeTextReason: 'a token count', required: true, typed: { position: 1 } },
    MODEL,
  ],
  sentence: 'The model\'s context window (how much of the conversation it takes in) will be taken as {size} tokens in every program, from its next turn, until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'clear-window', example: { size: '200k' },
  async run(values, services, caller) {
    const registry = services.models.providerRegistry;
    const size = parseContextWindowSize(values.size ?? '');
    if (size === null) throw new CapabilityRefusal(`"${values.size ?? ''}" is not a size: nothing was changed.`, `Give a token count from 1 to ${MAX_CONTEXT_WINDOW_OVERRIDE.toLocaleString('en-US')}, such as 120000, 200k or 1m`);
    const { key, definition } = modelOf(registry, values.model, caller);
    const was = definition ? registry.getKnownContextWindowForModel(definition) : null;
    let notSaved: string | undefined;
    registry.setModelContextCap(key, size, (reason) => { notSaved = reason; });
    if (notSaved !== undefined) throw new CapabilityRefusal(`The size for ${nameOf(key, definition)} could not be saved (${notSaved}), so no program uses it.`);
    changed(key);
    return {
      text: `The context window for ${nameOf(key, definition)} is now ${tokens(size)} (it was ${was === null ? 'unknown' : tokens(was)}), in every program from its next turn.`,
      data: { model: key, set: size },
    };
  },
};

export const CONTEXT_CLEAR_WINDOW: CapabilityDefinition<ContextWindowsCapabilityServices> = {
  capability: { id: 'context.clear-window', group: 'conversation', home: 'daemon', repeat: 'safe' },
  actionId: 'clear-window', label: 'Go back to the automatic window size', word: 'clear-window', inputs: [MODEL],
  sentence: 'The context window size you set and any limit learned for the model are cleared, and its own window size applies in every program until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'set-window', example: {},
  async run(values, services, caller) {
    const registry = services.models.providerRegistry;
    const { key, definition } = modelOf(registry, values.model, caller);
    const existed = registry.clearModelContextCap(key);
    const known = definition ? registry.getKnownContextWindowForModel(definition) : null;
    const automatic = known === null ? 'unknown' : tokens(known);
    if (!existed) return { text: `${nameOf(key, definition)} had no size set and no learned limit; its window is automatic (${automatic}).`, data: { model: key, cleared: false } };
    changed(key);
    return { text: `The size set and any learned limit for ${nameOf(key, definition)} are cleared; its window is automatic again (${automatic}), in every program from its next turn.`, data: { model: key, cleared: true } };
  },
};

/** The context window capabilities, in the order This conversation lists them. */
export const CONTEXT_WINDOW_CAPABILITIES = [CONTEXT_WINDOW, CONTEXT_SET_WINDOW, CONTEXT_CLEAR_WINDOW] as const;
