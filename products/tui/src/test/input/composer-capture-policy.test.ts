import { describe, expect, test } from 'bun:test';
import { applyAtModelDirective, applyComposerCapture } from '@/input/composer-capture.ts';

function registry() {
  const models: Record<string, { id: string; provider: string; registryKey: string; displayName: string }> = {
    old: { id: 'old', provider: 'p', registryKey: 'p:old', displayName: 'Old' },
    next: { id: 'next', provider: 'p', registryKey: 'p:next', displayName: 'Next' },
  };
  let current = models.old!;
  return {
    setCurrentModel(reference: string) {
      const found = models[reference] ?? Object.values(models).find((model) => model.registryKey === reference);
      if (!found) throw new Error('unknown');
      current = found;
    },
    getCurrentModel: () => current,
    selected: () => current.id,
  };
}

function modelHarness(persist: (key: string, value: unknown) => void = () => {}) {
  const providerRegistry = registry();
  const runtime = { model: 'old', provider: 'p' };
  const messages: string[] = [];
  const deps = { providerRegistry, runtime, configManager: { set: persist }, notify: (message: string) => { messages.push(message); } };
  return { deps, providerRegistry, runtime, messages };
}

describe('applyAtModelDirective', () => {
  test('a leading directive switches the model and is stripped', () => {
    const h = modelHarness();
    expect(applyAtModelDirective('@model:next explain this', h.deps)).toBe('explain this');
    expect(h.providerRegistry.selected()).toBe('next');
    expect(h.runtime.model).toBe('next');
  });

  test('a directive inside pasted text does not change the model', () => {
    const h = modelHarness();
    const input = 'the log said @model:next once';
    expect(applyAtModelDirective(input, h.deps)).toBe(input);
    expect(h.providerRegistry.selected()).toBe('old');
    expect(h.messages).toEqual([]);
  });

  test('a persistence failure is not reported as an unknown model and restores the previous model', () => {
    const h = modelHarness(() => { throw new Error('config is read-only'); });
    applyAtModelDirective('@model:next hi', h.deps);
    expect(h.providerRegistry.selected()).toBe('old');
    expect(h.runtime.model).toBe('old');
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]).not.toContain('Unknown model');
    expect(h.messages[0]).toContain('config is read-only');
    expect(h.messages[0]).toContain('kept Old');
  });

  test('an unknown id is reported as unknown', () => {
    const h = modelHarness();
    applyAtModelDirective('@model:nope hi', h.deps);
    expect(h.messages[0]).toContain('Unknown model: nope');
  });
});

describe('applyComposerCapture on multi-line text', () => {
  test('a pasted prompt that opens with a heading line is sent, not saved as a note', () => {
    const added: string[] = [];
    const deps = { sessionMemoryStore: { add: (text: string) => { added.push(text); return 'id'; } }, notify: () => {} };
    const input = '# Design brief\nbuild the thing';
    expect(applyComposerCapture(input, deps)).toEqual({ text: input, captured: false });
    expect(added).toEqual([]);
  });
});
