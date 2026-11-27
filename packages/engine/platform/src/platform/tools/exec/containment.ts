/**
 * containment.ts, whether a composition REQUIRES the exec boundary, or merely
 * prefers it.
 *
 * ── The gap this closes ────────────────────────────────────────────────────
 *
 * `resolveExecSandboxPlan` (sandbox.ts) answers "is there a boundary for this
 * command", and when the answer is no, the capability gate is off, the
 * `sandbox.enabled` switch is off, or the host cannot provide a boundary, the
 * exec runtime falls back to running the command directly on the host and says
 * so in `sandbox_note`. For a terminal that a person is sitting in front of,
 * that fallback is right: the person asked for the command, and an honest
 * "this ran on the host" is better than a refusal they did not ask for.
 *
 * For a turn that nobody is sitting in front of it is exactly wrong. A
 * conversational turn hosted by the daemon reached a full host process table,
 * the owner's `/proc`, and their terminal multiplexer, because the boundary was
 * not applied and the fallback was silent. Nothing in the composition said the
 * boundary was REQUIRED, so nothing refused when it was absent.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 *
 * A composition states one of two postures:
 *
 *  - `host-allowed`, the historical behaviour, unchanged byte for byte: no
 *    boundary means the command runs on the host with the self-labelling note.
 *    This is what a terminal composes.
 *  - `required`, no boundary means no command. The refusal names why the
 *    boundary was absent, so the fix is legible (install bubblewrap, turn
 *    `sandbox.enabled` back on) rather than a shrug.
 *
 * `required` is what a hosted CONVERSATIONAL turn composes. A hosted
 * WORKSTREAM that genuinely needs the host, a build that must reach the
 * machine's own daemon, a diagnostic that must read the real process table,
 * is granted `host-allowed` explicitly, per spawn, by the product composing
 * that spawn. There is no path by which a conversational turn acquires it: the
 * posture arrives from the composition, never from the model, the wire, or a
 * tool argument. The edit and write tools' validators (`validate.before/after`)
 * run through the same exec path (exec/runtime.ts createExecValidatorRunner),
 * so they are held to the same posture: there is no second spawn site.
 *
 * This layer NEVER turns a refusal into an allow. It can only refuse a command
 * the sandbox layer was willing to run uncontained. The frozen catastrophic
 * block is enforced independently (ast-guard.ts) and is untouched here.
 */

import type { ExecSandboxPlan } from './sandbox.js';
import type { Containment } from '../../runtime/sandbox/contained-spawn.js';
import { partyOfCall, type TurnInputParty } from '../../security/turn-input-party.js';

/**
 * Whether a composition requires the exec boundary: the same posture every
 * contained spawn states (runtime/sandbox/contained-spawn.ts `Containment`).
 * `required`: no boundary, the command is refused (what a hosted
 * conversational turn composes). `host-allowed`: no boundary, the command runs
 * on the host with the self-labelling note (the default).
 *
 * See the module header. Default everywhere is `host-allowed`, so adding this
 * concept changes nothing for a caller that does not state a posture.
 */
export type ExecContainmentPosture = Containment['boundary'];

/** What a composition states about containment, and why. */
export interface ExecContainmentRequirement {
  readonly posture: ExecContainmentPosture;
  /**
   * Why this composition requires containment, in the composition's own words.
   * Named in the refusal so the person reading it learns which turn refused
   * and on what grounds, not merely that something refused.
   *
   * Ignored when the posture is `host-allowed`.
   */
  readonly reason: string;
}

/**
 * The ONE rule for a turn's commands, whichever door the turn came through (a terminal program, the Agent, the web
 * chat, a schedule or trigger, handed-off work, a hosted session): the shared `sandbox.*` setting decides whether a
 * command runs inside the boundary, and the permission gate under the owner's mode decides whether it runs at all
 * (an ask nobody is present for waits for the owner in Waiting for you). No door refuses a command the others would run.
 * The one exception is who the input came from, not the door: a turn acting on someone else's input is held to the
 * boundary at the command ({@link containmentForTurn}).
 */
export const TURN_EXEC_CONTAINMENT: ExecContainmentRequirement = {
  posture: 'host-allowed',
  reason: 'every turn runs its commands under the shared sandbox setting and the owner\'s mode',
};

/**
 * The requirement a command is judged against in the turn it runs in: the composition's own, unless the turn is
 * acting on someone else's input (security/turn-input-party.ts, the one place that is decided). Then the boundary is
 * REQUIRED whatever the composition or the mode says: no real sandbox, no command. Read at the command, not at
 * composition, because one project's registry serves the owner's turns and other people's alike.
 */
export function containmentForTurn(
  requirement: ExecContainmentRequirement | null | undefined,
  party: TurnInputParty = partyOfCall(),
): ExecContainmentRequirement | null | undefined {
  if (party.party === 'owner') return requirement;
  return {
    posture: 'required',
    reason: `this turn acts on someone else's input (${party.who}), so it runs commands only inside a real sandbox and writes no file, whatever the mode`,
  };
}

/**
 * Whether a command of this turn writes no file anyone keeps: a turn on someone else's input. Its boundary binds its
 * project read-only and none of the owner's `sandbox.workspaceWritable` extras (sandbox.ts `readOnly`); only the
 * command's private /tmp takes writes. With {@link containmentForTurn} requiring the boundary, "writes no file" holds
 * for its commands as it does for write and edit ({@link foreignInputWriteRefusal}).
 */
export function turnWritesNoFile(party: TurnInputParty = partyOfCall()): boolean {
  return party.party !== 'owner';
}

/**
 * The refusal a file write or edit gets in a turn acting on someone else's input, or null when it may go on (the
 * owner's turn: the gate under their mode decides it). Such a turn writes no file outside a real sandbox, and the write
 * and edit tools have none: what it may change it proposes to the owner instead.
 */
export function foreignInputWriteRefusal(tool: string, party: TurnInputParty = partyOfCall()): string | null {
  if (party.party === 'owner') return null;
  return `Tool '${tool}' was refused: this turn acts on someone else's input (${party.who}), and such a turn writes no `
    + 'file outside a real sandbox, whatever the mode. Say what you would change, and the owner can make the change themselves.';
}

/** The verdict for one command. */
export interface ExecContainmentDecision {
  /** False ⇒ the command must not run. */
  readonly allowed: boolean;
  /** Present when `allowed` is false: the plain refusal, ready to return. */
  readonly refusal?: string | undefined;
}

const ALLOWED: ExecContainmentDecision = { allowed: true };

/**
 * Why the boundary was absent, from the plan the sandbox layer produced.
 *
 * A plan carries `unavailableReason` only when the boundary was WANTED and the
 * host could not provide it. When the capability was never asked for at all
 * (gate off, `sandbox.enabled` false, or no sandbox wired into this exec tool),
 * there is no host reason to quote and the plan's own `boundary` line is the
 * honest answer.
 */
function absenceReason(plan: ExecSandboxPlan | null): string {
  if (plan === null) return 'no exec sandbox is wired into this session';
  if (plan.unavailableReason) return plan.unavailableReason;
  return plan.boundary;
}

/**
 * Decide whether a command may run given the composition's containment posture
 * and the boundary the sandbox layer actually resolved. Pure.
 *
 * @param requirement - The composition's stated posture. `undefined` reads as
 *   `host-allowed`, an omitted posture must never tighten a caller's behaviour.
 * @param plan - The resolved sandbox plan, or null when no sandbox is wired.
 */
export function decideExecContainment(
  requirement: ExecContainmentRequirement | null | undefined,
  plan: ExecSandboxPlan | null,
): ExecContainmentDecision {
  if (!requirement || requirement.posture !== 'required') return ALLOWED;
  if (plan?.sandboxed === true) return ALLOWED;
  return {
    allowed: false,
    refusal:
      'Command refused: this session requires commands to run inside the exec boundary, '
      + `and no boundary was applied, ${absenceReason(plan)}.\n`
      + `Why this session requires it: ${requirement.reason}\n`
      + 'Running on the host instead is not a fallback available here. Report the state '
      + 'and what you would need, rather than reaching for another way round.',
  };
}
