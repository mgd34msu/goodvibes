import { describe, expect, test } from 'bun:test';
import { applyAtModelSwitches, type AtModelSwitchOptions } from '../../input/at-model-switch.ts';

type Registry = AtModelSwitchOptions['providerRegistry'];

function harness(overrides: { readonly setCurrentModel?: (id: string) => void; readonly set?: (key: string, value: string) => void } = {}) {
  const notes: string[] = [];
  const changed: string[] = [];
  const saved: Array<readonly [string, string]> = [];
  let current = 'sonnet';
  const registry = {
    setCurrentModel: (id: string) => {
      overrides.setCurrentModel?.(id);
      current = id;
    },
    getCurrentModel: () => ({ id: current, provider: 'anthropic', registryKey: `anthropic:${current}`, displayName: current.toUpperCase() }),
  } as unknown as Registry;
  const options: AtModelSwitchOptions = {
    providerRegistry: registry,
    configManager: { set: ((key: string, value: string) => { overrides.set?.(key, value); saved.push([key, value]); }) as never },
    onModelChanged: (model) => { changed.push(model.id); },
    notify: (message) => { notes.push(message); },
  };
  return { options, notes, changed, saved };
}

describe('@model: inline switch', () => {
  test('a switch that took and saved is reported as switched, with the token stripped', () => {
    const { options, notes, changed, saved } = harness();
    expect(applyAtModelSwitches('send this @model:opus and summarize', options)).toBe('send this  and summarize');
    expect(changed).toEqual(['opus']);
    expect(saved).toEqual([['provider.model', 'anthropic:opus']]);
    expect(notes).toEqual(['[Model] Switched to OPUS (anthropic) via @model:']);
  });

  test('an id that names no model is reported as unknown and nothing is saved', () => {
    const { options, notes, changed, saved } = harness({ setCurrentModel: () => { throw new Error('no such model'); } });
    applyAtModelSwitches('hello @model:nope', options);
    expect(notes).toEqual(['[Model] Unknown model: nope']);
    expect(changed).toEqual([]);
    expect(saved).toEqual([]);
  });

  test('a failed config write after the switch took is not reported as an unknown model', () => {
    const { options, notes, changed } = harness({ set: () => { throw new Error('setting is read-only'); } });
    expect(applyAtModelSwitches('go @model:opus', options)).toBe('go');
    expect(changed).toEqual(['opus']);
    expect(notes).toHaveLength(1);
    expect(notes[0]).not.toContain('Unknown model');
    expect(notes[0]).toContain('for this session');
    expect(notes[0]).toContain('setting is read-only');
  });
});
