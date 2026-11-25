/**
 * place-host.ts, what a terminal program gives the place framework, and the
 * one way both programs build it.
 *
 * A place never reaches the screen or the command context itself: it reads
 * its lists through `invoke` (a daemon method), `source` (a session or
 * program source by name) and `follow` (the daemon's change events); it runs
 * a capability through `runCapability`, which is the owner's own request
 * (a pressed key, a submitted form), the same as a line typed in full.
 */
import { formatRefusal, readRefusal } from '@goodvibes/engine/errors';
import type { DaemonFrameStreamState } from '@goodvibes/engine/platform/platform/runtime/client';
import { subscribeDaemonEventFrames } from '@goodvibes/engine/platform/platform/runtime/client';
import { KEYS_BIND, KEYS_RESET, KEYS_RESET_ALL, capabilityGroupOf, capabilityIdOf, type KeysCapabilityServices } from '@goodvibes/engine/platform/platform/capabilities';
import type { KeyCombo, KeyConflict, KeyContext, KeyContextEntry, KeyToken } from '../keybindings.js';
import { keysServices } from '../keys-capabilities.js';
import { sessionCapabilityAction } from '../command-actions/capability-actions.js';
import type { SurfaceModal } from '../surface-modal-host.js';
import { parseSlashCommand } from '../slash-command-parser.js';
import { describedCommandByName } from '../command-actions/define.js';
import { openGuidedPanel } from '../command-actions/panel.js';
import { fixedChoices } from '../command-actions/typed-line.js';
import { renderTypedLine } from '../command-actions/typed-line.js';
import type { ActionDescription, ActionValues, CommandActionContext, CommandDescription } from '../command-actions/types.js';
import type { PlaceFollow } from './place-types.js';

/** The key table, as a place reads it (both programs' KeybindingsManager). */
export interface PlaceKeyTable {
  getComboLabel(action: string): string;
  getAll(): ReadonlyArray<{ readonly action: string; readonly combos: readonly KeyCombo[]; readonly description: string }>;
  getDefaults(action: string): readonly KeyCombo[];
  getConflicts(): readonly KeyConflict[];
  setOverride(action: string, combos: readonly KeyCombo[]): readonly string[];
  clearOverride(action: string): readonly string[];
  clearAllOverrides(): readonly string[];
  formatCombo(combo: KeyCombo): string;
  getConfigPath(): string;
  /** Told after every read of the file; returns the stop. */
  subscribe(listener: () => void): () => void;
  /** A place's keys (place-keys.ts). */
  registerContext(context: KeyContext): readonly string[];
  lookupInContext(contextId: string, token: KeyToken): readonly string[];
  getContextActions(): readonly KeyContextEntry[];
}

/** A source of the program by name: read now, and told when it changes. */
export interface PlaceProgramSource {
  read(): unknown;
  subscribe(onChange: () => void): () => void;
}

/** What running a capability from a place came to. */
export type PlaceRunOutcome =
  | { readonly ok: true; readonly lines: readonly string[] }
  | { readonly ok: false; readonly reason: string };

export interface PlaceHost {
  readonly keys: PlaceKeyTable;
  /** Call a daemon method; throws with the reason when it was not answered. */
  invoke(method: string, input: Readonly<Record<string, unknown>>): Promise<unknown>;
  /** Follow the daemon's change events; returns the stop. */
  follow(interest: PlaceFollow, onChange: () => void, onState: (state: DaemonFrameStreamState) => void): () => void;
  /** Told each time the program's own daemon connection comes back (its adoption of the daemon); returns the stop. */
  onDaemonBack(listener: () => void): () => void;
  /** A session or program source by name, undefined where this program has none. */
  source(name: string): PlaceProgramSource | undefined;
  /** A capability's description, by id (`schedule.pause`). */
  capability(id: string): ResolvedCapability | undefined;
  /** Run a capability with these values, as the owner's own request. */
  runCapability(id: string, values: ActionValues): Promise<PlaceRunOutcome>;
  /**
   * The form built from a capability's inputs, with `values` filled; undefined when the person left it.
   * `given`: the inputs the selected item filled (kept, not asked); `display`: how the form names them.
   */
  openForm(id: string, values: ActionValues, form: { readonly title: string; readonly given: readonly string[]; readonly display: ActionValues }): Promise<ActionValues | undefined>;
  /** Ask the one question a capability that cannot be undone or weakens a protection is asked. */
  confirm(options: { readonly title: string; readonly body: string; readonly confirmLabel: string }): Promise<boolean>;
  /** A program action by name (place-types.ts PlaceProgramAction). */
  programAction(name: string): ((itemId: string, place: PlacePrograms) => Promise<string | undefined>) | undefined;
  push(modal: SurfaceModal): void;
  close(modal: SurfaceModal): void;
  requestRender(): void;
  openPlace(id: string): void;
}

/** What a program action may ask of the place that runs it. */
export interface PlacePrograms {
  /** Read the next key as pressed (and the key after it when it is the leader); undefined when left with Esc. */
  captureKey(prompt: string): Promise<KeyCombo | undefined>;
  /** Run a capability as the owner's own request (what the program action asked for, after it read the key). */
  run(id: string, values: ActionValues): Promise<PlaceRunOutcome>;
}

export interface ResolvedCapability {
  readonly command: CommandDescription<never>;
  readonly action: ActionDescription<never>;
  /** True for a capability no slash command carries: the place runs its action here, never as a typed line. */
  readonly runsHere?: boolean | undefined;
}

/** The key capabilities (builtin/keys.ts): no slash command carries them; a place runs them on the program's key table. */
const KEY_CAPABILITIES = [KEYS_BIND, KEYS_RESET, KEYS_RESET_ALL] as const;

/** The key capabilities as a place resolves them, over this program's key table. */
function keyCapabilities(keys: PlaceKeyTable): ReadonlyMap<string, ResolvedCapability> {
  const services = (): KeysCapabilityServices => ({ keys: keysServices(keys) });
  const options = { terminalOnly: 'Keys belong to the terminal program that reads them.' };
  const actions = KEY_CAPABILITIES.map((definition) => ({
    id: definition.capability.id,
    action: sessionCapabilityAction<CommandActionContext, KeysCapabilityServices>(definition, services, options) as unknown as ActionDescription<never>,
  }));
  const command: CommandDescription<never> = {
    name: 'keys', title: 'Keys', summary: 'Bind a key to an action, or put keys back on their defaults.', group: 'System',
    actions: actions.map((entry) => entry.action),
  };
  return new Map(actions.map((entry) => [entry.id, { command, action: entry.action, runsHere: true }]));
}

/**
 * The action a capability id names, by A's registry only: an action's
 * declared id, else the id the catalog gives it (`capabilityIdOf`:
 * `<command>.<word>`, or `<group>.<command>` for a command of one action with
 * no word). Nothing else resolves: a place names a capability by that id.
 */
export function resolveCapability(id: string): ResolvedCapability | undefined {
  const dot = id.indexOf('.');
  if (dot <= 0) return undefined;
  for (const name of [id.slice(0, dot), id.slice(dot + 1)]) {
    const command = describedCommandByName(name);
    if (!command) continue;
    const action = command.actions.find((candidate) => (candidate.capability?.id
      ?? capabilityIdOf(command.name, candidate.word, capabilityGroupOf(command.name, candidate.id))) === id);
    if (action) return { command, action };
  }
  return undefined;
}

/** The step a form opens on: the first holding an input not given yet, counting only the steps the form shows. */
function firstOpenStep(action: ActionDescription<never>, values: ActionValues, given: ReadonlySet<string>): number {
  const shown = action.inputs.filter((input) => !given.has(input.id) && !('impliedBy' in input.typed && !fixedChoices(input)));
  const steps = [...new Set(shown.map((input) => input.step ?? 1))].sort((a, b) => a - b);
  const index = steps.findIndex((step) => shown.some((input) => (input.step ?? 1) === step && values[input.id] === undefined));
  return Math.max(0, index);
}

/** A bound key as a hint's keycap shows it: `esc`, `⏎`, `ctrl+g m`; the fallback when it is unbound. */
export function keycapOf(keys: Pick<PlaceKeyTable, 'getComboLabel'>, action: string, fallback: string): string {
  const label = keys.getComboLabel(action);
  if (label === '(unbound)') return fallback;
  const lower = label.toLowerCase();
  return lower === 'escape' ? 'esc' : lower === 'enter' ? '⏎' : lower;
}

/** A transport's words for an unreachable daemon, which say nothing to a person. */
const UNREACHABLE = /unable to connect|econnrefused|connection refused|socket connection was closed|fetch failed|failed to fetch|network ?error|connect(ion)? timed? ?out|econnreset/i;

/** A reason as a person reads it: an unreachable daemon in plain words, no doubled ending. */
export function plainReason(reason: string): string {
  if (UNREACHABLE.test(reason)) return 'the daemon did not answer (it may be stopped or still starting)';
  return reason.trim().replace(/[.?!]+\s*\.$/, '.').replace(/\.$/, '');
}

/** The reason a refusal or an error gives, in its own words (never a command to type). */
export function reasonOf(error: unknown): string {
  const refusal = readRefusal(error);
  if (refusal) return plainReason(refusal.reason.trim() || formatRefusal(refusal));
  return plainReason(error instanceof Error ? error.message : String(error));
}

export interface PlaceHostOptions {
  /** The program's command context: the guided form, the confirm dialog and the pickers draw from it. */
  readonly context: CommandActionContext;
  /** The registry's owner path: a line run from here is the owner's own request. */
  readonly executeFromOwner: (name: string, args: string[], context: CommandActionContext) => Promise<boolean>;
  readonly keys: PlaceKeyTable;
  readonly invoke: (method: string, input: Readonly<Record<string, unknown>>) => Promise<unknown>;
  /** The daemon's address and credential for its event stream, or why there is none. */
  readonly daemonEndpoint: () => Promise<{ readonly baseUrl: string; readonly token: string | null } | { readonly unavailable: string }>;
  /**
   * The program's own signal that its daemon connection is back (the terminal
   * app's spine adoption, the Agent's attach): a place opened while the daemon
   * was down reads and follows again on it. Returns the stop.
   */
  readonly onDaemonBack: (listener: () => void) => () => void;
  readonly sources?: Readonly<Record<string, PlaceProgramSource>> | undefined;
  readonly programActions?: Readonly<Record<string, (itemId: string, place: PlacePrograms) => Promise<string | undefined>>> | undefined;
  readonly modals: { push(modal: SurfaceModal): void; close(modal: SurfaceModal): void };
  readonly requestRender: () => void;
  readonly openPlace: (id: string) => void;
}

/** The one host both terminal programs build for their places. */
export function createPlaceHost(options: PlaceHostOptions): PlaceHost {
  const keyed = keyCapabilities(options.keys);
  const resolve = (id: string): ResolvedCapability | undefined => resolveCapability(id) ?? keyed.get(id);
  const host: PlaceHost = {
    keys: options.keys,
    invoke: options.invoke,
    follow(interest, onChange, onState) {
      let stop: (() => void) | null = null;
      let stopped = false;
      void options.daemonEndpoint().then((endpoint) => {
        if (stopped) return;
        if ('unavailable' in endpoint) { onState({ kind: 'lost', reason: endpoint.unavailable }); return; }
        stop = subscribeDaemonEventFrames({ baseUrl: endpoint.baseUrl, getAuthToken: () => endpoint.token }, interest, onChange, onState);
      }, (error: unknown) => { if (!stopped) onState({ kind: 'lost', reason: reasonOf(error) }); });
      return () => { stopped = true; stop?.(); stop = null; };
    },
    onDaemonBack: options.onDaemonBack,
    source: (name) => options.sources?.[name],
    capability: resolve,
    async runCapability(id, values) {
      const resolved = resolve(id);
      if (!resolved) return { ok: false, reason: `${id} is not a capability this program has.` };
      const printed: string[] = [];
      const context: CommandActionContext = { ...options.context, print: (message: string) => { printed.push(message); }, printLive: undefined };
      if (resolved.runsHere) {
        // No slash command carries it: its action runs here, as the owner's own press.
        try {
          const said = await resolved.action.run(values, context as never);
          const lines = typeof said === 'string' ? said.split('\n').filter((line) => line.trim() !== '') : [];
          return { ok: true, lines };
        } catch (error) {
          return { ok: false, reason: reasonOf(error) };
        }
      }
      const { name, args } = parseSlashCommand(renderTypedLine(resolved.command, resolved.action.id, values));
      try {
        const ran = await options.executeFromOwner(name, [...args], context);
        if (!ran) return { ok: false, reason: `${resolved.action.label} is not available in this program.` };
        return { ok: true, lines: printed.flatMap((message) => message.split('\n')).filter((line) => line.trim() !== '') };
      } catch (error) {
        return { ok: false, reason: reasonOf(error) };
      }
    },
    async openForm(id, values, form) {
      const resolved = resolve(id);
      if (!resolved) return undefined;
      // The inputs the item gave are not asked, so the form opens on its first step that asks something.
      const given = new Set(form.given);
      const asked = Object.fromEntries(Object.entries(values).filter(([input]) => !given.has(input)));
      const opened = openGuidedPanel(resolved.command, options.context, {
        action: resolved.action, values, step: firstOpenStep(resolved.action, asked, given), place: form,
      });
      if (!opened) return undefined;
      const result = await opened;
      return result.kind === 'run' ? result.values : undefined;
    },
    async confirm(question) {
      const ask = options.context.confirm;
      if (!ask) return false;
      return ask({ ...question, tone: 'danger' });
    },
    programAction: (name) => options.programActions?.[name],
    push: (modal) => options.modals.push(modal),
    close: (modal) => options.modals.close(modal),
    requestRender: options.requestRender,
    openPlace: options.openPlace,
  };
  return host;
}
