/**
 * call-context.ts, the one call context a terminal program carries on every call it makes to the daemon.
 *
 * Who asks is the credential (the bearer, as before). The rest is said once, by the program, when it starts, and
 * sent as three headers on every request any part of the program makes (its places, its model's tools, its held
 * calls, its notices, its command line):
 *   - `x-goodvibes-client`:  the program (`tui` or `agent`), as it was already sent;
 *   - `x-goodvibes-project`: the project folder the program works in (URI-encoded);
 *   - `x-goodvibes-session`: the conversation the program holds now (it moves with /clear, resume, fork).
 * The daemon reads them into the invocation's `context.call` (daemon-api control-routes.ts `readCallContext`,
 * control-plane/method-catalog-shared.ts `CallContext`); `capabilities.run` folds its body fields
 * (`workingDirectory`, `program`, `sessionId`: the same context given by hand, as the web UI's project chooser and
 * an outside caller give it) over them. The daemon never fills a missing project with its own folder.
 */

/** The header naming the program (unchanged: the daemon reads `tui`, `agent`, anything else as the web). */
export const CALL_PROGRAM_HEADER = 'x-goodvibes-client';
/** The header naming the project folder the call acts in, URI-encoded. */
export const CALL_PROJECT_HEADER = 'x-goodvibes-project';
/** The header naming the conversation the call came from. */
export const CALL_SESSION_HEADER = 'x-goodvibes-session';

/** What a program says about itself once, read again at every call (the session moves, the folder may). */
export interface ProgramCallContext {
  readonly program: 'tui' | 'agent';
  readonly project: () => string | undefined;
  readonly sessionId: () => string | undefined;
}

let programContext: ProgramCallContext | undefined;

/** Set by the program once it knows its folder and its conversation (bootstrap); every client then sends it. */
export function setProgramCallContext(context: ProgramCallContext | undefined): void {
  programContext = context;
}

function safely(read: () => string | undefined): string | undefined {
  try {
    const value = read();
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** This program's call context as it stands now (what an item it posts says it is for), or undefined before it is set. */
export function programCallContextNow(): { readonly program: 'tui' | 'agent'; readonly project?: string; readonly sessionId?: string } | undefined {
  const context = programContext;
  if (!context) return undefined;
  const project = safely(context.project);
  const sessionId = safely(context.sessionId);
  return { program: context.program, ...(project ? { project } : {}), ...(sessionId ? { sessionId } : {}) };
}

/**
 * The headers of this program's call context, for a client to add to every request to the daemon. `program` names
 * the program when no context was set yet (a command-line call before bootstrap): the header it always sent.
 */
export function programCallHeaders(program?: 'tui' | 'agent'): Record<string, string> {
  const context = programContext;
  const named = context?.program ?? program;
  const project = context ? safely(context.project) : undefined;
  const sessionId = context ? safely(context.sessionId) : undefined;
  return {
    ...(named ? { [CALL_PROGRAM_HEADER]: named } : {}),
    ...(project ? { [CALL_PROJECT_HEADER]: encodeURIComponent(project) } : {}),
    ...(sessionId ? { [CALL_SESSION_HEADER]: encodeURIComponent(sessionId) } : {}),
  };
}
