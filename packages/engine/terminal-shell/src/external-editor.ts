/**
 * Handing the terminal to the user's $VISUAL / $EDITOR, shared by both terminal apps.
 *
 * While the editor runs the app gives the terminal up: raw mode is dropped,
 * keyboard input is paused and frames are held, and the alt screen / mouse /
 * paste / focus modes are disabled so the editor owns a normal terminal; on
 * return the modes are restored and the screen is repainted from scratch.
 *
 * The editor is awaited, not run synchronously, so turns, agents, timers and
 * daemon connections keep running while it is open. The spawn is injectable.
 */

import { spawn as spawnChild } from 'node:child_process';
import type { TerminalLifecycle } from './terminal-lifecycle.js';

export interface EditorSpawnResult {
  readonly status: number | null;
  readonly error?: Error | undefined;
}

/** Runs the editor with inherited stdio and resolves when it exits. */
export type EditorSpawn = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<EditorSpawnResult>;

/** Split an editor command into argv, honoring single/double quotes; throws on an unterminated quote or trailing escape. */
function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let started = false;
  for (const ch of command) {
    if (escaped) { current += ch; escaped = false; started = true; continue; }
    if (ch === '\\' && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) {
      if (ch === quote) quote = null; else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (started) { tokens.push(current); current = ''; started = false; }
      continue;
    }
    current += ch;
    started = true;
  }
  if (escaped) throw new Error('Trailing escape in editor command.');
  if (quote) throw new Error('Unterminated quote in editor command.');
  if (started) tokens.push(current);
  return tokens;
}

export type EditorCommand =
  | { readonly ok: true; readonly cmd: string; readonly args: string[] }
  | { readonly ok: false; readonly message: string };

/** Resolve $VISUAL/$EDITOR into a command + fixed args, or say why it cannot be used. */
export function resolveEditorCommand(env: NodeJS.ProcessEnv, purpose = 'edit the composer'): EditorCommand {
  const name = env.VISUAL?.trim() ? 'VISUAL' : 'EDITOR';
  const raw = (env.VISUAL || env.EDITOR || '').trim();
  if (!raw) return { ok: false, message: `[Editor] Set $EDITOR or $VISUAL to ${purpose} in an external editor.` };
  let parts: string[];
  try { parts = tokenizeCommand(raw); } catch (error) {
    return { ok: false, message: `[Editor] $${name} is malformed (${error instanceof Error ? error.message : String(error)}): ${raw}. Fix its quoting and try again.` };
  }
  const cmd = parts[0];
  if (!cmd) return { ok: false, message: `[Editor] $${name} names no program: ${raw}.` };
  return { ok: true, cmd, args: parts.slice(1) };
}

export const defaultEditorSpawn: EditorSpawn = (cmd, args, opts) => new Promise((resolve) => {
  let settled = false;
  const settle = (result: EditorSpawnResult): void => {
    if (settled) return;
    settled = true;
    resolve(result);
  };
  try {
    const child = spawnChild(cmd, args, { stdio: 'inherit', cwd: opts.cwd, env: opts.env });
    child.once('error', (error) => settle({ status: null, error }));
    child.once('exit', (code) => settle({ status: code }));
  } catch (error) {
    settle({ status: null, error: error instanceof Error ? error : new Error(String(error)) });
  }
});

/** One editor at a time: a second open while one runs would fight it for the terminal. */
let editorOpen = false;

/** Run `body` with the terminal handed to an editor; refuses (false) while another editor is open. */
export async function withEditorTerminal(suspend: () => void, resume: () => void, notify: (message: string) => void, body: () => Promise<void>): Promise<boolean> {
  if (editorOpen) {
    notify('[Editor] An external editor is already open; close it first.');
    return false;
  }
  editorOpen = true;
  try {
    suspend();
    try { await body(); } finally { resume(); }
  } finally {
    editorOpen = false;
  }
  return true;
}

type EditorTerminal = Pick<TerminalLifecycle, 'suspendTerminal' | 'enterTerminal' | 'isTerminalRestored'>;

/** The keyboard stream the app reads; paused while an editor owns the terminal. */
export interface EditorInputStream {
  setRawMode(on: boolean): unknown;
  pause(): unknown;
  resume(): unknown;
}

export interface EditorTerminalDeps {
  readonly stdin: EditorInputStream;
  readonly terminal: EditorTerminal;
  readonly repaint: () => void;
  /** Frames are held while true, so background output does not paint over the editor. */
  readonly setHeld: (held: boolean) => void;
}

export function suspendForEditor(deps: EditorTerminalDeps): void {
  deps.setHeld(true);
  try { deps.stdin.setRawMode(false); } catch { /* stdin may not be a TTY */ }
  deps.stdin.pause();
  deps.terminal.suspendTerminal();
}

export function resumeAfterEditor(deps: EditorTerminalDeps): void {
  deps.setHeld(false);
  if (deps.terminal.isTerminalRestored()) return;
  deps.terminal.enterTerminal();
  try { deps.stdin.setRawMode(true); } catch { /* stdin may not be a TTY */ }
  deps.stdin.resume();
  deps.repaint();
}

/** Editors known to take `+<line> <file>` to open at a line. */
const LINE_ARG_EDITORS = new Set(['vi', 'vim', 'nvim', 'nano', 'emacs', 'micro', 'kak', 'hx', 'helix', 'ne', 'joe', 'mg']);

export interface FileEditorOpenerDeps extends EditorTerminalDeps {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly notify: (message: string) => void;
  readonly spawn?: EditorSpawn | undefined;
}

/**
 * Opens a file in $VISUAL / $EDITOR and resolves once the editor has exited:
 * true when it ran and exited cleanly, false when it could not start, another
 * editor was open, or it exited with an error (each already told to the user).
 */
export type FileEditorOpener = (path: string, line?: number) => Promise<boolean>;

/**
 * Build `openFileInEditor`: hand the terminal to $VISUAL / $EDITOR on a file
 * (at a line when the editor is known to take `+<line>`), then restore and
 * repaint. A caller that reads the file back awaits the result first.
 */
export function makeFileEditorOpener(deps: FileEditorOpenerDeps): FileEditorOpener {
  return async (path, line) => {
    const editor = resolveEditorCommand(deps.env, 'open files');
    if (!editor.ok) {
      deps.notify(editor.message);
      return false;
    }
    const base = editor.cmd.split('/').pop() ?? editor.cmd;
    const lineArgs = line !== undefined && line > 0 && LINE_ARG_EDITORS.has(base) ? [`+${line}`] : [];
    const spawn = deps.spawn ?? defaultEditorSpawn;
    let result: EditorSpawnResult = { status: null };
    const ran = await withEditorTerminal(() => suspendForEditor(deps), () => resumeAfterEditor(deps), deps.notify, async () => {
      result = await spawn(editor.cmd, [...editor.args, ...lineArgs, path], { cwd: deps.cwd, env: deps.env });
    });
    if (!ran) return false;
    if (result.error) {
      deps.notify(`[Editor] Failed to launch ${editor.cmd}: ${result.error.message}`);
      return false;
    }
    if (result.status === null) {
      deps.notify(`[Editor] ${editor.cmd} was stopped before it exited.`);
      return false;
    }
    if (result.status !== 0) {
      deps.notify(`[Editor] ${editor.cmd} exited with code ${result.status}.`);
      return false;
    }
    return true;
  };
}
