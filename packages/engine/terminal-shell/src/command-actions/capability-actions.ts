/**
 * A slash command's action built from a capability that moved beside its
 * handler in the platform (capabilities/builtin): the description is the
 * definition's, so the typed line, the form, the help, the web UI's sheet and
 * find all read the same words, and `run` calls the same function the model
 * and a script reach:
 *
 *  - home `daemon`: the action asks the daemon (`capabilities.run`), as a
 *    person's request when a person typed it or pressed it; there is no
 *    in-process path. The web UI's sheet runs the same method.
 *  - home `session`: the action runs the definition here, with this
 *    program's live conversation.
 */
import {
  CAPABILITY_RUN_METHOD_ID, CapabilityRefusal, runHoldingPaths,
  type CapabilityCaller, type CapabilityDefinition, type CapabilityResult,
} from '@goodvibes/engine/platform/platform/capabilities';
import type { DaemonVerbCaller } from '@goodvibes/engine/platform/platform/runtime/client';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import { commandRefusal } from '../command-confirmation.js';
import type { ActionDescription, ActionValues, CommandActionContext } from './types.js';

/** How a daemon capability's slash action reaches the daemon, and who is asking. */
export interface DaemonCapabilityBinding<Ctx> {
  readonly daemon: (ctx: Ctx) => DaemonVerbCaller;
  /** The caller's project and program, for a capability that acts on them (a hooks file, a project secret store). */
  readonly caller: (ctx: Ctx) => CapabilityCaller;
}

export interface CapabilityAnswer {
  readonly text?: string | undefined;
  readonly detail?: string | undefined;
  readonly data?: Readonly<Record<string, unknown>> | undefined;
  /** The value the person must see once (types.ts `reveals`), returned only to the person who asked. */
  readonly reveal?: CapabilityRevealed | undefined;
}

/** A revealed value with what its pane says about it. */
export interface CapabilityRevealed {
  readonly label: string;
  readonly note: string;
  readonly value: string;
  readonly qr?: string | undefined;
}

/** A daemon refusal in the person's words: the method's prefix taken off, the daemon's own next step kept. */
function refusalOf(error: unknown): Error {
  const message = summarizeError(error).replace(/^'capabilities\.run' failed:\s*/, '');
  const next = (error as { readonly next?: unknown } | null)?.next;
  return commandRefusal(message, Array.isArray(next) && typeof next[0] === 'string' ? next[0] : undefined, undefined, error);
}

function describedFrom<Ctx>(definition: CapabilityDefinition<never>): Omit<ActionDescription<Ctx>, 'run' | 'operator'> {
  return {
    id: definition.actionId,
    capability: definition.capability,
    label: definition.label,
    word: definition.word,
    inputs: definition.inputs,
    sentence: definition.sentence,
    done: definition.done,
    ...(definition.doneInPlace ? { doneInPlace: definition.doneInPlace } : {}),
    touches: definition.touches,
    lasts: definition.lasts,
    risk: definition.risk,
    ...(definition.riskDone ? { riskDone: definition.riskDone } : {}),
    ...(definition.ownerOnly ? { ownerOnly: definition.ownerOnly } : {}),
    ...(definition.loosensIf ? { loosensIf: definition.loosensIf } : {}),
    ...(definition.irreversibleWhen ? { irreversibleWhen: definition.irreversibleWhen } : {}),
    ...(definition.sentenceWhen ? { sentenceWhen: definition.sentenceWhen } : {}),
    ...(definition.question ? { question: definition.question } : {}),
    ...(definition.undoneBy ? { undoneBy: definition.undoneBy } : {}),
    ...(definition.button ? { button: definition.button } : {}),
    ...(definition.asksItself ? { asksItself: definition.asksItself } : {}),
    ...(definition.reveals ? { reveals: definition.reveals } : {}),
    example: definition.example,
  };
}

/** Ask the daemon to run a daemon capability, as a person's request unless a model ran the line. */
export async function runDaemonCapability<Ctx extends CommandActionContext>(
  id: string, values: ActionValues, ctx: Ctx, binding: DaemonCapabilityBinding<Ctx>,
): Promise<CapabilityAnswer> {
  try {
    return await binding.daemon(ctx).invoke<CapabilityAnswer>(CAPABILITY_RUN_METHOD_ID, { id, inputs: values, ...binding.caller(ctx) },
      { explicitUserRequest: ctx.invokedByModel !== true });
  } catch (error) {
    throw refusalOf(error);
  }
}

/** The slash action of a capability whose home is the daemon. */
export function daemonCapabilityAction<Ctx extends CommandActionContext>(
  definition: CapabilityDefinition<never>,
  binding: DaemonCapabilityBinding<Ctx>,
): ActionDescription<Ctx> {
  const id = definition.capability.id;
  return {
    ...describedFrom<Ctx>(definition),
    // The web UI's sheet runs the same capability through the same method.
    operator: {
      method: CAPABILITY_RUN_METHOD_ID,
      fields: { id: `=${JSON.stringify(id)}`, ...Object.fromEntries(definition.inputs.map((input) => [`inputs.${input.id}`, input.id])) },
    },
    async run(values, ctx) {
      const answer = await runDaemonCapabilityHere(id, values, ctx, binding);
      return answer.detail ?? '';
    },
  };
}

/**
 * A daemon capability run from this program (a typed line, a form, a place's control), with what this program does
 * itself around the daemon's change (programSideOf: a plugin stopped here before it is switched off, started here
 * after; a file the person made opened here). A line the program side says is added to the answer's words.
 */
export async function runDaemonCapabilityHere<Ctx extends CommandActionContext>(
  id: string, values: ActionValues, ctx: Ctx, binding: DaemonCapabilityBinding<Ctx>,
): Promise<CapabilityAnswer> {
  const around = PROGRAM_SIDE.get(id);
  await around?.before?.(values, ctx);
  const answer = await runDaemonCapability(id, values, ctx, binding);
  const said = await around?.after?.(values, ctx, answer);
  if (!said) return answer;
  const words = answer.detail ?? answer.text ?? '';
  return { ...answer, detail: words ? `${words}\n${said}` : said };
}

/** What the program holding the conversation does itself, before or after a daemon capability changed something it runs. */
export interface ProgramSide {
  readonly before?: ((values: ActionValues, ctx: CommandActionContext) => Promise<void> | void) | undefined;
  /** After the daemon answered: the answer is given; a line returned is said with it. */
  readonly after?: ((values: ActionValues, ctx: CommandActionContext, answer: CapabilityAnswer) => Promise<string | void> | string | void) | undefined;
}
const PROGRAM_SIDE = new Map<string, ProgramSide>();

/**
 * Name what this program does around a daemon capability, wherever its action
 * runs from here (a typed line, a place, a form): the daemon keeps the thing,
 * and the program starts or stops what it runs of it. A model's or a script's
 * call through the daemon does not reach it; that program applies the change
 * the next time it starts the thing.
 */
export function programSideOf(id: string, side: ProgramSide): void {
  PROGRAM_SIDE.set(id, side);
}

/**
 * The words of a capability defined in the platform (label, word, inputs, sentence, risk, ...), for a slash action
 * that keeps its own `run` and `operator` while its command still carries it: the typed line, the form, the web
 * UI's sheet and find then read one set of words.
 */
export function capabilityWords<Ctx>(definition: Omit<CapabilityDefinition<never>, 'run'>): Omit<ActionDescription<Ctx>, 'run' | 'operator'> {
  return describedFrom<Ctx>(definition as CapabilityDefinition<never>);
}

/**
 * The action of a capability that runs through its own daemon method (builtin/method-capability.ts), for a place
 * whose capability no slash command carries: it asks the daemon (`capabilities.run`, which runs that method), as a
 * person's request unless a model ran it, and says what the daemon answered.
 */
export function methodCapabilityAction<Ctx extends CommandActionContext>(
  definition: Omit<CapabilityDefinition<never>, 'run'>,
  binding: DaemonCapabilityBinding<Ctx>,
): ActionDescription<Ctx> {
  const id = definition.capability.id;
  return {
    ...describedFrom<Ctx>(definition as CapabilityDefinition<never>),
    operator: {
      method: CAPABILITY_RUN_METHOD_ID,
      fields: { id: `=${JSON.stringify(id)}`, ...Object.fromEntries(definition.inputs.map((input) => [`inputs.${input.id}`, input.id])) },
    },
    async run(values, ctx) {
      const answer = await runDaemonCapability(id, values, ctx, binding);
      return answer.detail ?? answer.text ?? '';
    },
  };
}

/** The slash action of a capability whose home is the program holding the conversation. */
export function sessionCapabilityAction<Ctx extends CommandActionContext, Services>(
  definition: CapabilityDefinition<Services>,
  services: (ctx: Ctx) => Services,
  options: { readonly terminalOnly: string; readonly after?: ((ctx: Ctx, result: CapabilityResult) => void) | undefined },
): ActionDescription<Ctx> {
  return {
    ...describedFrom<Ctx>(definition as CapabilityDefinition<never>),
    operator: { terminalOnly: options.terminalOnly },
    async run(values, ctx) {
      let result: CapabilityResult;
      try {
        // The person's own request unless a model ran the line, as a daemon capability is asked (runDaemonCapability).
        // A file named by path is held from its check to its use (capabilities/held-paths.ts).
        result = await runHoldingPaths(() => definition.run(values, services(ctx), { personAsked: ctx.invokedByModel !== true }));
      } catch (error) {
        if (error instanceof CapabilityRefusal) throw commandRefusal(error.message, error.next);
        throw error;
      }
      options.after?.(ctx, result);
      return result.text;
    },
  };
}
