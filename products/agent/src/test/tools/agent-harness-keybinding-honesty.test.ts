import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { KeybindingsManager } from '../../input/keybindings.ts';
import { resetHarnessKeybinding, runHarnessKeybinding, setHarnessKeybinding } from '../../tools/agent-harness-keybinding-metadata.ts';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner } from '../helpers/research-screening.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

let previousPort: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previousPort = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previousPort); });
afterAll(cleanupResearchScreeningFixtures);

async function withKeybindings<T>(fn: (fixture: { readonly configPath: string; readonly manager: KeybindingsManager; readonly context: Parameters<typeof setHarnessKeybinding>[0] }) => Promise<T>): Promise<T> {
  const root = makeProjectTempDir('gv-keybinding-honesty');
  const configPath = join(root, 'agent', 'keybindings.json');
  mkdirSync(dirname(configPath), { recursive: true });
  const manager = new KeybindingsManager({ configPath });
  try { return await fn({ configPath, manager, context: { workspace: { keybindingsManager: manager } } }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

describe('set_keybinding reports what actually landed', () => {
  test('a key name the shell cannot match is refused and nothing is written', async () => {
    await withKeybindings(async ({ configPath, context }) => {
      await expect(setHarnessKeybinding(context, { actionId: 'search', value: 'Ctrl+Enterr' })).rejects.toThrow('not a key the shell can match');
      await expect(setHarnessKeybinding(context, { actionId: 'search', value: 'Ctrl++' })).rejects.toThrow('modifier');
      expect(existsSync(configPath)).toBe(false);
    });
  });

  test('an upper-case key is stored as the lower-case name the shell matches', async () => {
    await withKeybindings(async ({ configPath, manager, context }) => {
      const result = await setHarnessKeybinding(context, { actionId: 'search', combo: { key: 'G', ctrl: true } });
      expect(result.status).toBe('updated');
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual({ search: { key: 'g', ctrl: true } });
      expect(manager.lookup({ logicalName: 'g', ctrl: true } as never)).toBe('search');
    });
  });

  test('a chord another action already holds is reported with the action that takes it', async () => {
    await withKeybindings(async ({ context }) => {
      const result = await setHarnessKeybinding(context, { actionId: 'undo', combo: { key: 'c', ctrl: true } });
      expect(result.status).toBe('updated');
      expect(result.conflicts).toEqual([expect.objectContaining({ action: 'clear-cancel', takesTheChord: 'undo' })]);
      // The loader's own notice names the shared chord; the tool does not say the same thing a second time.
      const warnings = result.warnings as string[];
      expect(warnings.join(' ')).toContain('only undo responds to it');
      expect(warnings.filter(warning => warning.includes('Ctrl+C'))).toHaveLength(1);
      expect(warnings.join(' ')).not.toContain('only one binding takes it');
    });
  });

  test('a chord used by a fixed shortcut is reported', async () => {
    await withKeybindings(async ({ context }) => {
      const result = await setHarnessKeybinding(context, { actionId: 'search', combo: { key: 'f2' } });
      expect(result.conflicts).toEqual([expect.objectContaining({ fixedShortcut: 'Open runtime activity monitor' })]);
      expect((result.warnings as string[]).join(' ')).toContain('only one binding takes it');
    });
  });

  test('a legacy alias entry that overrides the canonical one makes reset report not_applied', async () => {
    await withKeybindings(async ({ configPath, manager, context }) => {
      writeFileSync(configPath, JSON.stringify({ 'workspace-picker': { key: 'g', ctrl: true }, 'panel-picker': { key: 'h', ctrl: true } }));
      manager.loadFromDisk();
      const result = await resetHarnessKeybinding(context, { actionId: 'workspace-picker' });
      expect(result.status).toBe('not_applied');
      expect(String(result.reason)).toContain('panel-picker');
    });
  });

  test('a set that the live manager does not hold is not reported as updated', async () => {
    await withKeybindings(async ({ manager, context }) => {
      manager.loadFromDisk = () => [];
      const result = await setHarnessKeybinding(context, { actionId: 'search', combo: { key: 'g', ctrl: true } });
      expect(result.status).toBe('not_applied');
    });
  });
});

describe('a corrupt keybindings file is never silently replaced', () => {
  test('the result says the earlier bindings were moved aside, and each quarantine keeps its own copy', async () => {
    await withKeybindings(async ({ configPath, context }) => {
      writeFileSync(configPath, '{"search": {"key": "g", "ctrl": tru');
      const first = await setHarnessKeybinding(context, { actionId: 'search', combo: { key: 'j', ctrl: true } });
      expect(String((first.warnings as string[])[0])).toContain('keybindings.json.corrupt');
      expect(readFileSync(`${configPath}.corrupt`, 'utf-8')).toBe('{"search": {"key": "g", "ctrl": tru');

      writeFileSync(configPath, '{"search": [');
      const second = await setHarnessKeybinding(context, { actionId: 'search', combo: { key: 'k', ctrl: true } });
      expect(String((second.warnings as string[])[0])).toContain('keybindings.json.corrupt.1');
      expect(readFileSync(`${configPath}.corrupt`, 'utf-8')).toBe('{"search": {"key": "g", "ctrl": tru');
      expect(readFileSync(`${configPath}.corrupt.1`, 'utf-8')).toBe('{"search": [');
    });
  });
});

describe('a full set of quarantine slots', () => {
  test('refuses the write and overwrites no earlier quarantine', async () => {
    await withKeybindings(async ({ configPath, context }) => {
      const slots = [`${configPath}.corrupt`, ...[1, 2, 3, 4].map(index => `${configPath}.corrupt.${index}`)];
      slots.forEach((slot, index) => writeFileSync(slot, `earlier ${index}`));
      writeFileSync(configPath, '{"search": [');
      const blocked = 'keybindings.json is not valid JSON and could not be moved aside (it was left unchanged, and the five earlier .corrupt copies may all be taken), so no binding was written. Repair or move it, then retry.';
      await expect(setHarnessKeybinding(context, { actionId: 'search', combo: { key: 'j', ctrl: true } })).rejects.toThrow(`set_keybinding was not applied: ${blocked}`);
      await expect(resetHarnessKeybinding(context, { actionId: 'search' })).rejects.toThrow(`reset_keybinding was not applied: ${blocked}`);
      slots.forEach((slot, index) => expect(readFileSync(slot, 'utf-8')).toBe(`earlier ${index}`));
      expect(readFileSync(configPath, 'utf-8')).toBe('{"search": [');
    });
  });
});

describe('a write is not failed by the guards that ran before it', () => {
  test('modifier guards retained while reading a word modifier still pass after the file was written', async () => {
    await withKeybindings(async ({ configPath, context }) => {
      installJudgmentPort(fakePort((_name, question) => {
        if (question.type !== 'choice') throw new Error('Unexpected modifier reading');
        return choiceAnswer(question, Object.hasOwn(question.criteria, 'neither') ? 'true' : 'other', 0.999);
      }).port);
      const retained: (() => void)[] = [];
      const result = await setHarnessKeybinding(context, { actionId: 'search', combo: { key: 'g', ctrl: 'yes' } },
        { sourceOwner: ordinaryResearchOwner(), retainCurrent: (guard: () => void) => { retained.push(guard); } });
      expect(result.status).toBe('updated');
      expect(readFileSync(configPath, 'utf-8')).toContain('"search"');
      expect(retained.length).toBeGreaterThan(0);
      for (const guard of retained) expect(guard).not.toThrow();
    });
  });
});

describe('run_keybinding does not report a no-op as executed', () => {
  test('cancelling with no generation running, and closing with no workspace open, say so', async () => {
    await withKeybindings(async ({ context }) => {
      let cancelled = 0, focused = 0;
      const base = { ...context, renderRequest: () => {}, cancelGeneration: () => { cancelled++; }, isGenerating: () => false,
        dismissAgentWorkspace: () => false, focusPrompt: () => { focused++; } };
      const cancel = await runHarnessKeybinding(base as never, { actionId: 'clear-cancel' });
      expect(cancel.status).toBe('nothing_to_cancel');
      expect(cancelled).toBe(0);
      const close = await runHarnessKeybinding(base as never, { actionId: 'workspace-close' });
      expect(close.status).toBe('nothing_to_dismiss');
      expect(focused).toBe(0);
    });
  });

  test('a paste that found nothing on the clipboard is not_pasted', async () => {
    await withKeybindings(async ({ context }) => {
      const result = await runHarnessKeybinding({ ...context, renderRequest: () => {}, pasteFromClipboard: () => ({ pasted: false, kind: 'none' as const }) } as never, { actionId: 'paste' });
      expect(result.status).toBe('not_pasted');
    });
  });

  test('block-save is unsupported and names the disabled save', async () => {
    await withKeybindings(async ({ context }) => {
      const result = await runHarnessKeybinding({ ...context, renderRequest: () => {} } as never, { actionId: 'block-save' });
      expect(result.status).toBe('unsupported_keybinding_action');
      expect(String(result.reason)).toContain('disabled');
    });
  });
});
