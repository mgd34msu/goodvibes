/**
 * outside-agent.ts, the one credential this daemon gives an outside agent (`goodvibes-daemon mcp serve`) and the
 * projects it may work in.
 *
 * The credential (`pairing.outsideAgent.issue`, asked for with the operator token) is a paired-device token named
 * "Outside agent (goodvibes-daemon mcp serve)", origin automation, issued once per daemon whatever address the server
 * reaches it by: its id is kept in `<daemon home>/outside-agent.json`, and a second ask while that pairing is still
 * listed is refused (revoked among the paired devices, a new one is issued). It is minted with no project and no
 * person's claim.
 *
 * The first time a call of it names a project it was not given, the daemon puts ONE question to the owner ("Let the
 * outside agent "goodvibes-daemon mcp serve" work in <project>?", opening on No) and holds the call: on his yes that
 * folder is registered as a workspace (if it is not one) and given to the credential, and the call goes on, decided
 * under his mode as every call of its is; on his No it is refused, and the same folder is not asked about again while
 * the daemon runs (he gives it in Devices and network, on its row). Calls naming the same project while the question is
 * open wait on that one question. A folder that can never be a project (the root, the home folder itself, anything in or
 * above the GoodVibes or daemon home) is never asked about: such a call acts on shared things only, and its refusal says
 * how the owner gives the agent a project. The question names the folder, so a model that starts the server somewhere
 * else gains nothing without the owner's yes.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApprovalBroker } from '../control-plane/approval-broker.js';
import type { GatewayMethodCatalog } from '../control-plane/method-catalog.js';
import { CallerProjectsStore } from '../workspace/caller-projects-store.js';
import type { PairingMaker } from '../pairing/pairing-token-store.js';
import { checkCallerProject, whyNeverAProject } from '../workspace/caller-project.js';
import { resolveGoodVibesDaemonHome } from '../config/goodvibes-home.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/native-error-summary.js';
import { OWNER_QUESTIONS_FULL } from '../control-plane/owner-question-bounds.js';

/** The name the outside agent's credential is listed under among the paired devices. */
export const OUTSIDE_AGENT_NAME = 'Outside agent (goodvibes-daemon mcp serve)';
/** Who the question names. */
const OUTSIDE_AGENT_WORDS = 'the outside agent "goodvibes-daemon mcp serve"';

function keptFile(daemonHome: string): string {
  return join(daemonHome, 'outside-agent.json');
}

/** The pairing id of the outside agent's credential this daemon issued, or undefined. */
export function outsideAgentId(daemonHome: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(keptFile(daemonHome), 'utf8')) as { readonly id?: unknown } | null;
    return typeof parsed?.id === 'string' && parsed.id ? parsed.id : undefined;
  } catch {
    return undefined;
  }
}

/** The pairing store as issuing reads it. */
export interface OutsideAgentPairing {
  list(): readonly { readonly id: string }[];
  mintForMigration(input: { readonly name: string; readonly mintedBy?: string | undefined; readonly madeBy?: PairingMaker | undefined }): { readonly id: string; readonly token: string; readonly name: string };
}

/**
 * Issue the outside agent's credential: once per daemon. Refused (`issued`) while the one issued before is still listed.
 * The caller is the owner's own credential (the operator token); the route checks it.
 */
export function issueOutsideAgent(daemonHome: string, pairing: OutsideAgentPairing, madeBy?: PairingMaker):
  { readonly ok: true; readonly id: string; readonly token: string; readonly name: string } | { readonly ok: false; readonly issued: string } {
  const kept = outsideAgentId(daemonHome);
  if (kept !== undefined && pairing.list().some((token) => token.id === kept)) return { ok: false, issued: kept };
  const minted = pairing.mintForMigration({ name: OUTSIDE_AGENT_NAME, ...(madeBy !== undefined ? { madeBy } : {}) });
  mkdirSync(daemonHome, { recursive: true, mode: 0o700 });
  const file = keptFile(daemonHome);
  writeFileSync(file, `${JSON.stringify({ id: minted.id, issuedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { ok: true, id: minted.id, token: minted.token, name: minted.name };
}

const GIVE_RULE = 'the owner gives it a project in Devices and network, on its row ("Let a device or member work in a project"), or starts it in a project folder and says yes when asked';

/**
 * Give the outside agent's credential `folder` on the owner's yes: registered as a workspace first if it is not one (his
 * own act, on his yes), then given to that credential. The one way it is given a project, whether his yes was to the
 * credential's own question (its first start) or to a project it named later.
 */
export async function giveOutsideAgentProject(deps: {
  readonly homeDirectory: string;
  readonly gatewayMethods: Pick<GatewayMethodCatalog, 'invoke' | 'hasHandler'>;
}, principalId: string, folder: string): Promise<OutsideAgentProjectAnswer> {
  const daemonHome = resolveGoodVibesDaemonHome(deps.homeDirectory);
  const facts = { homeDirectory: deps.homeDirectory, goodVibesHome: join(deps.homeDirectory, '.goodvibes'), daemonHome };
  if (deps.gatewayMethods.hasHandler('workspaces.registrations.add')) {
    try {
      await deps.gatewayMethods.invoke('workspaces.registrations.add', {
        body: { root: folder, origin: 'outside-agent' }, isAuthorized: () => true, context: {},
      });
    } catch (error) {
      return { ok: false, reason: `${folder} could not be registered as a workspace (${summarizeError(error)}); ${GIVE_RULE}` };
    }
  }
  const verdict = checkCallerProject(folder, { ownersProgram: false, principalId }, { ...facts, assignedProjects: () => ['/'] });
  if (!verdict.ok) return { ok: false, reason: `${verdict.reason}; ${GIVE_RULE}` };
  const store = new CallerProjectsStore(daemonHome);
  store.set(principalId, [...store.projectsOf(principalId), verdict.project]);
  return { ok: true };
}

/**
 * What the dispatch learns for the folders an outside agent's call names: go on, the refusal, or that the owner was
 * asked (`pendingApprovalId`: the call is answered at once that he has been asked, where he answers, and to call again).
 */
export type OutsideAgentProjectAnswer = { readonly ok: true } | { readonly ok: false; readonly reason: string; readonly pendingApprovalId?: string };

/**
 * The question to the owner for the first project an outside agent names (see the header). `undefined` from the
 * returned function: the caller is not the outside agent, nothing to ask.
 */
export function createOutsideAgentProjects(deps: {
  readonly homeDirectory: string;
  readonly broker: Pick<ApprovalBroker, 'raiseApproval'>;
  readonly gatewayMethods: Pick<GatewayMethodCatalog, 'invoke' | 'hasHandler'>;
}): (principalId: string, folders: readonly string[]) => Promise<OutsideAgentProjectAnswer | undefined> {
  const daemonHome = resolveGoodVibesDaemonHome(deps.homeDirectory);
  const store = new CallerProjectsStore(daemonHome);
  const facts = { homeDirectory: deps.homeDirectory, goodVibesHome: join(deps.homeDirectory, '.goodvibes'), daemonHome };
  /** One open question per folder: its approval's id. */
  const open = new Map<string, string>();
  /** Folders the owner said No to while this daemon runs. */
  const refused = new Set<string>();
  const giveRule = 'the owner gives it a project in Devices and network, on its row ("Let a device or member work in a project"), or starts it in a project folder and says yes when asked';

  /**
   * Put the folder to the owner once, and answer at once with the question's id: the call is never held open waiting
   * for him. On his yes the folder is given (`give`); on his No it is not asked about again while the daemon runs.
   */
  const ask = async (principalId: string, folder: string): Promise<string> => {
    const waiting = open.get(folder);
    if (waiting) return waiting;
    const question = `Let ${OUTSIDE_AGENT_WORDS} work in ${folder}?`;
    const raised = await deps.broker.raiseApproval({
      request: {
        callId: `outside-agent-project-${randomUUID()}`, tool: 'outside-agent.project', args: { project: folder }, category: 'write',
        analysis: { classification: 'owner-act', riskLevel: 'high', summary: question,
          reasons: [`${OUTSIDE_AGENT_WORDS} named ${folder}, a project it was not given. On yes it may work there (its files, its rules, its turns there) until you take it away in Devices and network; nothing else is given.`] },
        ownerOnly: 'owner-act', rememberOptions: [],
        // Its place is the project it asks about, never the daemon's own folder.
        workingDirectory: folder,
      },
      // Who asks is recorded: the broker bounds the outside agent's questions and lists them as its own, never as the
      // owner's own programs' (control-plane/approval-broker.ts `raiseApproval`).
      metadata: { source: 'outside-agent', project: folder, requestedBy: principalId },
    });
    open.set(folder, raised.approval.id);
    void raised.decision.then(async (decision) => {
      if (decision.approved !== true) { refused.add(folder); return; }
      const given = await give(principalId, folder);
      if (!given.ok) logger.warn('[outside-agent] the owner said yes, and the project could not be given', { project: folder, reason: given.reason });
    }, (error: unknown) => {
      logger.warn('[outside-agent] the question for a project ended without an answer; it is not given', { error: summarizeError(error) });
    }).finally(() => open.delete(folder));
    return raised.approval.id;
  };

  const give = (principalId: string, folder: string): Promise<OutsideAgentProjectAnswer> => giveOutsideAgentProject(deps, principalId, folder);

  return async (principalId, folders) => {
    const id = outsideAgentId(daemonHome);
    if (id === undefined || principalId !== `pairing:${id}`) return undefined;
    for (const folder of folders) {
      const given = checkCallerProject(folder, { ownersProgram: false, principalId }, { ...facts, assignedProjects: (who) => store.projectsOf(who) });
      if (given.ok) continue;
      const never = whyNeverAProject(folder, facts);
      if (never !== undefined) {
        return { ok: false, reason: `${folder} cannot be a project (${never}): the outside agent acts on shared things only here; ${giveRule}` };
      }
      if (refused.has(folder)) return { ok: false, reason: `the owner did not let the outside agent work in ${folder}; ${giveRule}` };
      let approvalId: string;
      try { approvalId = await ask(principalId, folder); }
      catch (error) {
        // Bounded like every caller's questions: past the bound nothing is asked, and the words say why.
        if ((error as { readonly code?: unknown }).code === OWNER_QUESTIONS_FULL) return { ok: false, reason: (error as Error).message };
        throw error;
      }
      return { ok: false, pendingApprovalId: approvalId,
        reason: `the owner has been asked in Waiting for you (approval ${approvalId}) whether the outside agent may work in ${folder}; nothing ran. Call again once he has answered: on his yes it works there` };
    }
    return { ok: true };
  };
}
