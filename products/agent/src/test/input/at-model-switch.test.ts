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

describe('@model: switch at either end of composer text', () => {
  test('a trailing token that took is saved, reported and removed', () => {
    const { options, notes, changed, saved } = harness();
    expect(applyAtModelSwitches('summarize this @model:opus', options)).toBe('summarize this');
    expect(changed).toEqual(['opus']);
    expect(saved).toEqual([['provider.model', 'anthropic:opus']]);
    expect(notes).toEqual(['[Model] Switched to OPUS (anthropic) via @model:']);
  });

  test('a leading token switches too', () => {
    const { options, changed } = harness();
    expect(applyAtModelSwitches('@model:opus summarize this', options)).toBe('summarize this');
    expect(changed).toEqual(['opus']);
  });

  test('text that only contains @model: inside a word or mid-sentence is sent as written and changes nothing', () => {
    const { options, notes, changed, saved } = harness();
    for (const text of ['scp f user@model:/srv/data', 'rsync -a build/ deploy@model:/var/www', 'send this @model:opus and summarize']) {
      expect(applyAtModelSwitches(text, options)).toBe(text);
    }
    expect(changed).toEqual([]);
    expect(saved).toEqual([]);
    expect(notes).toEqual([]);
  });

  test('an id that names no model is reported, left in the text, and nothing is saved', () => {
    const { options, notes, changed, saved } = harness({ setCurrentModel: () => { throw new Error('no such model'); } });
    expect(applyAtModelSwitches('hello @model:nope', options)).toBe('hello @model:nope');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('Unknown model: nope');
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
