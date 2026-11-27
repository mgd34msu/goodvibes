/**
 * caller-paths.ts, the ONE check of every folder and file a call names, for the caller that made it, on every path a
 * method call takes: the method catalog's `invoke` (control-plane/method-catalog.ts: the daemon's dispatch of a method
 * with a handler, and the daemon's own turns calling a method in process, daemon-tools.ts), the dispatch of a method
 * served only by its route, and the REST routes (daemon/http/router.ts). Each reads it here.
 *
 * - A folder a turn or a process will work in (`workFolders` of the method; for `capabilities.run` each input the
 *   capability declares `workFolder`) is a project the caller may name (workspace/caller-project.ts
 *   `checkCallerProject`): a device or member only a project the owner gave it, nobody the root, the home folder or in
 *   or above a GoodVibes home.
 * - A file on the daemon's disk a method reads or writes (`daemonFiles`) is, for anyone but the owner's own program, a
 *   file inside a project given to that caller, never anywhere else on this disk (a caller's own file from its machine
 *   travels as content: capabilities/carried-files.ts). The owner's own program names any file.
 */
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GatewayMethodDescriptor, GatewayMethodInvocationContext } from './method-catalog-shared.js';
import { workFolderValues } from './method-catalog-shared.js';
import { projectNamerOf, type CallerProjectVerdict, type ProjectNamer } from '../workspace/caller-project.js';

/** What the check reads: the one project check, and a capability's declared work-folder inputs. */
export interface CallerPathRules {
  readonly project: (raw: string, who: ProjectNamer) => CallerProjectVerdict;
  readonly capabilityWorkFolders?: ((capabilityId: string) => readonly string[]) | undefined;
}

/**
 * The rules a catalog holds while the daemon has set none (a catalog built without them): unknown is someone else's,
 * so the owner in person (their own program) names any folder, and anyone else names none and reaches no project's record.
 * Never "no rules, no check".
 */
export const CALLER_RULES_ABSENT: CallerPathRules = Object.freeze({
  project: (raw: string, who: ProjectNamer): CallerProjectVerdict => who.ownersProgram
    ? { ok: true, project: raw }
    : { ok: false, reason: `${raw} is not a project this caller may name: this daemon has no rule set for which projects a caller may name, so only the owner in person names one` },
});

/** Who names the paths (workspace/caller-project.ts `projectNamerOf`, on the one owner definition). */
export function pathNamerOf(context: (Pick<GatewayMethodInvocationContext, 'credentialKind' | 'principalId'> & Partial<Pick<GatewayMethodInvocationContext, 'actor' | 'call' | 'clientKind' | 'authToken'>>) | undefined): ProjectNamer {
  return projectNamerOf({ credentialKind: context?.credentialKind, actor: context?.actor, registration: context?.call?.registration, principalId: context?.principalId,
    daemonHosted: context?.call?.daemonHosted === true, ...daemonTurnProjectOf(context) });
}

/**
 * The project of one of the daemon's own turns (a web chat's, a schedule's or a trigger's run, a Work step): a call it
 * makes in process (`clientKind: daemon-turn` with no credential; a request from a socket always carries one and never
 * names that client kind, daemon-api control-routes.ts `readClientSurface`), or a call nested in it that the dispatch
 * marked (`call.daemonTurn`), confined to the project its turn works in, which it names; nothing for any other call.
 */
export function daemonTurnProjectOf(context: Partial<Pick<GatewayMethodInvocationContext, 'call' | 'clientKind' | 'authToken'>> | undefined): { readonly turnProject?: string } {
  // Made in process with no credential (daemon-tools.ts), or nested in such a turn and marked so by the dispatch alone.
  if (context?.clientKind !== 'daemon-turn') return {};
  if (context.call?.daemonTurn !== true && typeof context.authToken === 'string' && context.authToken !== '') return {};
  const project = context.call?.project;
  return typeof project === 'string' && project.trim() ? { turnProject: project.trim() } : {};
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * Why a call may not name one of its folders or files, `<input>: <why>`, or undefined when every one may. `project`:
 * the folder a relative path is placed in (the call's checked project), when the call names one.
 */
export function callerPathRefusal(descriptor: Pick<GatewayMethodDescriptor, 'id' | 'workFolders' | 'daemonFiles'> | undefined, body: unknown, query: unknown,
  context: (Pick<GatewayMethodInvocationContext, 'credentialKind' | 'principalId' | 'call'> & Partial<Pick<GatewayMethodInvocationContext, 'actor'>>) | undefined, rules: CallerPathRules): string | undefined {
  if (!descriptor) return undefined;
  const who = pathNamerOf(context);
  const project = (() => {
    const named = record(body)?.['workingDirectory'] ?? context?.call?.project;
    return typeof named === 'string' && named.trim() ? named.trim() : undefined;
  })();
  // A path as the call's handler places it: `~` is the home folder, a relative one is in the call's project.
  const placed = (part: string): string | undefined => isAbsolute(part) ? part
    : part === '~' || part.startsWith('~/') ? resolve(homedir(), part.slice(2))
      : project ? resolve(project, part) : undefined;
  const capabilityId = descriptor.id === 'capabilities.run' && typeof record(body)?.['id'] === 'string' ? String(record(body)!['id']).trim() : '';
  const folders = [
    ...(descriptor.workFolders ?? []),
    ...(capabilityId ? (rules.capabilityWorkFolders?.(capabilityId) ?? []).map((id) => `inputs.${id}`) : []),
  ];
  const files = who.ownersProgram ? [] : (descriptor.daemonFiles ?? []);
  for (const source of [body, query]) {
    for (const [paths, kind] of [[folders, 'folder'], [files, 'file']] as const) {
      for (const { path, value } of workFolderValues(source, paths)) {
        // A capability's path input may hold several, one per line or separated by commas (path-inputs.ts).
        const parts = kind === 'file' || path.startsWith('inputs.') ? value.split(/[\n,]/).map((part) => part.trim()).filter(Boolean) : [value];
        for (const raw of parts) {
          // A URI names a file on this disk only as `file:`; any other scheme (https) is fetched, no file here.
          const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1]?.toLowerCase();
          if (kind === 'file' && scheme !== undefined && scheme !== 'file') continue;
          let local = raw;
          if (scheme === 'file') {
            try { local = fileURLToPath(raw); } catch { return `${path}: ${raw} is not a file address this daemon reads`; }
          }
          // A method's own folder field holding `none` clears it ("Project for this channel": none): a word, no folder.
          if (kind === 'folder' && !path.startsWith('inputs.') && local.trim().toLowerCase() === 'none') continue;
          const at = kind === 'folder' && !path.startsWith('inputs.') ? local : placed(local);
          if (at === undefined) {
            if (kind === 'file') return `${path}: ${raw} is a relative path and the call names no project it is in`;
            continue;
          }
          const verdict = rules.project(at, who);
          if (!verdict.ok) return `${path}: ${kind === 'file' ? `${raw} is a file on this daemon's disk outside the projects this caller may name (${verdict.reason})` : verdict.reason}`;
        }
      }
    }
  }
  return undefined;
}
