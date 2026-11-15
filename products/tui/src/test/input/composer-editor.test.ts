import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolveEditorCommand, openComposerInEditor, makeComposerEditorOpener, makeFileEditorOpener, type EditorSpawn, type EditorSpawnResult } from '@/input/composer-editor.ts';
import { createTerminalLifecycle } from '@goodvibes-jev/engine/terminal-shell';

/** A spawn whose editor "exits" when the test says so. */
function controlledSpawn(onStart: (args: string[]) => void = () => {}): { spawn: EditorSpawn; exit: (result?: EditorSpawnResult) => void; started: Promise<void> } {
  let exit!: (result?: EditorSpawnResult) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const spawn: EditorSpawn = (_cmd, args) => new Promise((resolve) => {
    onStart(args);
    exit = (result = { status: 0 }) => resolve(result);
    markStarted();
  });
  return { spawn, exit: (result) => exit(result), started };
}

describe('external-editor terminal ownership', () => {
  for (const kind of ['composer', 'file'] as const) {
    test(`${kind} editor balances keyboard modes, pauses input and holds frames until it exits`, async () => {
      const writes: string[] = [];
      const terminal = createTerminalLifecycle({ noAltScreen: true, write: (s) => { writes.push(s); } });
      const raw: boolean[] = [];
      const input: string[] = [];
      const held: boolean[] = [];
      let repaints = 0;
      terminal.enterTerminal();
      const editor = controlledSpawn();
      const deps = {
        buffer: { prompt: 'ABC', cursorPos: 3 },
        terminal,
        stdin: { setRawMode: (on: boolean) => { raw.push(on); }, pause: () => { input.push('pause'); }, resume: () => { input.push('resume'); } },
        repaint: () => { repaints++; },
        setHeld: (on: boolean) => { held.push(on); },
        cwd: '/tmp', env: { EDITOR: 'fake' }, notify: () => {},
        spawn: editor.spawn,
      };
      if (kind === 'composer') makeComposerEditorOpener(deps)();
      else makeFileEditorOpener(deps)('/tmp/example');
      await editor.started;
      expect(writes).toHaveLength(2);
      expect(writes[1]).toContain('\x1b[<u');
      expect(input).toEqual(['pause']);
      expect(held).toEqual([true]);
      editor.exit();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(writes).toHaveLength(3);
      expect(writes[2]).toContain('\x1b[>1u');
      terminal.restoreTerminal();
      expect(writes[3]).toContain('\x1b[<u');
      expect(writes.join('')).not.toContain('\x1b[?1049');
      expect(raw).toEqual([false, true]);
      expect(input).toEqual(['pause', 'resume']);
      expect(held).toEqual([true, false]);
      expect(repaints).toBe(1);
    });
  }

  test('a shutdown while the editor is open does not re-enter raw mode or repaint', async () => {
    const writes: string[] = [];
    const terminal = createTerminalLifecycle({ noAltScreen: false, write: (s) => { writes.push(s); } });
    const raw: boolean[] = [];
    terminal.enterTerminal();
    const editor = controlledSpawn();
    makeFileEditorOpener({
      terminal,
      stdin: { setRawMode: (on: boolean) => { raw.push(on); }, pause: () => {}, resume: () => {} },
      repaint: () => { throw new Error('must not repaint after shutdown'); },
      setHeld: () => {},
      cwd: '/tmp', env: { EDITOR: 'fake' }, notify: () => {},
      spawn: editor.spawn,
    })('/tmp/example');
    await editor.started;
    terminal.restoreTerminal();
    editor.exit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writes).toHaveLength(2);
    expect(raw).toEqual([false]);
  });

  test('the event loop keeps running while the editor is open', async () => {
    const editor = controlledSpawn();
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 1);
    let draft = 'draft';
    const done = openComposerInEditor({
      readDraft: () => draft, writeDraft: (text) => { draft = text; }, cwd: '/tmp', env: { EDITOR: 'fake' },
      suspend: () => {}, resume: () => {}, notify: () => {}, spawn: editor.spawn,
    });
    await editor.started;
    const before = ticks;
    while (ticks < before + 3) await new Promise((resolve) => setTimeout(resolve, 1));
    editor.exit();
    await done;
    clearInterval(timer);
    expect(ticks).toBeGreaterThanOrEqual(before + 3);
  });
});

describe('resolveEditorCommand', () => {
  test('prefers $VISUAL over $EDITOR', () => {
    expect(resolveEditorCommand({ VISUAL: 'code -w', EDITOR: 'vi' })).toEqual({ ok: true, cmd: 'code', args: ['-w'] });
  });
  test('an unset editor and a malformed one are told apart', () => {
    const unset = resolveEditorCommand({ EDITOR: '   ' });
    const malformed = resolveEditorCommand({ EDITOR: 'editor "unterminated' });
    expect(unset.ok).toBe(false);
    expect(malformed.ok).toBe(false);
    if (!unset.ok) expect(unset.message).toContain('Set $EDITOR');
    if (!malformed.ok) expect(malformed.message).toContain('malformed');
  });
  test('quoted editor paths and arguments are parsed without shell expansion', () => {
    expect(resolveEditorCommand({ VISUAL: '"/opt/My Editor/bin/editor" --profile "Work Profile" --wait' })).toEqual({
      ok: true, cmd: '/opt/My Editor/bin/editor', args: ['--profile', 'Work Profile', '--wait'],
    });
    expect(resolveEditorCommand({ EDITOR: "editor '$HOME' '`whoami`' ''" })).toEqual({ ok: true, cmd: 'editor', args: ['$HOME', '`whoami`', ''] });
  });
});

describe('openComposerInEditor', () => {
  test('round-trips the edited file back into the draft', async () => {
    let draft = 'hello';
    const events: string[] = [];
    const spawn: EditorSpawn = async (_cmd, args) => {
      const file = args[args.length - 1]!;
      writeFileSync(file, readFileSync(file, 'utf8') + ' + edited\n', 'utf8');
      return { status: 0 };
    };
    await openComposerInEditor({
      readDraft: () => draft, writeDraft: (text) => { draft = text; }, cwd: '/tmp', env: { EDITOR: 'fake' },
      suspend: () => events.push('suspend'), resume: () => events.push('resume'), notify: () => {}, spawn,
    });
    expect(draft).toBe('hello + edited');
    expect(events).toEqual(['suspend', 'resume']);
  });
});
