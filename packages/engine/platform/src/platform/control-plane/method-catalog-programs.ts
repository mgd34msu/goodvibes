/**
 * method-catalog-programs.ts, the method the outside agent's server uses to be known to the daemon as itself (handler:
 * daemon/capability-wiring.ts). A terminal program registers through no method: only over the daemon's program socket
 * (daemon/program-socket.ts), where the kernel names who connected.
 *
 * `pairing.outsideAgent.issue`: `goodvibes-daemon mcp serve` asks, with the operator token, for the one credential of
 * its own this daemon gives an outside agent: a paired device with full operator authority, issued once (a second ask
 * while one is kept is refused: revoked among the paired devices, it can be issued again). It is the user's own
 * credential: it names any project, and nothing is asked for that (daemon/outside-agent.ts).
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
    description: 'The one credential this daemon gives `goodvibes-daemon mcp serve`, asked for with the operator token: a paired-device token named "Outside agent (goodvibes-daemon mcp serve)" holding full operator authority, as the operator token does, answered once with `token` and `id`. Nothing is asked and nothing is refused: it is issued at once, and it names any project. `project` (the folder the server was started in) is accepted and not needed. A second ask while it is kept is refused 409 OUTSIDE_AGENT_ISSUED (revoke it among the paired devices to have a new one issued).',
    category: 'pairing',
    effects: ['control-plane.administer'],
    // `project`: the folder the server was started in; said to the person, not given or checked.
    inputSchema: objectSchema({ confirm: BOOLEAN_SCHEMA, project: STRING_SCHEMA }, []),
    notWorkFolders: { project: 'the folder the server was started in; accepted and not needed: nothing works in it by this call, and the credential names any project' },
    outputSchema: objectSchema({ id: STRING_SCHEMA, token: STRING_SCHEMA, name: STRING_SCHEMA }, ['id', 'token', 'name']),
    errorCodes: [{ code: 'OUTSIDE_AGENT_ISSUED', status: 409, meaning: 'The outside agent already has its credential from this daemon; revoke it among the paired devices to have a new one issued.' }],
  }),
];
