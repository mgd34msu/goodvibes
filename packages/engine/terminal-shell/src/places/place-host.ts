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
import type { DaemonFrameChange, DaemonFrameStreamState } from '@goodvibes/engine/platform/platform/runtime/client';
import { subscribeDaemonEventFrames } from '@goodvibes/engine/platform/platform/runtime/client';
import {
  DAEMON_CAPABILITIES, KEYS_BIND, KEYS_RESET, KEYS_RESET_ALL, METHOD_CAPABILITIES, capabilityGroupOf, capabilityIdOf,
  type CapabilityDefinition, type KeysCapabilityServices,
} from '@goodvibes/engine/platform/platform/capabilities';
import { SESSION_CAPABILITIES } from '@goodvibes/engine/platform/platform/capabilities';
import type { SessionCapabilityServices } from '../agent-turn/capability-tools.js';
import type { KeyCombo, KeyConflict, KeyContext, KeyContextEntry, KeyToken } from '../keybindings.js';
import { keysServices } from '../keys-capabilities.js';
import {
  daemonCapabilityAction, runDaemonCapabilityHere, sessionCapabilityAction, type CapabilityRevealed, type DaemonCapabilityBinding,
} from '../command-actions/capability-actions.js';
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
  /** Every key bound to an action, as the table prints each. */
  getComboLabels(action: string): readonly string[];
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
  /**
   * The items whose content holds the words, each with the line that holds them (item id to line), for a list that
   * declares `search` (place-types.ts): a list's titles are matched by the place itself.
   */
  find?(words: string): Promise<ReadonlyMap<string, string>> | ReadonlyMap<string, string>;
  /**
   * The list was drawn for a person: its tab is the one open in a place on screen (a read for a count or a find is
   * not). What being looked at means for the program: the System place's notices are seen then (system-place.ts).
   */
  shown?(): void;
}

/** What running a capability from a place came to. */
export type PlaceRunOutcome =
  /** `reveal`: a value the person must see once (the capability declares `reveals`), shown in its own pane only. */
  | { readonly ok: true; readonly lines: readonly string[]; readonly reveal?: CapabilityRevealed | undefined }
  | { readonly ok: false; readonly reason: string };

export interface PlaceHost {
  readonly keys: PlaceKeyTable;
  /** Call a daemon method; throws with the reason when it was not answered. */
  invoke(method: string, input: Readonly<Record<string, unknown>>): Promise<unknown>;
  /** Follow the daemon's change events, each told with its frame (none after the stream came back); returns the stop. */
  follow(interest: PlaceFollow, onChange: (change?: DaemonFrameChange) => void, onState: (state: DaemonFrameStreamState) => void): () => void;
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
  /**
   * Open a place, on its list `start.list` when given (a tab the menu found by name), pressing its action
   * `start.action` (by its name in the place's key context) at once when given (an action the menu ran).
   */
  openPlace(id: string, start?: { readonly list?: string | undefined; readonly action?: string | undefined; readonly item?: string | undefined }): void;
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
  /** True for a daemon capability run here: the place asks `capabilities.run` itself, so it reads the whole answer (its reveal). */
  readonly daemon?: boolean | undefined;
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
 * The capabilities that run where the conversation is (SESSION_CAPABILITIES)
 * as a place resolves one that no slash command of this program carries: its
 * definition's action, run here with this program's own services, as the
 * owner's own press.
 */
function sessionCapabilities(services: (() => SessionCapabilityServices) | undefined): ReadonlyMap<string, ResolvedCapability> {
  if (!services) return new Map();
  const options = { terminalOnly: 'It acts on what this terminal program holds.' };
  return new Map(SESSION_CAPABILITIES.map((moved) => {
    const definition = moved.definition as unknown as CapabilityDefinition<SessionCapabilityServices>;
    const action = sessionCapabilityAction<CommandActionContext, SessionCapabilityServices>(definition, () => services(), options) as unknown as ActionDescription<never>;
    const command: CommandDescription<never> = {
      name: moved.command.name, title: moved.command.title, summary: definition.label, group: 'System', actions: [action],
    };
    return [definition.capability.id, { command, action, runsHere: true }];
  }));
}

/**
 * The daemon's own capabilities (DAEMON_CAPABILITIES) as a place resolves one
 * that no slash command of this program carries: its definition's action,
 * run through `capabilities.run` as the owner's own press, with the program's
 * binding (its daemon, its project and its name). The same in both programs,
 * so a capability whose command one program lacks, or whose command is gone,
 * is still a control.
 */
function daemonCapabilities(binding: DaemonCapabilityBinding<never> | undefined): ReadonlyMap<string, ResolvedCapability> {
  if (!binding) return new Map();
  // With them the ones that run through a daemon method of their own (METHOD_CAPABILITIES): `capabilities.run` runs that method.
  const all: readonly { readonly definition: Pick<CapabilityDefinition<never>, 'capability' | 'label'>; readonly command: { readonly name: string; readonly title: string } }[] = [
    ...DAEMON_CAPABILITIES, ...METHOD_CAPABILITIES,
  ];
  return new Map(all.map((moved) => {
    const action = daemonCapabilityAction<never>(moved.definition as unknown as CapabilityDefinition<never>, binding) as ActionDescription<never>;
    const command: CommandDescription<never> = {
      name: moved.command.name, title: moved.command.title, summary: moved.definition.label, group: 'System', actions: [action],
    };
    return [moved.definition.capability.id, { command, action, runsHere: true, daemon: true }];
  }));
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
export function keycapOf(keys: Pick<PlaceKeyTable, 'getComboLabel'> & Partial<Pick<PlaceKeyTable, 'getComboLabels'>>, action: string, fallback: string, every = false): string {
  // A hint names the first key bound; the list of every key (`every`) names all of them ("x/delete").
  const bound = keys.getComboLabels ? keys.getComboLabels(action) : [keys.getComboLabel(action)].filter((label) => label !== '(unbound)');
  const labels = every ? bound : bound.slice(0, 1);
  if (labels.length === 0) return fallback;
  return labels.map((label) => {
    const lower = label.toLowerCase();
    return lower === 'escape' ? 'esc' : lower === 'enter' ? '⏎' : lower;
  }).join('/');
}

/** A transport's words for an unreachable daemon, which say nothing to a person. */
const UNREACHABLE = /unable to connect|econnrefused|connection refused|socket connection was closed|fetch failed|failed to fetch|network ?error|connect(ion)? timed? ?out|econnreset/i;

/** A reason as a person reads it: an unreachable daemon in plain words, no doubled ending. */
export function plainReason(reason: string): string {
  if (UNREACHABLE.test(reason)) return 'the daemon did not answer (it may be stopped or still starting)';
  return reason.trim()
    // A refusal and its next step are two sentences, however a transport joined them ("... changed.; Ask the owner").
    .replace(/([.?!])\s*;\s*(\S)/g, (_whole, stop: string, first: string) => `${stop} ${first.toUpperCase()}`)
    .replace(/[.?!]+\s*\.$/, '.').replace(/\.$/, '');
}

/** The reason a refusal or an error gives, in its own words (never a command to type). */
export function reasonOf(error: unknown): string {
  const refusal = readRefusal(error);
  // The refusal and its next step as two sentences, worded by the one shared piece (errors `formatRefusal`).
  if (refusal) return plainReason(refusal.reason.trim() ? formatRefusal(refusal) : refusal.state);
  const words = error instanceof Error ? error.message : String(error);
  // A capability's refusal (`CapabilityRefusal.next`) or a daemon's answer (`next`, `hint`) carries its next step:
  // said as the second sentence, as formatRefusal says it.
  const next = nextStepOf(error) ?? nextStepOf((error as { readonly body?: unknown } | null)?.body);
  if (next && !words.includes(next)) return plainReason(formatRefusal({ code: '', state: '', reason: words, next: [next], retryable: false } as unknown as Parameters<typeof formatRefusal>[0]));
  return plainReason(words);
}

/** The next step an error or a daemon answer names (`next`: a step or a list, most useful first; else `hint`). */
function nextStepOf(holder: unknown): string | undefined {
  if (!holder || typeof holder !== 'object') return undefined;
  const record = holder as { readonly next?: unknown; readonly hint?: unknown };
  const next = Array.isArray(record.next) ? record.next.find((step): step is string => typeof step === 'string' && step.trim() !== '') : record.next;
  if (typeof next === 'string' && next.trim()) return next.trim();
  return typeof record.hint === 'string' && record.hint.trim() ? record.hint.trim() : undefined;
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
  /**
   * How this program reaches the daemon for a capability (its `capability-binding.ts`): a daemon capability no
   * slash command of this program carries is run with it, as the owner's own press.
   */
  readonly capabilityBinding?: DaemonCapabilityBinding<never> | undefined;
  /**
   * This program's services for the capabilities that run where the conversation is (its `session-capabilities.ts`):
   * a session capability no slash command of this program carries is run with them, as the owner's own press.
   */
  readonly sessionServices?: (() => SessionCapabilityServices) | undefined;
  readonly modals: { push(modal: SurfaceModal): void; close(modal: SurfaceModal): void };
  readonly requestRender: () => void;
  readonly openPlace: (id: string, start?: { readonly list?: string | undefined; readonly action?: string | undefined; readonly item?: string | undefined }) => void;
}

/** The one host both terminal programs build for their places. */
export function createPlaceHost(options: PlaceHostOptions): PlaceHost {
  const keyed = keyCapabilities(options.keys);
  const daemonOwn = daemonCapabilities(options.capabilityBinding);
  const sessionOwn = sessionCapabilities(options.sessionServices);
  // A session capability whose piece this program lacks (definition `available`: the Agent keeps no code index) is not resolved.
  // The services are built once for every capability a draw asks about, not once per action.
  let drawnServices: SessionCapabilityServices | undefined;
  const servicesNow = (build: () => SessionCapabilityServices): SessionCapabilityServices => {
    if (!drawnServices) {
      drawnServices = build();
      queueMicrotask(() => { drawnServices = undefined; });
    }
    return drawnServices;
  };
  const sessionUsable = (id: string): boolean => {
    const definition = SESSION_CAPABILITIES.find((moved) => moved.definition.capability.id === id)?.definition as CapabilityDefinition<SessionCapabilityServices> | undefined;
    return !definition?.available || (options.sessionServices !== undefined && definition.available(servicesNow(options.sessionServices)));
  };
  // Not available is no control, also when a slash command of this program still carries it (the Agent's /session upload).
  const resolve = (id: string): ResolvedCapability | undefined => !sessionUsable(id) ? undefined
    : resolveCapability(id) ?? keyed.get(id) ?? daemonOwn.get(id) ?? sessionOwn.get(id);
  const host: PlaceHost = {
    keys: options.keys,
    // A list read through `capabilities.run` is this program's: its project and its name go with it (a project's hooks file, its MCP config).
    invoke: (method, input) => {
      if ((method !== 'capabilities.run' && method !== 'places.counts') || !options.capabilityBinding) return options.invoke(method, input);
      const body = method === 'capabilities.run' && input['workingDirectory'] === undefined ? { ...options.capabilityBinding.caller(options.context as never), ...input } : input;
      // A list the person opened (or the menu's counts of them) is read as the person's own request: without it the
      // daemon's gate decided each read under the owner's mode, and in Jev decides each read was a decision posted to
      // the inbox, whose event read the lists again.
      return options.capabilityBinding.daemon(options.context as never).invoke(method, body, { explicitUserRequest: true });
    },
    follow(interest, onChange, onState) {
      let stop: (() => void) | null = null;
      let stopped = false;
      void options.daemonEndpoint().then((endpoint) => {
        if (stopped) return;
        if ('unavailable' in endpoint) { onState({ kind: 'lost', reason: endpoint.unavailable }); return; }
        // This program's project: a notice about another project's list is not a change for this screen.
        const own = options.capabilityBinding?.caller(options.context as never).workingDirectory;
        // The credential is read again for every connect: one the program renewed since (its connection repaired after
        // the daemon restarted) is the one sent, never the one this follow started with, which the daemon then refuses
        // for good (a refused credential ends a stream; nothing reconnects it).
        const token = async (): Promise<string | null> => {
          const now = await options.daemonEndpoint().catch(() => endpoint);
          return 'unavailable' in now ? endpoint.token : now.token;
        };
        stop = subscribeDaemonEventFrames({ baseUrl: endpoint.baseUrl, getAuthToken: token,
          ...(own !== undefined ? { workingDirectory: own } : {}) }, interest, onChange, onState);
      }, (error: unknown) => { if (!stopped) onState({ kind: 'lost', reason: reasonOf(error) }); });
      return () => { stopped = true; stop?.(); stop = null; };
    },
    onDaemonBack: options.onDaemonBack,
    source: (name) => options.sources?.[name],
    capability: resolve,
    async runCapability(id, values): Promise<PlaceRunOutcome> {
      const resolved = resolve(id);
      if (!resolved) return { ok: false, reason: `${id} is not a capability this program has.` };
      const printed: string[] = [];
      const context: CommandActionContext = { ...options.context, print: (message: string) => { printed.push(message); }, printLive: undefined };
      if (resolved.daemon && options.capabilityBinding) {
        // A daemon capability no slash command carries: asked of the daemon here, as the owner's own press, so the
        // whole answer is read (a value to see once comes back as its reveal, never as a line). What this program does
        // itself around it (a plugin started here, a made file opened here) runs as for a typed line.
        try {
          const answer = await runDaemonCapabilityHere(id, values, context as never, options.capabilityBinding);
          const said = answer.detail ?? '';
          return { ok: true, lines: said.split('\n').filter((line) => line.trim() !== ''), ...(answer.reveal ? { reveal: answer.reveal } : {}) };
        } catch (error) {
          return { ok: false, reason: reasonOf(error) };
        }
      }
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
