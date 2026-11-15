/**
 * What host access a shell command needs, read by Jev.
 *
 * This module used to classify every segment into read, write, network,
 * destructive or escalation by fixed sets of binary and subcommand names, plus
 * a frozen catastrophic list and a dangerous-pattern list. Each of those was a
 * judgment about what a command does made by name matching, and a script, an
 * alias or an unlisted binary walked past every one. The questions they
 * answered are now readings: whether a command is catastrophic is the gate's
 * boundary reading (gate/batteries/boundary.ts), what it changes and how much
 * is at stake is the gate's stakes reading, and what host access it needs
 * inside the sandbox is `engine.gate.sandbox-needs`, read here.
 */
import { JudgmentAuthorityRetiredError, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { sandboxNeeds } from '../../../gate/batteries/sandbox-needs.js';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { forgetProcessJudgments, judge } from '../../judge.js';

export interface CommandNeeds {
  /** No host-access assessment was taken (decision models off, no answer within the deadline, or none available); the sandbox policy must ask the owner. */
  readonly provenance?: 'classic';
  /** It reaches the network (uncertain readings count as yes); null means unassessed. */
  readonly needsNetwork: boolean | null;
  /** It needs host administrator privileges (uncertain readings count as yes); null means unassessed. */
  readonly needsPrivilege: boolean | null;
}

const UNASSESSED: CommandNeeds = Object.freeze({ needsNetwork: null, needsPrivilege: null, provenance: 'classic' as const });

/** The decision site the sandbox's command readings are logged under. */
export const COMMAND_NEEDS_SITE = 'engine.gate.sandbox-needs';

/**
 * One reading per command and workspace for the life of the process. With no
 * answer within the decision deadline, or with decision models off, the
 * command is unassessed and the sandbox policy asks.
 */
export async function readCommandNeeds(
  command: string,
  workspace?: string,
  options: Pick<JudgmentReadingOptions, 'signal' | 'assertCurrent'> = {},
): Promise<CommandNeeds> {
  const { value } = await judge({
    site: COMMAND_NEEDS_SITE,
    battery: sandboxNeeds,
    state: { command, ...(workspace ? { workspace } : {}) },
    cache: { key: JSON.stringify([workspace ?? '', command]), scope: 'process' },
    // An uncertain reading counts as needing the access: a wrong yes costs one ask.
    settle: (readings): CommandNeeds => Object.freeze({
      needsNetwork: readings.needsNetwork.verdict !== 'no',
      needsPrivilege: readings.needsPrivilege.verdict !== 'no',
    }),
    fallback: () => UNASSESSED,
    describe: needs => `network:${needs.needsNetwork} privilege:${needs.needsPrivilege}`,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  // The caller's own operation may have ended while the reading ran.
  let restriction: unknown;
  try { restriction = options.assertCurrent?.(); }
  catch (error) { drainOwned(error); throw new JudgmentAuthorityRetiredError(); }
  if (restriction !== undefined) { drainOwned(restriction); throw new JudgmentAuthorityRetiredError(); }
  return value;
}

/** Forgets every remembered reading (tests, and a settings change that alters the model). */
export function forgetCommandNeeds(): void {
  forgetProcessJudgments();
}
