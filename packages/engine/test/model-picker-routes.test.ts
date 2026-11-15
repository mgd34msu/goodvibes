import { expect, test } from 'bun:test';
import type { ModelDefinition } from '@goodvibes-jev/engine/platform/platform/providers';
import { ModelPickerModal } from '@goodvibes-jev/engine/terminal-shell/model-picker';
import { createModelPickerTokenHandler } from '@goodvibes-jev/engine/terminal-shell/model-picker-token-route';
import { createLocalCommandActions } from '@goodvibes-jev/engine/terminal-shell/local-command-actions';
import { modelPickerCatalogServices } from '@goodvibes-jev/engine/terminal-shell/model-picker-targets';

const MODEL: ModelDefinition = {
  id: 'local', provider: 'ollama', registryKey: 'ollama:local', displayName: 'Local', description: '',
  capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
  contextWindow: 8192, selectable: true, tier: 'free',
};
const makePicker = () => new ModelPickerModal(
  { getRecentModels: () => [] } as never,
  { getBenchmarks: () => [] } as never,
  { getSyntheticModelInfoFromCatalog: () => [] } as never,
);
const key = (logicalName: string) => ({ type: 'key', logicalName }) as never;
const ctrl = (logicalName: string) => ({ type: 'key', logicalName, ctrl: true }) as never;

function harness(executeCommand?: (name: string, args: string[]) => Promise<boolean>) {
  const picker = makePicker();
  picker.openAllModels([MODEL], 'm1');
  const commits: Array<{ contextCap?: number | null | undefined }> = [];
  const handler = createModelPickerTokenHandler({
    chromeLines: 4, validateContextCap: false, extraControls: true, commitBeforeClose: true,
    commit: (_state, selection) => { commits.push({ contextCap: selection.contextCap }); },
  });
  const state = {
    modelPicker: picker, modalStack: ['modelPicker'], getViewportHeight: () => 24, requestRender: () => {}, handleEscape: () => picker.close(),
    commandContext: { provider: { providerRegistry: { getSelectableModels: () => [MODEL] } }, ...(executeCommand ? { executeCommand } : {}) },
  };
  return { picker, commits, press: (token: never) => handler(state as never, token), state };
}

test('a context cap outside 1 to 10,000,000 is refused with a message in every product, never dropped', () => {
  for (const digits of ['99999999', '0']) {
    const f = harness();
    f.picker.enterContextCapMode(MODEL);
    for (const digit of digits) f.picker.appendContextCapChar(digit);
    f.press(key('enter'));
    expect(f.commits).toEqual([]);
    expect(f.picker.contextCapError).toContain('1');
    expect(f.picker.mode).toBe('contextCap');
  }
  const ok = harness();
  ok.picker.enterContextCapMode(MODEL);
  for (const digit of '4096') ok.picker.appendContextCapChar(digit);
  ok.press(key('enter'));
  expect(ok.commits).toEqual([{ contextCap: 4096 }]);
});

test('rapid pin toggles run their commands in key order and the picker ends showing the stored state', async () => {
  const stored = new Set<string>();
  const order: string[] = [];
  const executeCommand = async (name: string, args: string[]) => {
    order.push(name);
    // The second command only sees the first one's result because they never overlap.
    await Promise.resolve();
    if (name === 'pin') stored.add(args[0]!);
    else if (!stored.delete(args[0]!)) throw new Error('Model is not pinned');
    return true;
  };
  const f = harness(executeCommand);
  f.press(ctrl('f'));
  f.press(ctrl('f'));
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  expect(order).toEqual(['pin', 'unpin']);
  expect(stored.has('ollama:local')).toBe(f.picker.isPinned(MODEL));
});

test('a pin command that fails puts the picker back to what is stored', async () => {
  const f = harness(async () => { throw new Error('offline'); });
  f.press(ctrl('f'));
  expect(f.picker.isPinned(MODEL)).toBe(true);
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  expect(f.picker.isPinned(MODEL)).toBe(false);
});

test('the real /pin command failing to store puts the picker back to unpinned', async () => {
  const printed: string[] = [];
  const providerApi = { getFavorites: async () => ({ pinned: [] }), pinModel: async () => { throw new Error('disk full'); } };
  const actions = createLocalCommandActions(() => providerApi as never, {
    hidden: false, liveDiscovery: false, unpinByModelId: false, imageHint: '', supportedFormats: '', maximumImageSize: '', partialRefresh: '',
    error: (detail) => detail, imageFailure: (kind, detail) => `${kind}: ${detail}`, invalidBlockType: () => '', noteTouch: () => {},
  });
  // Like the command registry: a handler that returns means the command ran.
  const executeCommand = async (_name: string, args: string[]) => {
    await actions.pin.handler(args, { print: (text: string) => printed.push(text) } as never);
    return true;
  };
  const f = harness(executeCommand);
  f.press(ctrl('f'));
  expect(f.picker.isPinned(MODEL)).toBe(true);
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  expect(printed).toEqual(['disk full']);
  expect(f.picker.isPinned(MODEL)).toBe(false);
});

test('stored pins that load after a local toggle do not overwrite the toggle', async () => {
  const picker = makePicker();
  let release!: (ids: string[]) => void;
  const services = modelPickerCatalogServices({
    picker: Object.assign(picker, { loadRecentModels: async () => {} }),
    getPinned: () => new Promise<string[]>(resolve => { release = resolve; }),
    refreshLiveModels: async () => [],
  });
  const loading = services.prefetch();
  picker.togglePinnedLocal(MODEL);
  release([]);
  await loading;
  expect(picker.isPinned(MODEL)).toBe(true);
  const later = services.prefetch();
  release(['other:model']);
  await later;
  expect([...picker.pinnedIds]).toEqual(['other:model']);
});
