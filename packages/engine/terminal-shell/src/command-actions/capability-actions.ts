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
  CAPABILITY_RUN_METHOD_ID, CapabilityRefusal,
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

interface CapabilityAnswer {
  readonly text?: string | undefined;
  readonly detail?: string | undefined;
  readonly data?: Readonly<Record<string, unknown>> | undefined;
}

/** A daemon refusal in the person's words: the method's prefix taken off, the daemon's own next step kept. */
function refusalOf(error: unknown): Error {
  const message = summarizeError(error).replace(/^'capabilities\.run' failed:\s*/, '');
  const next = (error as { readonly next?: unknown } | null)?.next;
  return commandRefusal(message, Array.isArray(next) && typeof next[0] === 'string' ? next[0] : undefined);
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
    touches: definition.touches,
    lasts: definition.lasts,
    risk: definition.risk,
    ...(definition.riskDone ? { riskDone: definition.riskDone } : {}),
    ...(definition.ownerOnly ? { ownerOnly: definition.ownerOnly } : {}),
    ...(definition.undoneBy ? { undoneBy: definition.undoneBy } : {}),
    ...(definition.button ? { button: definition.button } : {}),
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
      const answer = await runDaemonCapability(id, values, ctx, binding);
      return answer.detail ?? '';
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
        result = await definition.run(values, services(ctx), {});
      } catch (error) {
        if (error instanceof CapabilityRefusal) throw commandRefusal(error.message, error.next);
        throw error;
      }
      options.after?.(ctx, result);
      return result.text;
    },
  };
}
