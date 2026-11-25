/**
 * A capability input declared secret (a password, a key) is taken out of a
 * model's `capability_run` call before anything keeps or shows the call: the
 * registry projects the call here first, so the conversation, the gate's ask,
 * the approval record, `approvals.list`, the frames sent to clients and every
 * log see the value as hidden, with its length only. The value itself stays
 * with this projection and is given back only to the tool body running that
 * exact admitted call (`revealSecretInputs`).
 */
import { hiddenSecret } from '../../capabilities/outcome.js';
import { assertProjectionExecution, captureProjectionArgs, ToolInputProjectionError, type ToolInputProjectionRequest, type ToolInputProjector } from '../input-projection.js';

interface HeldSecrets {
  /** Input id to its value, for the call's `inputs`. */
  readonly values: ReadonlyMap<string, string>;
  /** The hidden form each was replaced by, which the executed call must still carry. */
  readonly shown: ReadonlyMap<string, string>;
  released: boolean;
}

const held = new WeakMap<object, HeldSecrets>();

function inputsOf(args: Record<string, unknown>): Record<string, unknown> | undefined {
  const inputs = args['inputs'];
  return inputs !== null && typeof inputs === 'object' && !Array.isArray(inputs) ? inputs as Record<string, unknown> : undefined;
}

/**
 * The projector for `capability_run`: `secretInputsOf(id, inputs)` names the inputs of
 * the capability a call names that are secret with the inputs the call gives (none for an
 * unknown id or a daemon method id; an input secret only for some values, such as a
 * setting's new value only when the setting holds a credential, `plainWhen`, is named only then).
 */
export function createSecretInputProjector(secretInputsOf: (id: string, inputs: Readonly<Record<string, string>>) => readonly string[]): ToolInputProjector {
  return Object.freeze({
    async project(request: ToolInputProjectionRequest) {
      request.assertCurrent();
      const args = captureProjectionArgs(request.args, request.name);
      const id = typeof args['id'] === 'string' ? args['id'].trim() : '';
      const inputs = inputsOf(args);
      const given = Object.fromEntries(Object.entries(inputs ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      const secret = id && inputs ? secretInputsOf(id, given).filter((input) => typeof inputs[input] === 'string' && inputs[input] !== '') : [];
      if (secret.length === 0) return { status: 'projected' as const, args };
      const values = new Map<string, string>();
      const shown = new Map<string, string>();
      const projectedInputs: Record<string, unknown> = { ...inputs };
      for (const input of secret) {
        const value = inputs![input] as string;
        values.set(input, value);
        shown.set(input, hiddenSecret(value));
        projectedInputs[input] = hiddenSecret(value);
      }
      const executionContext = Object.freeze({});
      const record: HeldSecrets = { values, shown, released: false };
      held.set(executionContext, record);
      const projected = Object.freeze({ ...args, inputs: Object.freeze(projectedInputs) });
      return {
        status: 'projected' as const,
        args: projected,
        executionContext,
        assertRepairedArgs(effective: Record<string, unknown>) {
          // A repaired call keeps the same capability and the same hidden values, or it is refused.
          const effectiveInputs = inputsOf(effective);
          if (effective['id'] !== args['id'] || !effectiveInputs) throw new ToolInputProjectionError('binding-changed');
          for (const [input, form] of shown) if (effectiveInputs[input] !== form) throw new ToolInputProjectionError('binding-changed');
        },
        async release() {
          record.released = true;
          held.delete(executionContext);
        },
      };
    },
  });
}

/**
 * The call's inputs with each secret one's value put back, for the body
 * running this admitted call; the inputs as given when nothing was held.
 */
export function revealSecretInputs(context: object | undefined, args: Record<string, unknown>): Record<string, unknown> {
  const inputs = inputsOf(args) ?? {};
  const record = context ? held.get(context) : undefined;
  if (!record) return inputs;
  if (record.released) throw new ToolInputProjectionError('stale');
  assertProjectionExecution(context!, args);
  const revealed: Record<string, unknown> = { ...inputs };
  for (const [input, value] of record.values) {
    if (inputs[input] !== record.shown.get(input)) throw new ToolInputProjectionError('binding-changed');
    revealed[input] = value;
  }
  return revealed;
}
