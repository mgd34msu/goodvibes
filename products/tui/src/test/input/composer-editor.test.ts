import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolveEditorCommand, openComposerInEditor, makeComposerEditorOpener, makeFileEditorOpener, type EditorSpawn } from '@/input/composer-editor.ts';
import { createTerminalLifecycle } from '@goodvibes-jev/engine/terminal-shell';

describe('external-editor keyboard mode ownership', () => {
  for (const kind of ['composer', 'file'] as const) {
    test(`${kind} editor balances keyboard modes and respects no-alt-screen`, () => {
      const writes: string[] = [];
      const terminal = createTerminalLifecycle({ noAltScreen: true, write: (s) => { writes.push(s); } });
      const raw: boolean[] = [];
      let repaints = 0;
      terminal.enterTerminal();
      const deps = {
        buffer: { prompt: 'ABC', cursorPos: 3 },
        terminal,
        stdin: { setRawMode: (on: boolean) => { raw.push(on); } },
        repaint: () => { repaints++; },
        cwd: '/tmp', env: { EDITOR: 'fake' }, notify: () => {},
        spawn: () => {
          expect(writes).toHaveLength(2);
          expect(writes[1]).toContain('\x1b[<u');
          return { status: 0 };
        },
      };
      if (kind === 'composer') makeComposerEditorOpener(deps)();
      else makeFileEditorOpener(deps)('/tmp/example');
      expect(writes).toHaveLength(3);
      expect(writes[2]).toContain('\x1b[>1u');
      terminal.restoreTerminal();
      expect(writes).toHaveLength(4);
      expect(writes[3]).toContain('\x1b[<u');
      expect(writes.join('')).not.toContain('\x1b[?1049');
      expect(raw).toEqual([false, true]);
      expect(repaints).toBe(1);
    });

    test(`${kind} editor cannot reenter raw mode after shutdown while suspended`, () => {
      const writes: string[] = [];
      const terminal = createTerminalLifecycle({ noAltScreen: false, write: (s) => { writes.push(s); } });
      const raw: boolean[] = [];
      terminal.enterTerminal();
      const deps = {
        buffer: { prompt: '', cursorPos: 0 },
        terminal,
        stdin: { setRawMode: (on: boolean) => { raw.push(on); } },
        repaint: () => { throw new Error('must not repaint after shutdown'); },
        cwd: '/tmp', env: { EDITOR: 'fake' }, notify: () => {},
        spawn: () => { terminal.restoreTerminal(); return { status: 0 }; },
      };
      if (kind === 'composer') makeComposerEditorOpener(deps)();
      else makeFileEditorOpener(deps)('/tmp/example');
      expect(writes).toHaveLength(2);
      expect(raw).toEqual([false]);
    });
  }
});

describe('resolveEditorCommand', () => {
  test('prefers $VISUAL over $EDITOR', () => {
    expect(resolveEditorCommand({ VISUAL: 'code -w', EDITOR: 'vi' })).toEqual({ cmd: 'code', args: ['-w'] });
  });
  test('falls back to $EDITOR', () => {
    expect(resolveEditorCommand({ EDITOR: 'nano' })).toEqual({ cmd: 'nano', args: [] });
  });
  test('returns null when neither is set', () => {
    expect(resolveEditorCommand({})).toBeNull();
    expect(resolveEditorCommand({ EDITOR: '   ' })).toBeNull();
  });
});

function harness(overrides: Partial<{ initial: string; env: NodeJS.ProcessEnv; spawn: EditorSpawn }> = {}) {
  const events: string[] = [];
  let draft = overrides.initial ?? 'initial draft';
  const messages: string[] = [];
  openComposerInEditor({
    readDraft: () => draft,
    writeDraft: (t) => { draft = t; },
    cwd: '/tmp',
    env: overrides.env ?? { EDITOR: 'fake' },
    suspend: () => events.push('suspend'),
    resume: () => events.push('resume'),
    notify: (m) => messages.push(m),
    spawn: overrides.spawn,
  });
  return { getDraft: () => draft, events, messages };
}

describe('openComposerInEditor', () => {
  test('round-trips the edited file back into the draft', () => {
    const spawn: EditorSpawn = (_cmd, args) => {
      const file = args[args.length - 1]!;
      writeFileSync(file, readFileSync(file, 'utf8') + ' + edited\n', 'utf8');
      return { status: 0 };
    };
    const h = harness({ initial: 'hello', spawn });
    expect(h.getDraft()).toBe('hello + edited'); // trailing newline stripped
    expect(h.events).toEqual(['suspend', 'resume']); // suspended around the launch
    expect(h.messages.some((m) => m.includes('updated'))).toBe(true);
  });

  test('does nothing when no editor is configured', () => {
    let spawned = false;
    const h = harness({ env: {}, spawn: () => { spawned = true; return { status: 0 }; } });
    expect(spawned).toBe(false);
    expect(h.getDraft()).toBe('initial draft');
    expect(h.messages[0]).toContain('$EDITOR');
  });

  test('leaves the draft unchanged on a non-zero editor exit', () => {
    const h = harness({ initial: 'keep me', spawn: () => ({ status: 1 }) });
    expect(h.getDraft()).toBe('keep me');
    expect(h.events).toEqual(['suspend', 'resume']);
    expect(h.messages.some((m) => m.includes('exited with code 1'))).toBe(true);
  });

  test('reports a spawn error and resumes the terminal', () => {
    const h = harness({ spawn: () => ({ status: null, error: new Error('ENOENT') }) });
    expect(h.events).toEqual(['suspend', 'resume']);
    expect(h.messages.some((m) => m.includes('Failed to launch'))).toBe(true);
  });
});


test('quoted editor paths and arguments are parsed without shell expansion', () => {
  expect(resolveEditorCommand({ VISUAL: '\"/opt/My Editor/bin/editor\" --profile \"Work Profile\" --wait' })).toEqual({
    cmd: '/opt/My Editor/bin/editor', args: ['--profile', 'Work Profile', '--wait'],
  });
  expect(resolveEditorCommand({ EDITOR: "editor '$HOME' '`whoami`' ''" })).toEqual({ cmd: 'editor', args: ['$HOME', '`whoami`', ''] });
  expect(resolveEditorCommand({ EDITOR: 'editor "unterminated' })).toBeNull();
});
