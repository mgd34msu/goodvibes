import { describe, expect, test } from 'bun:test';
import type { Line } from '@goodvibes-jev/engine/platform/platform/types';
import { createBasicShellCommands, type BasicShellCommandContext } from '../terminal-shell/src/basic-shell-commands.ts';
import { FilePickerModal } from '../terminal-shell/src/file-picker.ts';
import { renderFilePickerOverlay } from '../terminal-shell/src/renderer/file-picker-overlay.ts';

const text = (lines: readonly Line[]): string => lines.map((line) => line.map((cell) => cell.char).join('')).join('\n');

describe('/reset with a hosted session', () => {
  test('lets go of the hosted session after the conversation is cleared', () => {
    const calls: string[] = [];
    const context: BasicShellCommandContext = {
      print: () => {},
      renderRequest: () => calls.push('render'),
      abandonHostedSession: () => calls.push('abandon'),
      session: {
        conversationManager: { resetAll: () => calls.push('reset'), rebuildHistory: () => calls.push('rebuild') },
        runtime: { systemPrompt: '' },
      },
    };
    createBasicShellCommands<BasicShellCommandContext>().reset.handler([], context);
    expect(calls.slice(0, 2)).toEqual(['reset', 'abandon']);
  });

  test('still resets when there is no hosted session to let go of', () => {
    let reset = 0;
    const context: BasicShellCommandContext = {
      print: () => {},
      renderRequest: () => {},
      session: {
        conversationManager: { resetAll: () => { reset++; }, rebuildHistory: () => {} },
        runtime: { systemPrompt: '' },
      },
    };
    createBasicShellCommands<BasicShellCommandContext>().reset.handler([], context);
    expect(reset).toBe(1);
  });
});

describe('file picker overlay and a partial walk', () => {
  function picker(truncated: boolean): FilePickerModal {
    const modal = new FilePickerModal({ workingDirectory: '/unused' });
    modal.active = true;
    modal.results = ['src/app.ts'];
    modal.truncated = truncated;
    return modal;
  }

  test('says the list is truncated when the walk hit its limit', () => {
    expect(text(renderFilePickerOverlay(picker(true), 80, 24))).toContain('1 file (list truncated)');
  });

  test('says nothing extra for a complete list', () => {
    expect(text(renderFilePickerOverlay(picker(false), 80, 24))).not.toContain('truncated');
  });

  test('an empty result from a partial walk does not claim there is no match', () => {
    const modal = picker(true);
    modal.results = [];
    modal.query = 'zzz';
    const out = text(renderFilePickerOverlay(modal, 100, 24));
    expect(out).toContain('(list truncated)');
    expect(out).toContain('more files exist than were listed');
  });
});
