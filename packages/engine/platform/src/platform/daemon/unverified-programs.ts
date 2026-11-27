/**
 * unverified-programs.ts, the folders a terminal program may name where the daemon cannot verify it (macOS, Windows,
 * or a Linux daemon whose program socket could not open: daemon/program-socket.ts `programVerificationAvailable`).
 *
 * There, nothing a program says is taken as the owner's and nothing is refused outright for that alone: a call with the
 * operator token from this machine (`local`) that carries no registration and names a folder it was not given puts ONE
 * question to the owner per folder ("Let GoodVibes on this computer work in <folder>?", opening on No), answered at once
 * with the question's id; on his yes the folder is registered as a workspace if it is not one and given to the operator
 * token of this computer (caller `shared-token`, listed in Devices and network, "See the projects each device or member
 * may work in", and taken back there with "Stop a device or member working in a project"); the next call goes on,
 * decided as a script's (its risky acts are put to him). On his No it is refused and not asked again while the daemon
 * runs. A folder that can never be a project is never asked about.
 *
 * What this cannot tell apart, said plainly: on such a computer every process of the account holding the operator token
 * is "GoodVibes on this computer" to the daemon; the yes is given to that token, not to one program. Where verification
 * works (Linux), this asks nothing: a caller without a registration is a script, and names no project it was not given.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ApprovalBroker } from '../control-plane/approval-broker.js';
import type { GatewayMethodCatalog } from '../control-plane/method-catalog.js';
import { CallerProjectsStore } from '../workspace/caller-projects-store.js';
import { checkCallerProject, whyNeverAProject } from '../workspace/caller-project.js';
import { resolveGoodVibesDaemonHome } from '../config/goodvibes-home.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/native-error-summary.js';
import { giveOutsideAgentProject, type OutsideAgentProjectAnswer } from './outside-agent.js';
import { isRegisteredProgram } from './program-registrations.js';
import { callerKey } from '../pairing/principal-ids.js';
import { OWNER_QUESTIONS_FULL } from '../control-plane/owner-question-bounds.js';

/** Who the question names. */
export const UNVERIFIED_PROGRAM_WORDS = 'GoodVibes on this computer';
const GIVE_RULE = 'the owner gives it in Devices and network ("Let a device or member work in a project", for shared-token), or says yes when asked';

export function createUnverifiedProgramProjects(deps: {
  readonly homeDirectory: string;
  readonly broker: Pick<ApprovalBroker, 'raiseApproval'>;
  readonly gatewayMethods: Pick<GatewayMethodCatalog, 'invoke' | 'hasHandler'>;
  /** Whether this daemon can verify its programs (its program socket is open). */
  readonly verificationAvailable: () => boolean;
}): (caller: { readonly principalId: string; readonly credentialKind: string | undefined; readonly registration: string | undefined }, folders: readonly string[]) => Promise<OutsideAgentProjectAnswer | undefined> {
  const daemonHome = resolveGoodVibesDaemonHome(deps.homeDirectory);
  const store = new CallerProjectsStore(daemonHome);
  const facts = { homeDirectory: deps.homeDirectory, goodVibesHome: join(deps.homeDirectory, '.goodvibes'), daemonHome };
  const open = new Map<string, string>();
  const refused = new Set<string>();

  const ask = async (principalId: string, credentialKind: string | undefined, folder: string): Promise<string> => {
    const waiting = open.get(folder);
    if (waiting) return waiting;
    // Who asks is recorded on the question: the broker bounds that caller's questions and lists them as its own, never
    // as the owner's own programs' (control-plane/approval-broker.ts `raiseApproval`).
    const requestedBy = callerKey({ principalId, credentialKind });
    const question = `Let ${UNVERIFIED_PROGRAM_WORDS} work in ${folder}?`;
    const raised = await deps.broker.raiseApproval({
      request: {
        callId: `unverified-program-project-${randomUUID()}`, tool: 'unverified-program.project', args: { project: folder }, category: 'write',
        analysis: { classification: 'owner-act', riskLevel: 'high', summary: question,
          reasons: [`A terminal program on this computer named ${folder}, and this computer cannot prove to the daemon that it is GoodVibes' own program (any process of your account holding the operator token looks the same here). On yes, the operator token of this computer may work there (its files, its rules, its turns there) until you take it away in Devices and network; every act you decide is still put to you.`] },
        ownerOnly: 'owner-act', rememberOptions: [],
      },
      metadata: { source: 'unverified-program', project: folder, requestedBy },
    });
    open.set(folder, raised.approval.id);
    void raised.decision.then(async (decision) => {
      if (decision.approved !== true) { refused.add(folder); return; }
      const given = await giveOutsideAgentProject(deps, principalId, folder);
      if (!given.ok) logger.warn('[programs] the owner said yes, and the folder could not be given to the operator token', { project: folder, reason: given.reason });
    }, (error: unknown) => {
      logger.warn('[programs] the question for a folder ended without an answer; it is not given', { error: summarizeError(error) });
    }).finally(() => open.delete(folder));
    return raised.approval.id;
  };

  return async (caller, folders) => {
    if (deps.verificationAvailable() || caller.credentialKind !== 'local' || isRegisteredProgram(caller.registration)) return undefined;
    for (const folder of folders) {
      const given = checkCallerProject(folder, { ownersProgram: false, principalId: caller.principalId }, { ...facts, assignedProjects: (who) => store.projectsOf(who) });
      if (given.ok) continue;
      const never = whyNeverAProject(folder, facts);
      if (never !== undefined) return undefined;
      if (refused.has(folder)) return { ok: false, reason: `the owner did not let ${UNVERIFIED_PROGRAM_WORDS} work in ${folder}; ${GIVE_RULE}` };
      let approvalId: string;
      try { approvalId = await ask(caller.principalId, caller.credentialKind, folder); }
      catch (error) {
        // Bounded like every caller's questions: past the bound nothing is asked, and the words say why.
        if ((error as { readonly code?: unknown }).code === OWNER_QUESTIONS_FULL) return { ok: false, reason: (error as Error).message };
        throw error;
      }
      return { ok: false, pendingApprovalId: approvalId,
        reason: `this computer cannot prove the program to the daemon, so the owner has been asked once in Waiting for you (approval ${approvalId}) whether ${UNVERIFIED_PROGRAM_WORDS} may work in ${folder}; nothing ran. Call again once he has answered` };
    }
    return { ok: true };
  };
}
