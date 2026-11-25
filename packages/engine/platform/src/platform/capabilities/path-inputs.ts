/**
 * path-inputs.ts, where a file a capability is given by path may be: for anyone but the person himself (a model, a
 * paired device, a script, another agent), inside the caller's project, as the file really is (a link in the project,
 * `/proc/self/root`, `~` or `..` followed to what it names). Checked at every door before anything is asked or run:
 * `capabilities.run` (control-plane/routes/capabilities.ts), the program's `capability_run`
 * (terminal-shell agent-turn/capability-tools.ts) and the daemon's own turns (tools/capability/daemon-tools.ts). The
 * person names any file himself, from his own terminal or screen.
 */
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { CapabilityRefusal, type CapabilityCaller, type CapabilityEntry } from './types.js';

/**
 * Where a path really is: its real path when it exists, else its nearest existing folder's real path with the rest
 * after it, so a link is followed to what it names whether or not the file is there yet.
 */
export function realPathOf(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  const rest: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(existing), ...[...rest].reverse());
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return absolute;
      rest.push(basename(existing));
      existing = parent;
    }
  }
}

/** Whether `path` is `root` or inside it (both as given; pass real paths). */
export function pathWithin(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** A path as the caller's program would read it: `~` and `~/` are the home folder; `~user` is someone's home, never the project. */
function expanded(raw: string, project: string): string | undefined {
  if (raw === '~' || raw.startsWith('~/')) {
    const home = process.env['HOME'];
    return home ? resolve(home, raw.slice(2)) : undefined;
  }
  if (raw.startsWith('~')) return undefined;
  return isAbsolute(raw) ? raw : resolve(project, raw);
}

/**
 * Why a path input of this call may not be used by this caller, or undefined when every one may: each input of kind
 * `path` with a value, for a caller who is not the person, must be inside the caller's project.
 */
export function pathInputsRefusal(entry: Pick<CapabilityEntry, 'id' | 'inputs'>, values: Readonly<Record<string, string | undefined>>, caller: CapabilityCaller): CapabilityRefusal | undefined {
  // The file is on the machine of the program asking, which reads and writes it there itself and sends or receives its
  // content (terminal-shell bundle-file-work.ts): the daemon never acts on that path.
  if (values['filesAt'] === 'program') return undefined;
  for (const input of entry.inputs) {
    if (input.kind !== 'path') continue;
    const raw = (values[input.id] ?? '').trim();
    if (raw === '') continue;
    // A path named by a caller on another machine names a file on that machine: the daemon acts on a path only for a
    // caller on its own machine, whoever asks (the person too).
    if (caller.elsewhere === true) {
      return new CapabilityRefusal(`Not done: ${input.label} names ${raw}, a file on the machine that asked, not on this daemon's machine; the daemon reads and writes a file by path only for a caller on its own machine.`,
        'The program on that machine reads or writes the file there itself and sends or receives its content; or name it from the daemon\'s own machine');
    }
    if (caller.personAsked === true) continue;
    const project = caller.workingDirectory;
    if (!project) {
      return new CapabilityRefusal(`Not done: ${input.label} names ${raw}, and a file is named by path only inside the project of whoever asks; this call named no project.`,
        'Send the project folder (workingDirectory) with the call, and name a file inside it');
    }
    const root = realPathOf(project);
    const given = expanded(raw, project);
    if (given !== undefined && pathWithin(realPathOf(given), root)) continue;
    return new CapabilityRefusal(`Not done: ${input.label} names ${raw}, which is outside the project (${project}); only you can name a file there, yourself.`,
      'Name a file inside the project, or ask the person to do it from its place');
  }
  return undefined;
}
