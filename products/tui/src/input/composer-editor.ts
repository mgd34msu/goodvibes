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
} from '@goodvibes/engine/terminal-shell';

export {
  makeFileEditorOpener,
  resolveEditorCommand,
  type EditorCommand,
  type EditorInputStream,
  type EditorSpawn,
  type EditorSpawnResult,
  type FileEditorOpener,
  type FileEditorOpenerDeps,
} from '@goodvibes/engine/terminal-shell';

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

/** Core flow: temp file round-trip around an awaited editor launch. What happened, in words (the control's outcome). */
export async function openComposerInEditor(deps: ComposerEditorDeps): Promise<string> {
  const editor = resolveEditorCommand(deps.env);
  if (!editor.ok) {
    if (!(deps.env.VISUAL || deps.env.EDITOR || '').trim()) return 'No editor is set on this computer, so nothing was opened.';
    return `${editor.message.replace(/^\[Editor\]\s*/, '')} Nothing was opened.`;
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
    if (!ran) return `The terminal could not be handed to ${editor.cmd}, so nothing was opened.`;
    const failed = (result as EditorSpawnResult).error;
    if (failed) return `${editor.cmd} could not be started (${failed.message}), so nothing was opened.`;
    const status = (result as EditorSpawnResult).status;
    if (status !== 0 && status !== null) return `${editor.cmd} ended with code ${status}; the message was left as it was.`;
    // A draft typed into the composer while the editor was open is not overwritten.
    if (deps.readDraft() !== draft) return 'The message changed here while the editor was open, so the edited text was not loaded.';
    let edited = draft;
    try { edited = readFileSync(file, 'utf8'); } catch { /* keep the original draft */ }
    const text = edited.replace(/\n+$/, ''); // editors append a trailing newline
    deps.writeDraft(text);
    return text === draft ? `${editor.cmd} closed with the message unchanged.` : `The message is back from ${editor.cmd}, as you left it; nothing is sent until you send it.`;
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

/** Build the `openComposerEditor` command action, wiring terminal suspend/resume; it answers what happened, in words. */
export function makeComposerEditorOpener(deps: ComposerEditorOpenerDeps): () => Promise<string> {
  return () => {
    return openComposerInEditor({
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
