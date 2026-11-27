/**
 * outside-agent.ts, the one credential this daemon gives an outside agent (`goodvibes-daemon mcp serve`) and the
 * projects it may work in.
 *
 * The credential (`pairing.outsideAgent.issue`, asked for with the operator token) is a paired-device token named
 * "Outside agent (goodvibes-daemon mcp serve)", origin automation, issued once per daemon whatever address the server
 * reaches it by: its id is kept in `<daemon home>/outside-agent.json`, and a second ask while that pairing is still
 * listed is refused (revoked among the paired devices, a new one is issued). On a fresh install it is minted with no
 * project and no person's claim, and with the narrow scopes of a device that works in the projects it is given
 * (routes/pairing.ts `DEFAULT_PAIRED_SCOPES`): no administrative scope, so it is a paired device, never an admin. On a
 * home 3.5.0 ran in, where `mcp serve` spoke with the operator token, it is minted with what that token was carried at
 * the upgrade (see `issueOutsideAgent`): the upgrade takes nothing from it but the owner-only acts.
 *
 * Who works where is given by the owner in person (method-risk.ts `owner-act`): a call of it naming a folder it was not
 * given is refused, in every mode, with the sentence saying where the owner gives one; naming a folder never registers it or
 * gives it. A credential issued by 3.5.0 keeps the projects it was given and the scopes it holds, and the owner-only
 * acts are refused to it whatever its scopes (control-plane.ts, routes/capabilities.ts).
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CallerProjectsStore } from '../workspace/caller-projects-store.js';
import { CallerSharedStore } from '../control-plane/shared-kinds.js';
import type { PairingMaker } from '../pairing/pairing-token-store.js';
import { checkCallerProject, whyNeverAProject } from '../workspace/caller-project.js';
import { resolveGoodVibesDaemonHome } from '../config/goodvibes-home.js';
import { logger } from '../utils/logger.js';
import { decideGrant, type GrantRequest } from './capability-owner-gate.js';
import { DEFAULT_PAIRED_SCOPES } from '../control-plane/routes/pairing.js';

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
  mintForMigration(input: { readonly name: string; readonly mintedBy?: string | undefined; readonly madeBy?: PairingMaker | undefined; readonly scopes?: readonly string[] | undefined }): { readonly id: string; readonly token: string; readonly name: string };
}

/**
 * Issue the outside agent's credential: once per daemon. Refused (`issued`) while the one issued before is still listed.
 * The caller is the owner's own credential (the operator token); the route checks it.
 */
export function issueOutsideAgent(daemonHome: string, pairing: OutsideAgentPairing, madeBy?: PairingMaker):
  { readonly ok: true; readonly id: string; readonly token: string; readonly name: string } | { readonly ok: false; readonly issued: string } {
  const kept = outsideAgentId(daemonHome);
  if (kept !== undefined && pairing.list().some((token) => token.id === kept)) return { ok: false, issued: kept };
  // On a home 3.5.0 ran in, `mcp serve` spoke with the machine's operator token, which was carried at the upgrade
  // (control-plane/shared-kinds.ts `operatorTokenCarried`). The credential that replaces that token for it keeps what the
  // token held there and holds now: no scope list (as a 3.5.0 pairing had none), and the shared kinds and projects the
  // token still has from the carry, recorded as carried from 3.5.0 and removable in Devices and network. Nothing the token
  // itself does not hold; the owner-only acts stay refused to it. Elsewhere (a fresh install) it is a device with the
  // default scopes, given nothing.
  const shared = new CallerSharedStore(daemonHome);
  const replacesOperatorToken = shared.operatorTokenCarried();
  const minted = pairing.mintForMigration({ name: OUTSIDE_AGENT_NAME, ...(replacesOperatorToken ? {} : { scopes: DEFAULT_PAIRED_SCOPES }), ...(madeBy !== undefined ? { madeBy } : {}) });
  if (replacesOperatorToken) {
    const principalId = `pairing:${minted.id}`;
    shared.giveCarried(principalId, shared.carriedOf('local'));
    const projects = new CallerProjectsStore(daemonHome);
    projects.giveCarried(principalId, projects.carriedOf('local'));
  }
  mkdirSync(daemonHome, { recursive: true, mode: 0o700 });
  const file = keptFile(daemonHome);
  writeFileSync(file, `${JSON.stringify({ id: minted.id, issuedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { ok: true, id: minted.id, token: minted.token, name: minted.name };
}

const GIVE_RULE = 'only the owner in person registers a folder as a workspace and gives it to a caller, in Devices and network, on its row ("Let a device or member work in a project")';

/**
 * Give a credential `folder` once it was allowed: only a folder the owner already registered as a workspace (or one
 * inside one). Nothing here registers a folder: registering one is the owner's own act (method-risk.ts `owner-act`), so
 * a caller never makes a folder a project by naming it.
 */
export async function giveOutsideAgentProject(deps: {
  readonly homeDirectory: string;
}, principalId: string, folder: string): Promise<OutsideAgentProjectAnswer> {
  const daemonHome = resolveGoodVibesDaemonHome(deps.homeDirectory);
  const facts = { homeDirectory: deps.homeDirectory, goodVibesHome: join(deps.homeDirectory, '.goodvibes'), daemonHome };
  const verdict = checkCallerProject(folder, { ownersProgram: false, principalId }, { ...facts, assignedProjects: () => ['/'] });
  if (!verdict.ok) return { ok: false, reason: `${verdict.reason}; ${GIVE_RULE}` };
  const store = new CallerProjectsStore(daemonHome);
  store.set(principalId, [...store.projectsOf(principalId), verdict.project]);
  return { ok: true };
}

/** What the dispatch learns for the folders an outside agent's call names: go on, or the refusal. */
export type OutsideAgentProjectAnswer = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * The projects an outside agent's call names (see the header): one the owner gave it goes on; any other is refused, in
 * every mode, nothing asked, nothing registered or given: who works where is the owner's own act. `undefined` from the
 * returned function: the caller is not the outside agent.
 */
export function createOutsideAgentProjects(deps: {
  readonly homeDirectory: string;
}): (principalId: string, folders: readonly string[], signal?: AbortSignal) => Promise<OutsideAgentProjectAnswer | undefined> {
  const daemonHome = resolveGoodVibesDaemonHome(deps.homeDirectory);
  const store = new CallerProjectsStore(daemonHome);
  const facts = { homeDirectory: deps.homeDirectory, goodVibesHome: join(deps.homeDirectory, '.goodvibes'), daemonHome };
  const giveRule = 'only the owner in person gives it a project, in Devices and network, on its row ("Let a device or member work in a project")';

  return async (principalId, folders) => {
    const id = outsideAgentId(daemonHome);
    if (id === undefined || principalId !== `pairing:${id}`) return undefined;
    for (const folder of folders) {
      const given = checkCallerProject(folder, { ownersProgram: false, principalId }, { ...facts, assignedProjects: (who) => store.projectsOf(who) });
      if (given.ok) continue;
      const never = whyNeverAProject(folder, facts);
      return { ok: false, reason: never !== undefined
        ? `${folder} cannot be a project (${never}): ${OUTSIDE_AGENT_WORDS} acts on shared things only here; ${giveRule}`
        : `${OUTSIDE_AGENT_WORDS} was not given ${folder}, and naming a folder gives nothing: ${giveRule}` };
    }
    return { ok: true };
  };
}

/**
 * A folder given to a caller as its first use, decided by the daemon's one permission manager under the owner's mode:
 * given (YOLO, Jev's allow, a rule, the owner's yes under Ask me while the call waits) or refused with the reason.
 */
export async function decideProjectGrant(request: GrantRequest, give: (folder: string) => Promise<OutsideAgentProjectAnswer>,
  folder: string, who: string, giveRule: string): Promise<OutsideAgentProjectAnswer> {
  const decided = await decideGrant(request);
  if (!decided.approved) return { ok: false, reason: `${who} may not work in ${folder}: ${decided.reason ?? 'it was not allowed under the owner\'s permission mode'}; ${giveRule}` };
  const given = await give(folder);
  if (!given.ok) logger.warn('[projects] a project was allowed and could not be given', { project: folder, reason: given.reason });
  return given;
}
