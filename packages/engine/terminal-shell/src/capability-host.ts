/**
 * capability-host.ts, what this terminal program lends its model's
 * capability tools once it has them: its slash commands (every action is a
 * capability the model can find) and its open conversation (the
 * conversation's own capabilities run on it). The turn's tools are built
 * before either exists, so they read this holder at each call; a program
 * that never binds it (a headless run) finds the moved capabilities and
 * has no conversation capabilities to run.
 */
import type { CapabilityCatalog } from '@goodvibes/engine/platform/platform/capabilities';
import { terminalCapabilityCatalog } from './capability-catalog.js';
import type { SessionCapabilityServices } from './agent-turn/capability-tools.js';
import type { ConcealedInputRequest } from './concealed-input.js';

interface RegisteredCommandLike {
  readonly name: string;
  readonly described?: unknown;
}

interface BoundHost {
  readonly catalog: () => CapabilityCatalog;
  readonly session: () => SessionCapabilityServices | undefined;
  readonly hidden?: (() => HiddenLine | undefined) | undefined;
}

/**
 * The program's hidden input line (the one `/secrets set <name>` types its value on): the person types, nothing is
 * echoed or kept in history, and the value goes to the caller alone, never to the model.
 */
export type HiddenLine = (request: { readonly label: string; readonly onSubmit: (value: string) => void; readonly onCancel: () => void }) => void;

let bound: BoundHost | undefined;
const unbound = terminalCapabilityCatalog(() => []);
const changed = new Set<() => void>();

function announceChange(): void {
  for (const listener of changed) {
    try { listener(); } catch { /* one tool's refresh does not stop another's */ }
  }
}

/** Lend the program's commands and live conversation to its model's capability tools. Returns the unbinding. */
export function bindCapabilityHost(host: {
  readonly commands: () => readonly RegisteredCommandLike[];
  readonly session: () => SessionCapabilityServices | undefined;
  /** The hidden input line once the program's screen has one; absent in a run with no screen. */
  readonly hidden?: (() => HiddenLine | undefined) | undefined;
}): () => void {
  const mine: BoundHost = { catalog: terminalCapabilityCatalog(host.commands), session: host.session, ...(host.hidden ? { hidden: host.hidden } : {}) };
  bound = mine;
  announceChange();
  return () => { if (bound === mine) { bound = undefined; announceChange(); } };
}

/** Call `listener` whenever the bound catalog changes (a program bound or unbound its commands). */
export function onBoundCapabilityCatalogChange(listener: () => void): void {
  changed.add(listener);
}

/** This program's capability catalog now. */
export function boundCapabilityCatalog(): CapabilityCatalog {
  return (bound?.catalog ?? unbound)();
}

/**
 * Ask the person for a value on the program's hidden line: the value typed, null when he went back (Esc), undefined
 * when this program has no screen to ask on.
 */
export function askBoundHiddenValue(label: string): Promise<string | null> | undefined {
  const line = bound?.hidden?.();
  if (!line) return undefined;
  return new Promise((resolve) => line({ label, onSubmit: (value) => resolve(value), onCancel: () => resolve(null) }));
}

/** The words a program prints over its hidden line when a model's call needs a value only the person types. */
export function hiddenValuePrompt(label: string): string {
  return `${label}: type it below and press Enter (it is hidden and never kept in history, and the model never sees it). Esc goes back.`;
}

/**
 * A program's hidden line for a model's call, from its command context: the instruction is shown while the value is
 * typed, and once it is taken (or the person went back) that line says only that, so nothing about the value stays
 * on screen. Undefined until the screen has a hidden line.
 */
export function hiddenLineFrom(context: {
  readonly print: (text: string) => void;
  readonly printLive?: ((text: string) => ((next: string) => void) | null) | undefined;
  readonly beginConcealedInput?: ((request: ConcealedInputRequest) => void) | undefined;
}): HiddenLine | undefined {
  const begin = context.beginConcealedInput;
  if (!begin) return undefined;
  return (request) => {
    const prompt = hiddenValuePrompt(request.label);
    const replace = context.printLive?.(prompt) ?? null;
    if (replace === null) context.print(prompt);
    // The value's own name ("Security code"), the last part of a label that names the act first.
    const value = request.label.split(': ').pop() ?? request.label;
    begin({
      label: request.label,
      onSubmit: (typed) => { replace?.(`${value}: given.`); request.onSubmit(typed); },
      onCancel: () => { replace?.(`${value}: not given (you went back).`); request.onCancel(); },
    });
  };
}

/** The open conversation's services now, or undefined when there is none. */
export function boundSessionCapabilities(): SessionCapabilityServices | undefined {
  return bound?.session();
}
