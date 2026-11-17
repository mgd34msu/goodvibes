/**
 * External-editor composition for the composer.
 *
 * Opens the user's $VISUAL/$EDITOR on the current composer draft, then loads
 * the edited text back into the composer. While the editor runs the TUI hands
 * the terminal over: raw mode is dropped, keyboard input is paused and frames
 * are held, and the alt screen / mouse / paste / focus modes are disabled so
 * the editor owns a normal terminal; on return the TUI modes are restored and
 * the screen is repainted from scratch.
 *
 * The editor is awaited, not run synchronously, so turns, agents, timers and
 * daemon connections keep running while it is open; what they print is
 * painted on return. The spawn is injectable for testing.
 */

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultEditorSpawn,
  resolveEditorCommand,
  resumeAfterEditor,
  suspendForEditor,
  withEditorTerminal,
  type EditorSpawn,
  type EditorSpawnResult,
  type EditorTerminalDeps,
} from '@goodvibes-jev/engine/terminal-shell';

export {
  makeFileEditorOpener,
  resolveEditorCommand,
  type EditorCommand,
  type EditorInputStream,
  type EditorSpawn,
  type EditorSpawnResult,
  type FileEditorOpener,
  type FileEditorOpenerDeps,
} from '@goodvibes-jev/engine/terminal-shell';

export interface ComposerEditorDeps {
  readonly readDraft: () => string;
  readonly writeDraft: (text: string) => void;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Hand the terminal to the editor: drop raw/alt-screen modes, pause input, hold frames. */
  readonly suspend: () => void;
  /** Take the terminal back: restore the modes, resume input and repaint. */
  readonly resume: () => void;
  readonly notify: (message: string) => void;
  readonly spawn?: EditorSpawn;
}

/** Core flow: temp file round-trip around an awaited editor launch. */
export async function openComposerInEditor(deps: ComposerEditorDeps): Promise<void> {
  const editor = resolveEditorCommand(deps.env);
  if (!editor.ok) {
    deps.notify(editor.message);
    return;
  }
  const draft = deps.readDraft();
  // Real production scratch (runs on the end user's machine, not test
  // infrastructure), so this stays rooted at the real OS temp dir rather
  // than the test-only makeProjectTempDir helper. Cleaned up in the
  // `finally` below on every exit path.
  const dir = mkdtempSync(join(tmpdir(), 'goodvibes-composer-'));
  const file = join(dir, 'COMPOSER.md');
  const spawn = deps.spawn ?? defaultEditorSpawn;
  try {
    writeFileSync(file, draft, 'utf8');
    let result: EditorSpawnResult = { status: null };
    const ran = await withEditorTerminal(deps.suspend, deps.resume, deps.notify, async () => {
      result = await spawn(editor.cmd, [...editor.args, file], { cwd: deps.cwd, env: deps.env });
    });
    if (!ran) return;
    if (result.error) {
      deps.notify(`[Editor] Failed to launch ${editor.cmd}: ${result.error.message}`);
      return;
    }
    if (result.status !== 0 && result.status !== null) {
      deps.notify(`[Editor] ${editor.cmd} exited with code ${result.status}; composer left unchanged.`);
      return;
    }
    // A draft typed into the composer while the editor was open is not overwritten.
    if (deps.readDraft() !== draft) {
      deps.notify('[Editor] The composer changed while the editor was open; the edited text was not loaded.');
      return;
    }
    let edited = draft;
    try { edited = readFileSync(file, 'utf8'); } catch { /* keep the original draft */ }
    deps.writeDraft(edited.replace(/\n+$/, '')); // editors append a trailing newline
    deps.notify('[Editor] Composer updated from external editor.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface ComposerEditorOpenerDeps extends EditorTerminalDeps {
  /** The live composer buffer (InputHandler exposes public `prompt`/`cursorPos`). */
  readonly buffer: { prompt: string; cursorPos: number };
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly notify: (message: string) => void;
  readonly spawn?: EditorSpawn;
}

/** Build the `openComposerEditor` command action, wiring terminal suspend/resume. */
export function makeComposerEditorOpener(deps: ComposerEditorOpenerDeps): () => void {
  return () => {
    void openComposerInEditor({
      readDraft: () => deps.buffer.prompt,
      writeDraft: (text) => { deps.buffer.prompt = text; deps.buffer.cursorPos = text.length; },
      cwd: deps.cwd,
      env: deps.env,
      notify: deps.notify,
      spawn: deps.spawn,
      suspend: () => suspendForEditor(deps),
      resume: () => resumeAfterEditor(deps),
    });
  };
}
