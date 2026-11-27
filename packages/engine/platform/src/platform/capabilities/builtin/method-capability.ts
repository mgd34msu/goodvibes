/**
 * A capability that runs through a daemon method of its own (MOVING-A-CAPABILITY.md, step 2: "for an action that
 * already has its own daemon method you do not write a handler"), defined here in the registry rather than only on
 * a slash command's action. Its words (label, sentence, inputs, risk) are the definition's; `method` says which
 * method runs it and which input fills which of its fields. Find, `capabilities.run`, `capability_run` and the
 * daemon's own turns treat it as every other action with a method (its entry carries `method` and it is not a
 * handler capability, so `daemonCapability` does not return it): the method keeps its own effects, confirmation
 * and repeat. Because it stands in the registry, it stays found and run when no slash command carries it.
 */
import { entryOfDefinition, type CapabilityEntry } from '../catalog.js';
import type { CapabilityMethod } from '../operator-input.js';
import type { ActionValues, CapabilityDefinition } from '../types.js';

export interface MethodCapabilityDefinition extends Omit<CapabilityDefinition<never>, 'run'> {
  readonly method: CapabilityMethod;
  /**
   * The result in the capability's own words, from the method's answer (what ran and how it came out), given as
   * `capabilities.run`'s `detail` and after its done line, so a model, a script and a place read more than "done".
   * The answer is data from the daemon: read it defensively. Absent: the done line says it all.
   */
  readonly said?: ((answer: Readonly<Record<string, unknown>>, values: ActionValues) => string) | undefined;
  /**
   * What this run did about what the risk names, from the method's answer, when not every run does it (a check-in that
   * stayed quiet sent nothing): said after it in place of the risk's words; '' says nothing; undefined keeps the
   * definition's line (outcome.ts `riskDoneLine`).
   */
  readonly did?: ((answer: Readonly<Record<string, unknown>>, values: ActionValues) => string | undefined) | undefined;
  /**
   * A value in the method's answer that the person must see once (the definition's `reveals` names it): given to the
   * reveal pane and never to the words, the data or a log. Absent: the answer carries none.
   */
  readonly reveal?: ((answer: Readonly<Record<string, unknown>>, values: ActionValues) => { readonly value: string; readonly qr?: string | undefined } | undefined) | undefined;
  /** The fields of the method's answer that are that value: taken out of the result's data, which a script, a model and a log keep. */
  readonly oneTime?: readonly string[] | undefined;
}

/** The catalog entry of a capability that runs through its own method. */
export function methodCapabilityEntry(definition: MethodCapabilityDefinition, command: { readonly name: string; readonly title: string }): CapabilityEntry {
  const { method, ...words } = definition;
  // The catalog reads an action's method from its `operator`, as for a described action.
  const operator = { method: method.id, fields: method.fields, ...(method.preview ? { preview: method.preview } : {}), ...(method.project ? { project: true as const } : {}) };
  return entryOfDefinition({ ...words, operator } as unknown as CapabilityDefinition<never>, command);
}
