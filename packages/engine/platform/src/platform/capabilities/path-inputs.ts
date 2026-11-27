/**
 * path-inputs.ts, where a file a capability is given by path may be, and the ONE place a capability turns a path a
 * caller gave into the file it acts on. For anyone but the person themselves (a model, a paired device, a script, another
 * agent) the file is inside the caller's project, as the file really is (a link in the project, `/proc/self/root`, `~`
 * or `..` followed to what it names); the project is the one the daemon checked for that caller
 * (workspace/caller-project.ts `checkCallerProject`), never a folder it merely named. Checked at every door before
 * anything is asked or run: `capabilities.run` (control-plane/routes/capabilities.ts), the program's `capability_run`
 * (terminal-shell agent-turn/capability-tools.ts) and the daemon's own turns (tools/capability/daemon-tools.ts); and
 * again by the handler, which acts only on the path `callerPathOf` gives it, so no handler resolves a path its own way.
 * The person names any file themselves, from their own terminal or screen.
 *
 * A file that cannot be used is said in the product's words only (`unreadableFile`, `readCallerJson`): never a parser's
 * or the system's message, which can quote the file's own text, and never the file's text.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { HeldPathRefusal, holdCallerPath, holdingCallerPaths } from './held-paths.js';
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
function expanded(raw: string, base: string | undefined): string | undefined {
  if (raw === '~' || raw.startsWith('~/')) {
    const home = process.env['HOME'];
    return home ? resolve(home, raw.slice(2)) : undefined;
  }
  if (raw.startsWith('~')) return undefined;
  if (isAbsolute(raw)) return resolve(raw);
  return base ? resolve(base, raw) : undefined;
}

export interface CallerPathOptions {
  /** The input's label, for the refusal's words. Default "The file". */
  readonly label?: string | undefined;
  /**
   * For a capability that runs in the program holding the conversation (home `session`), never in the daemon: that
   * program places the person's relative path itself, in the folder it was opened in (their project), so with no project
   * named their path is handed on as they typed it. Everywhere else a relative path with no project is refused: nothing is
   * placed in the daemon's own folder.
   */
  readonly personPathAsTyped?: boolean | undefined;
  /** Only whether the caller may name it (a check before anything is asked): nothing is held. */
  readonly checkOnly?: boolean | undefined;
}

/**
 * The file a path input names, as the capability acts on it, for this caller; refused (CapabilityRefusal) when the
 * caller may not name it:
 * - a caller on another machine names a file on that machine: the daemon acts on a path only for a caller on its own;
 * - the person: the path as they typed it (`~` expanded, a relative one in their project; with no project refused);
 * - anyone else: the real path, which must be inside the caller's checked project.
 */
export function callerPathOf(caller: CapabilityCaller, raw: string, options: CallerPathOptions = {}): string {
  const label = options.label ?? 'The file';
  const named = raw.trim();
  // The content the program asking sent, put in this call's own scratch folder by the daemon (carried-files.ts): that
  // path, and nothing outside it, is acted on, whoever asked and from wherever.
  if (caller.carried !== undefined && caller.carried.length > 0 && isAbsolute(named)) {
    const real = realPathOf(named);
    if (caller.carried.some((root) => pathWithin(real, realPathOf(root)))) return real;
  }
  if (caller.elsewhere === true) {
    throw new CapabilityRefusal(`Not done: ${label} names ${named}, a file on the machine that asked, not on this daemon's machine; the daemon reads and writes a file by path only for a caller on its own machine.`,
      'The program on that machine reads or writes the file there itself and sends or receives its content; or name it from the daemon\'s own machine');
  }
  const project = caller.workingDirectory?.trim() || undefined;
  // The person names any file themselves only from the owner's own program; a person on a paired device or a member's
  // sign-in names a file inside the caller's project, as anyone else does (or sends their own file's content).
  if (caller.personAsked === true && caller.namesAnyFile !== false) {
    const given = expanded(named, project ? resolve(project) : undefined);
    if (given !== undefined) return given;
    if (options.personPathAsTyped === true) return named;
    throw new CapabilityRefusal(`Not done: ${label} names ${named}, a relative path, and no project folder came with the request, so it was not read or written.`,
      'Give the full path of the file, or send workingDirectory, the project folder, with the request.', 'NO_PROJECT', 422);
  }
  if (!project) {
    throw new CapabilityRefusal(`Not done: ${label} names ${named}, and a file is named by path only inside the project of whoever asks; this call named no project.`,
      'Send the project folder (workingDirectory) with the call, and name a file inside it');
  }
  const given = expanded(named, resolve(project));
  const real = given === undefined ? undefined : realPathOf(given);
  const projectReal = realPathOf(project);
  if (given !== undefined && real !== undefined && pathWithin(real, projectReal)) {
    if (options.checkOnly === true) return real;
    // Held from here to the end of the call (held-paths.ts): what is acted on is the file checked, whatever is swapped
    // for a link meanwhile.
    try {
      return holdCallerPath(given, projectReal) ?? real;
    } catch (error) {
      if (!(error instanceof HeldPathRefusal)) throw error;
      if (error.why === 'kind') {
        throw new CapabilityRefusal(`Not done: ${label} names ${named}, which is not a file or a folder; nothing was read or written.`, 'Name a file or a folder');
      }
      if (error.why === 'changed') {
        throw new CapabilityRefusal(`Not done: ${label} names ${named}, which was changed while it was checked (a link was put in its place); nothing was read or written.`,
          'Name it again once nothing is moving it');
      }
      if (error.why === 'too-big') {
        throw new CapabilityRefusal(`Not done: ${label} names ${named}, and ${error.message}; nothing was read or written.`,
          'Name a smaller file or folder');
      }
      if (error.why === 'busy') {
        throw new CapabilityRefusal(`Not done: ${label} names ${named}, which ${error.message.replace(/^.* is /, 'is ')}; nothing was read or written, so neither call replaces the other.`,
          'Send it again when the other call has ended', 'FILE_BUSY', 409);
      }
    }
  }
  throw new CapabilityRefusal(`Not done: ${label} names ${named}, which is outside the project (${project}); only you can name a file there, yourself.`,
    'Name a file inside the project, or ask the person to do it from its place');
}

/**
 * One capability's run with every file it names by path held for the whole run (held-paths.ts): every door that runs a
 * handler runs it through this, so a check and the act it allows are on the same file.
 */
export function runHoldingPaths<T>(run: () => Promise<T>, stagingBase?: string | undefined): Promise<T> {
  return holdingCallerPaths(run, {
    // The daemon's door gives `<daemon home>/held`; a terminal program's copies go under its own `~/.goodvibes/held`.
    stagingBase,
    shownError: (error, shown) => error instanceof CapabilityRefusal
      ? new CapabilityRefusal(shown(error.message), error.next === undefined ? undefined : shown(error.next), error.code, error.status)
      // A path beneath a held folder met a link, a FIFO or a device, or another call's file (held-paths.ts `heldPath`).
      : error instanceof HeldPathRefusal
        ? new CapabilityRefusal(`Not done: ${shown(error.message)}.`, error.why === 'busy' ? 'Send it again when the other call has ended' : 'Remove or replace what is there, then send it again',
          error.why === 'busy' ? 'FILE_BUSY' : 'NOT_DONE', 409)
        : error instanceof Error ? Object.assign(error, { message: shown(error.message) }) : error,
    refusal: (message) => new CapabilityRefusal(`Not all of it was written: ${message}`, 'Run it again once nothing is moving those files', 'NOT_DONE', 409),
  });
}

/**
 * Why a path input of this call may not be used by this caller, or undefined when every one may: each input of kind
 * `path` with a value goes through `callerPathOf`.
 */
export function pathInputsRefusal(entry: Pick<CapabilityEntry, 'id' | 'inputs'>, values: Readonly<Record<string, string | undefined>>, caller: CapabilityCaller): CapabilityRefusal | undefined {
  // The file is on the machine of the program asking, which reads and writes it there itself and sends or receives its
  // content (terminal-shell bundle-file-work.ts): the daemon never acts on that path.
  if (values['filesAt'] === 'program') return undefined;
  for (const input of entry.inputs) {
    if (input.kind !== 'path') continue;
    // An input may hold several paths, one per line or separated by commas (a list of files a task would write).
    for (const raw of (values[input.id] ?? '').split(/[\n,]/)) {
      if (raw.trim() === '') continue;
      try {
        // A relative path from the person with no project: refused by the daemon's handler, placed by the program in its
        // own folder for a capability that runs there; only where a file may be is checked here.
        callerPathOf(caller, raw, { label: input.label, personPathAsTyped: true, checkOnly: true });
      } catch (error) {
        if (error instanceof CapabilityRefusal) return error;
        throw error;
      }
    }
  }
  return undefined;
}

/**
 * Why a file named by path could not be used, in the product's words only (see the file's comment). `what` names what
 * it was read as ("a memory file"). For anyone but the person one answer whether the file is missing, cannot be opened
 * or is not of that form, so the answer says nothing about what is on the disk; the person is told which.
 */
export function unreadableFile(path: string, what: string, caller: CapabilityCaller | undefined, error?: unknown, nothing = 'Nothing was changed.'): CapabilityRefusal {
  const code = (error as { readonly code?: unknown } | null | undefined)?.code;
  const why = caller?.personAsked !== true ? `could not be read as ${what}`
    : code === 'ENOENT' ? 'does not exist'
    : code === 'EACCES' || code === 'EPERM' ? 'could not be opened'
    : code === 'EISDIR' ? `is a folder, not ${what}`
    : `could not be read as ${what}`;
  // A wrong file is the caller's to change (422), never a fault of the daemon's.
  return new CapabilityRefusal(`${path} ${why}. ${nothing}`, undefined, 'BUNDLE_UNREADABLE', 422);
}

/**
 * What a handler says when the work it did on a file named by path failed: a refusal it made itself as it is; a failure
 * of reading or parsing the file (a system error, a SyntaxError) as `unreadableFile`; any other failure's own words
 * (which can name what the file holds) only to the person, and `unreadableFile` to anyone else.
 */
export function fileWorkRefusal(path: string, what: string, caller: CapabilityCaller | undefined, error: unknown, nothing = 'Nothing was changed.'): CapabilityRefusal {
  if (error instanceof CapabilityRefusal) return error;
  const fromFile = error instanceof SyntaxError || (error as { readonly code?: unknown } | null | undefined)?.code !== undefined;
  if (fromFile || caller?.personAsked !== true) return unreadableFile(path, what, caller, error, nothing);
  return new CapabilityRefusal(`${nothing.replace(/\.$/, '')}: ${(error instanceof Error ? error.message : String(error)).replace(/\.$/, '')}.`);
}

/** A JSON file named by path, parsed; refused with `unreadableFile` when it cannot be read or is not JSON. */
export function readCallerJson(path: string, what: string, caller: CapabilityCaller | undefined, nothing?: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch (error) {
    throw unreadableFile(path, what, caller, error, nothing);
  }
}
