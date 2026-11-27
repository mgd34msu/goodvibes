/**
 * command-line-hold.ts, the capabilities a command line never runs with a person's claim: one that weakens a
 * protection (installing something that runs by itself included: a hook, a schedule, a file named by path that a
 * program runs by itself later, risk.ts), cannot be undone, spends money, writes a secret, writes what steers a model
 * (a memory record, a persona or the one in use, a note, a routine, a skill: CapabilityDefinition `steersModel`), or is
 * the owner's own act. Such a `do` (`goodvibes do`, `goodvibes-agent do`, `goodvibes-daemon do`, the forms built on
 * them) is held for the owner and answered in Waiting for you, opening on No, worded by the daemon: a y at a terminal
 * can be typed by anything that can drive a terminal (`tmux send-keys`, `ssh -tt localhost`, `script`), so a terminal
 * is never asked. Every other capability typed at a terminal runs at once, as the person typed it.
 *
 * One rule, read by the command line before it sends the call (terminal-shell capability-cli.ts) and by the daemon
 * when a call arrives from the command-line client kind (control-plane/routes/capabilities.ts), so a command line that
 * sends the claim anyway is still held.
 */
import { capabilityEffects, effectiveRisk, withDefaults, type CapabilityEntry } from './catalog.js';

/** The client kind a command line names itself with (`x-goodvibes-client: cli`): `do` and `find` on any program's command line. */
export const COMMAND_LINE_CLIENT_KIND = 'cli';

/**
 * Why a call from a command line is held for the owner, in words ("it loosens a protection, it writes a secret"), or
 * undefined when it runs at once. `loosensIf`: the capability's own rule for values that loosen, when its entry does
 * not carry it. `steersModel`: the capability's definition says it writes what steers a model.
 */
export function commandLineHoldReason(
  entry: Pick<CapabilityEntry, 'risk' | 'inputs' | 'touches' | 'ownerOnly' | 'effects' | 'loosensIf' | 'irreversibleWhen'> & Partial<Pick<CapabilityEntry, 'secretWhen'>>,
  given: Readonly<Record<string, string>>,
  loosensIf?: ((values: Readonly<Record<string, string>>) => boolean) | undefined,
  steersModel?: boolean | undefined,
): string | undefined {
  const values = withDefaults(entry, given);
  let risk = effectiveRisk(entry, values);
  if (risk === 'none' && loosensIf?.(values) === true) risk = 'loosens-a-protection';
  const why: string[] = [];
  if (risk === 'loosens-a-protection') why.push('it loosens a protection');
  if (risk === 'cannot-be-undone') why.push('it cannot be undone');
  if (risk === 'spends-money') why.push('it spends money');
  if (entry.touches === 'credential' || capabilityEffects(entry, values).includes('secret.write')) why.push('it writes a secret');
  if (steersModel === true) why.push('it writes what steers a model in your turns');
  if (entry.ownerOnly) why.push('it is an act only you make');
  return why.length === 0 ? undefined : why.join(', ');
}
