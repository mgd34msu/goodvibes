/**
 * The shape of the generated command actions (lib/generated/command-actions.ts),
 * which the engine writes from the terminal apps' command descriptions. The
 * web UI draws its action sheets and buttons from it and never writes an
 * action's name, blanks or sentence by hand.
 */
import type {
  ActionRisk,
  ActionShape,
  CommandShape,
  FixedChoice,
  InputDescription,
  ListRowsFromOutput,
} from '@goodvibes/engine/terminal-shell/command-actions/data';
import type { CapabilityDeclaration } from '@goodvibes/engine/platform/platform/capabilities';

export type { ActionRisk, FixedChoice };

/** A blank as data. A list's name is plain text here (its type-level brand does not survive JSON). */
export type InputData = Omit<InputDescription, 'choices'> & {
  readonly choices?: readonly FixedChoice[] | { readonly list: string; readonly dependsOn?: string; readonly allowOther?: { readonly reason: string } };
};

export type ListOperatorData =
  | { readonly method: string; readonly input: Readonly<Record<string, string>>; readonly rows: ListRowsFromOutput }
  | { readonly terminalOnly: string };

export interface ActionData extends Omit<ActionShape, 'inputs'> {
  readonly line: string;
  readonly touches: 'reads' | 'this-machine' | 'another-machine' | 'credential';
  readonly riskWords?: string;
  readonly ownerOnly?: { readonly reason: string; readonly instead: string };
  readonly undoneBy?: string;
  /** `preview`: a method that reads the values first and answers `{ summary, input }` (see the engine's ActionDescription.operator). */
  readonly operator: { readonly method: string; readonly fields: Readonly<Record<string, string>>; readonly preview?: string } | { readonly terminalOnly: string };
  readonly inputs: readonly InputData[];
  /** A question heading each form step, by step (index 0 is step 1). */
  readonly stepTitles?: readonly string[];
  /** An action that has moved beside its handler: its capability declaration (id, group, home, what a repeat does). */
  readonly capability?: CapabilityDeclaration;
}

export interface CommandActionsData {
  readonly name: string;
  readonly title: string;
  readonly summary: string;
  readonly group: string;
  readonly report?: string;
  readonly actions: readonly ActionData[];
}

export interface CommandActionsSnapshot {
  readonly commands: readonly CommandActionsData[];
  /** The capabilities no slash command carries, by the command each names: drawn as sheets, never typed. */
  readonly capabilities?: readonly CommandActionsData[];
  readonly lists: Readonly<Record<string, ListOperatorData>>;
}

/**
 * The engine's line and sentence functions read the same fields; only a
 * list's branded name differs, and they never read it.
 */
export function asActionShape(action: ActionData): ActionShape {
  return action as unknown as ActionShape;
}
export function asCommandShape(command: CommandActionsData): CommandShape {
  return command as unknown as CommandShape;
}
