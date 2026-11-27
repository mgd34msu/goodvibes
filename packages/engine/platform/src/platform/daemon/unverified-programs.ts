/**
 * unverified-programs.ts, left in place and doing nothing. Registration is optional and decides nothing: a terminal program
 * the daemon cannot verify (macOS, Windows, or a Linux daemon whose program socket could not open: daemon/program-socket.ts
 * `programVerificationAvailable`) names any folder as the user does, and no folder is given, asked about or refused for that.
 * `createUnverifiedProgramProjects` answers undefined for every call.
 *
 * What the rest of this comment describes is the old rule, never reached: a call with the
 * operator token from this machine (`local`) that carries no registration and names a folder it was not given has that
 * folder given to it decided by the daemon's one permission manager under the owner's mode, as a loosening with who
 * asks as a fact (capability-owner-gate.ts `decideGrant`): YOLO gives it, Jev decides and Just vibes ask Jev, Ask me asks
 * the owner while the call waits. Only a folder the owner already registered as a workspace is ever given (naming one
 * never registers it: that is the owner's own act); given, it goes to the operator token of this computer (caller
 * `shared-token`, listed in Devices and network, "See the projects each device or member may work in", and taken back
 * there with "Stop a device or member working in a project"); the call goes on, decided as a script's. A folder that
 * can never be a project, or is not registered, is never given.
 *
 * What this cannot tell apart, said plainly: on such a computer every process of the account holding the operator token
 * is "GoodVibes on this computer" to the daemon; the folder is given to that token, not to one program. (Not the rule now:
 * the token is the user, whatever process holds it.)
 */
import { join } from 'node:path';
import type { GatewayMethodCatalog } from '../control-plane/method-catalog.js';
import { CallerProjectsStore } from '../workspace/caller-projects-store.js';
import { checkCallerProject, whyNeverAProject } from '../workspace/caller-project.js';
import { resolveGoodVibesDaemonHome } from '../config/goodvibes-home.js';
import { decideProjectGrant, giveOutsideAgentProject, type OutsideAgentProjectAnswer } from './outside-agent.js';
import { isRegisteredProgram } from './program-registrations.js';

/** Whether a program the daemon cannot register has the folders it names decided. It does not: registration decides nothing. */
const REGISTRATION_DECIDES_FOLDERS = false as boolean;

/** Who the decision names. */
export const UNVERIFIED_PROGRAM_WORDS = 'GoodVibes on this computer';
const GIVE_RULE = 'the owner gives it in Devices and network ("Let a device or member work in a project", for shared-token)';

export function createUnverifiedProgramProjects(deps: {
  readonly homeDirectory: string;
  readonly gatewayMethods: Pick<GatewayMethodCatalog, 'invoke' | 'hasHandler'>;
  /** Whether this daemon can verify its programs (its program socket is open). */
  readonly verificationAvailable: () => boolean;
}): (caller: { readonly principalId: string; readonly credentialKind: string | undefined; readonly registration: string | undefined }, folders: readonly string[], signal?: AbortSignal) => Promise<OutsideAgentProjectAnswer | undefined> {
  const daemonHome = resolveGoodVibesDaemonHome(deps.homeDirectory);
  const store = new CallerProjectsStore(daemonHome);
  const facts = { homeDirectory: deps.homeDirectory, goodVibesHome: join(deps.homeDirectory, '.goodvibes'), daemonHome };

  return async (caller, folders, signal) => {
    // Registration decides nothing: the operator token on this machine is the user, who names any folder, with or without a
    // program's registration, so nothing is given, asked or refused here. What follows is left in place and is never reached.
    if (!REGISTRATION_DECIDES_FOLDERS || deps.verificationAvailable() || caller.credentialKind !== 'local' || isRegisteredProgram(caller.registration)) return undefined;
    for (const folder of folders) {
      const given = checkCallerProject(folder, { ownersProgram: false, principalId: caller.principalId }, { ...facts, assignedProjects: (who) => store.projectsOf(who) });
      if (given.ok) continue;
      const never = whyNeverAProject(folder, facts);
      if (never !== undefined) return undefined;
      // Only a folder the owner registered in person is ever given: naming one never makes it a project (registering a
      // folder is the owner's own act), so an unregistered one is refused before anything is decided.
      const registered = checkCallerProject(folder, { ownersProgram: false, principalId: caller.principalId }, { ...facts, assignedProjects: () => ['/'] });
      if (!registered.ok) return { ok: false, reason: `${registered.reason}; ${GIVE_RULE}` };
      const answer = await decideProjectGrant({
        id: 'unverified-program.project', label: `Let ${UNVERIFIED_PROGRAM_WORDS} work in ${folder}`, project: folder,
        sentence: `A terminal program on this computer named ${folder}, and this computer cannot prove to the daemon that it is GoodVibes' own program (any process of the account holding the operator token looks the same here). The operator token of this computer may then work there (its files, its rules, its turns there) until the owner takes it away in Devices and network.`,
        runsAs: { principalId: caller.principalId, credentialKind: 'local' }, ...(signal ? { signal } : {}),
      }, (folderGiven) => giveOutsideAgentProject({ homeDirectory: deps.homeDirectory }, caller.principalId, folderGiven), folder, UNVERIFIED_PROGRAM_WORDS, GIVE_RULE);
      if (!answer.ok) return answer;
    }
    return { ok: true };
  };
}
