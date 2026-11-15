import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalCommandActions } from '../terminal-shell/src/local-command-actions.ts';
import { registerPaste } from '../terminal-shell/src/input-content.ts';
import { handleFilePickerToken, MAX_IMAGE_ATTACH_BYTES } from '../terminal-shell/src/modal-input-routes.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function project(files: Record<string, number>): string {
  const root = mkdtempSync(join(tmpdir(), 'image-limit-')); dirs.push(root);
  for (const [name, size] of Object.entries(files)) {
    writeFileSync(join(root, name), '');
    truncateSync(join(root, name), size);
  }
  return root;
}

function picker(root: string, selected: string) {
  const state = {
    filePicker: { active: true, query: 'pic', searchFocused: false, insertPos: 0, injectMode: false, close: () => {}, setQuery: () => {}, focusSearch: () => {}, blurSearch: () => {},
      getSelected: () => selected, selectedIndex: 0, moveUp: () => {}, moveDown: () => {} },
    prompt: '@pic', cursorPos: 4, commandContext: { workspace: { shellPaths: { workingDirectory: root } }, platform: { configManager: { getWorkingDirectory: () => root } } },
    imageRegistry: new Map<string, { data: string; mediaType: string }>(), nextImageId: 1, requestRender: () => {}, handleEscape: () => {}, saveUndoState: () => {},
    ensureInputCursorVisible: () => {}, formatFileSize: (bytes: number) => `${bytes}B`, mediaTypeFromExt: () => 'image/png', imageExtensions: ['.png'],
  };
  handleFilePickerToken(state as never, { type: 'key', logicalName: 'enter' } as never);
  return state;
}

test('the file picker refuses an oversize image and inserts its path as plain text', () => {
  const root = project({ 'huge.png': MAX_IMAGE_ATTACH_BYTES + 1 });
  const state = picker(root, 'huge.png');
  expect(state.imageRegistry.size).toBe(0);
  expect(state.prompt).toBe('huge.png ');
});

test('the file picker still attaches an image at the limit', () => {
  const root = project({ 'ok.png': 1024 });
  const state = picker(root, 'ok.png');
  expect(state.imageRegistry.size).toBe(1);
  expect(state.prompt).toContain('[IMAGE: img1, ok.png');
});

test('/image applies the same limit', async () => {
  const root = project({ 'huge.png': MAX_IMAGE_ATTACH_BYTES + 1 });
  const printed: string[] = [];
  const actions = createLocalCommandActions(() => { throw new Error('unused'); }, {
    hidden: false, liveDiscovery: false, unpinByModelId: false, imageHint: '', supportedFormats: '', maximumImageSize: 'Maximum is 20MB.', partialRefresh: '',
    error: (detail) => detail, imageFailure: (kind, detail) => `${kind}: ${detail}`, invalidBlockType: () => '', noteTouch: () => {},
  });
  await actions.image.handler(['huge.png'], { print: (text: string) => printed.push(text), workspace: { shellPaths: { workingDirectory: root } }, platform: { configManager: { getWorkingDirectory: () => root } } } as never);
  expect(printed.join('\n')).toContain('Image too large');
});

function pasteState() {
  return { pasteRegistry: new Map<string, string>(), nextPasteId: 1, imageRegistry: new Map<string, { data: string; mediaType: string }>(), nextImageId: 1 };
}

test('pasting the path of an oversize image keeps the path as text and registers no image', () => {
  const root = project({ 'huge.png': MAX_IMAGE_ATTACH_BYTES + 1 });
  const state = pasteState();
  const result = registerPaste(state as never, join(root, 'huge.png'), root);
  expect(state.imageRegistry.size).toBe(0);
  expect(result.marker).toBe(join(root, 'huge.png'));
});

test('pasting the path of an image within the limit attaches it', () => {
  const root = project({ 'ok.png': 1024 });
  const state = pasteState();
  const result = registerPaste(state as never, join(root, 'ok.png'), root);
  expect(state.imageRegistry.size).toBe(1);
  expect(result.marker).toContain('[IMAGE: img1, ok.png');
});
