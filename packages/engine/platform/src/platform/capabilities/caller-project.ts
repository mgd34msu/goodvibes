/**
 * The project a daemon capability acts in: the folder its caller named (the call context, routes/capabilities.ts
 * `callerOf`), never the daemon's own working folder in its place. A per-project thing asked for with no project is
 * refused, saying what to send; nothing is read from or written to the daemon's folder for it.
 */
import { CapabilityRefusal } from './types.js';
import { projectIdentityOf } from '../workspace/project-identity.js';

/** The code a refusal for a missing project answers with (422, as `callerNeeds` answers). */
export const CALLER_PROJECT_MISSING = 'NO_PROJECT';

/**
 * The caller's project: the project its folder belongs to (`projectIdentityOf`: a program opened in a subfolder of a
 * project reads and writes that project's hooks file, tool-server file and plugins, the ones at the project's root);
 * refused when the caller named none. `what` names the per-project thing.
 */
export function requireCallerProject(workingDirectory: string | undefined, what: string): string {
  if (typeof workingDirectory === 'string' && workingDirectory.trim()) return projectIdentityOf(workingDirectory.trim());
  throw new CapabilityRefusal(
    `No project folder came with the request, so ${what} of no project was read or changed. Nothing was done.`,
    'Send workingDirectory, the project folder, with the request (a terminal program sends its own folder with every call).',
    CALLER_PROJECT_MISSING,
    422,
  );
}
