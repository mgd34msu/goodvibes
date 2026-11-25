/**
 * headless-held-calls.ts, what a headless run with nobody to answer it does
 * with a call its gate wants the owner to decide.
 *
 * The run cannot have it answered (no person, no `--answer-permissions`
 * script), so the question is not the run's: it is the owner's, in his shared
 * list. A `capability_run` call of a capability the daemon runs is handed to
 * the daemon as the call it is (`capabilities.run`, with this program's own
 * credential and no claim that a person asked): the daemon's gate decides it
 * once under the owner's mode, puts it to him in Waiting for you worded as
 * the capability (its label, its sentence, each input on a labelled line, a
 * secret hidden), and runs it when he approves it. The run's frame says the
 * call is held for him and where. Nothing is raised a second time anywhere.
 *
 * Any other call (a command, a file write, a capability of the conversation)
 * can only run inside this run, which ends without it: it is held for the
 * owner in the run's own result (`heldForOwner`), as a just-vibes run holds
 * what it does not run, and not posted where an answer would decide nothing.
 */
import type { PermissionPromptDecision, PermissionPromptRequest } from '@goodvibes/engine/platform/platform/permissions';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import { captureOperatorConnection } from '../agent-turn/operator-connection-owner.js';
import type { ConnectedHostConfigReader } from '../agent-turn/connected-host-client.js';

const NOBODY = 'held for you: nobody in this run can answer it, and it runs only inside this run, which goes on without it';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const held = (reason: string): PermissionPromptDecision => ({ approved: false, remember: false, heldForOwner: true, reason });

/** A call this run held for the owner through the daemon: the approval it waits as (`id`), the capability, its words. */
export interface HeldThroughDaemon {
  readonly id: string;
  readonly tool: string;
  readonly summary: string;
  readonly reason: string;
}

/** The prompt of a headless run nobody answers: each ask is held for the owner (see the header). */
export function holdForOwnerInHeadlessRun(host: {
  readonly shellPaths: Pick<ShellPathService, 'homeDirectory' | 'workingDirectory'>;
  readonly configManager: ConnectedHostConfigReader;
}, onHeld?: (call: HeldThroughDaemon) => void): (request: PermissionPromptRequest) => Promise<PermissionPromptDecision> {
  return async (request) => {
    if (request.tool !== 'capability_run') return held(NOBODY);
    const id = typeof request.args['id'] === 'string' ? request.args['id'].trim() : '';
    const inputs = record(request.args['inputs']);
    // A secret reached the gate hidden; it is typed by the person, never sent on as its placeholder.
    if (!id || Object.values(inputs).some((value) => typeof value === 'string' && value.startsWith('(hidden'))) return held(NOBODY);
    let connection: ReturnType<typeof captureOperatorConnection>;
    try {
      connection = captureOperatorConnection(host.shellPaths, host.configManager, () => {});
    } catch {
      return held(NOBODY);
    }
    if (!connection.token) return held(NOBODY);
    try {
      connection.assertCurrent();
      const response = await (connection.fetch ?? fetch)(`${connection.baseUrl}/api/control-plane/methods/capabilities.run/invoke`, {
        method: 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ body: { id, inputs, workingDirectory: host.shellPaths.workingDirectory } }),
      });
      const body = record(await response.json().catch(() => null));
      if (response.status === 202 && body['code'] === 'OWNER_APPROVAL_PENDING' && typeof body['approvalId'] === 'string') {
        const reason = `held for you: ${typeof body['state'] === 'string' ? body['state'] : `it waits in Waiting for you as approval ${body['approvalId']}`}. This run goes on without it`;
        // The run's result names it (heldForOwner), by the approval it waits as.
        try { onHeld?.({ id: body['approvalId'], tool: id, summary: typeof body['label'] === 'string' ? body['label'] : id, reason }); } catch { /* the hold stands */ }
        return held(reason);
      }
      if (response.ok) {
        // The daemon's gate decided it under the owner's mode without asking him, and ran it there.
        return held(`not run here: the daemon decided it under your mode and ran it. ${typeof body['text'] === 'string' ? body['text'] : ''}`.trim());
      }
      const said = typeof body['error'] === 'string' ? body['error'] : `the daemon answered ${response.status}`;
      // A capability of the conversation is this run's own: the daemon says so, and it stays held here.
      if (body['code'] === 'CAPABILITY_ELSEWHERE' || body['code'] === 'CAPABILITY_NOT_FOUND') return held(NOBODY);
      return { approved: false, remember: false, reason: `not run: ${said}` };
    } catch {
      return held(NOBODY);
    }
  };
}
