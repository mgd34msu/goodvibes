/**
 * method-catalog-programs.ts, the method the outside agent's server uses to be known to the daemon as itself (handler:
 * daemon/capability-wiring.ts). A terminal program registers through no method: only over the daemon's program socket
 * (daemon/program-socket.ts), where the kernel names who connected.
 *
 * `pairing.outsideAgent.issue`: `goodvibes-daemon mcp serve` asks, with the operator token, for the one credential of
 * its own this daemon gives an outside agent: an automation pairing with no project and no person's claim, issued once
 * (a second ask while one is kept is refused: revoked among the paired devices, it can be issued again). Every act of
 * its that the owner decides is put to him (daemon/method-owner-decision.ts), and the first time it names a project it
 * was not given he is asked whether it may work there (daemon/outside-agent-projects.ts).
 */
import { BOOLEAN_SCHEMA, STRING_SCHEMA, methodDescriptor, objectSchema, type GatewayMethodDescriptor } from './method-catalog-shared.js';

export const OUTSIDE_AGENT_ISSUE_METHOD_ID = 'pairing.outsideAgent.issue';

/** Who the owner's questions about the outside agent name. */
export const OUTSIDE_AGENT_WORDS = 'the outside agent "goodvibes-daemon mcp serve"';

/** The words of the outside agent's one question at its first start: the project it was started in, or none. */
export function outsideAgentQuestion(project: string | undefined): string {
  return project !== undefined ? `Let ${OUTSIDE_AGENT_WORDS} work in ${project}` : `Let ${OUTSIDE_AGENT_WORDS} have a credential of its own, for shared things only`;
}

export const builtinGatewayProgramsMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: OUTSIDE_AGENT_ISSUE_METHOD_ID,
    // A second ask while one is kept is refused; it never makes a second credential.
    repeat: 'safe',
    title: 'Issue the Outside Agent Credential',
    description: 'The one credential this daemon gives `goodvibes-daemon mcp serve`, asked for with the operator token: a paired-device token named "Outside agent (goodvibes-daemon mcp serve)" (origin automation), with no person\'s claim, answered once with `token` and `id`. Making it is the owner\'s own act: from anyone but him it is put to him as ONE question, "Let the outside agent "goodvibes-daemon mcp serve" work in <project>?" when the call names the folder it was started in (`project`), else its credential for shared things only; his yes issues it and gives it that project. A second ask while it is kept is refused 409 OUTSIDE_AGENT_ISSUED (revoke it among the paired devices to have a new one issued). Every act of it the owner decides is put to him, and the first time it names a project it was not given he is asked whether it may work there.',
    category: 'pairing',
    effects: ['control-plane.administer'],
    // `project`: the folder the server was started in: the owner's one question names it, and his yes gives it.
    inputSchema: objectSchema({ confirm: BOOLEAN_SCHEMA, project: STRING_SCHEMA }, []),
    notWorkFolders: { project: 'the folder the owner\'s one question names and his yes gives the outside agent: given through the one project rule (registered, never a folder that can never be a project); nothing works in it by this call' },
    outputSchema: objectSchema({ id: STRING_SCHEMA, token: STRING_SCHEMA, name: STRING_SCHEMA }, ['id', 'token', 'name']),
    errorCodes: [{ code: 'OUTSIDE_AGENT_ISSUED', status: 409, meaning: 'The outside agent already has its credential from this daemon; revoke it among the paired devices to have a new one issued.' }],
  }),
];
