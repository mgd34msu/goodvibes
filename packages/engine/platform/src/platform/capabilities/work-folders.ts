/**
 * work-folders.ts, which inputs of a daemon capability name a folder a turn or a process will work in (a hosted agent's
 * folder, the folders a tool server may use): the daemon's dispatch checks each as a project the caller may name
 * (daemon/control-plane.ts, through `capabilityWorkFolders`), as it checks a method's declared `workFolders`. Every
 * `path` input that names a folder states whether it is one (`InputDescription.workFolder`); one that does not stops
 * the catalog at load, so a new folder input cannot be added unchecked.
 */
import type { InputDescription } from './types.js';

/** The ids and labels that name a folder. */
const FOLDER_ID = /^(dir|directory|folder|root|cwd|workingDirectory|workspace)$/;
const FOLDER_LABEL = /folder/i;

function namesFolder(input: Pick<InputDescription, 'id' | 'label' | 'kind'>): boolean {
  return input.kind === 'path' && (FOLDER_ID.test(input.id) || FOLDER_LABEL.test(input.label));
}

interface Declared {
  readonly capability: { readonly id: string };
  readonly inputs: readonly Pick<InputDescription, 'id' | 'label' | 'kind' | 'workFolder'>[];
}

/** Refuses to load a catalog with a folder input that does not state whether a turn or process works in it. */
export function assertWorkFoldersDeclared(definitions: readonly Declared[]): void {
  const undeclared = definitions.flatMap((definition) => definition.inputs
    .filter((input) => namesFolder(input) && input.workFolder === undefined)
    .map((input) => `${definition.capability.id} ${input.id}`));
  if (undeclared.length > 0) {
    throw new Error(`Capabilities take a folder without stating whether a turn or process works in it (workFolder): ${undeclared.join(', ')}.`);
  }
}

/** The ids of a capability's inputs a turn or process works in. */
export function workFolderInputsOf(definition: Declared | undefined): readonly string[] {
  return definition ? definition.inputs.filter((input) => input.workFolder === true).map((input) => input.id) : [];
}
