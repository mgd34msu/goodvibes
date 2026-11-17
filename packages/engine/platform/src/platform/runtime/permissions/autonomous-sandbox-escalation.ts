/** Exact sandbox-plan admission. This never widens the plan or changes its argv. */
import { randomUUID } from 'node:crypto';
import { admitExternalRequest } from '../../permissions/external-request.js';
import { currentExternalOperationSource } from '../../permissions/external-operation-scope.js';
import { logAdmissionFailure } from './admission-failure.js';
import { openAutonomousAdmission, type AutonomousAdmissionScope } from './autonomous-admission.js';
import type { AutonomousToolPromptHost } from './autonomous-tool-prompts.js';
import type { SandboxEscalationExecution, SandboxEscalationPermit, SandboxEscalationRequest } from '../../tools/exec/sandbox.js';

export async function admitSandboxEscalation(host: AutonomousToolPromptHost, input: SandboxEscalationRequest,
  execution?: SandboxEscalationExecution): Promise<SandboxEscalationPermit | false> {
  const operation = currentExternalOperationSource();
  if (!operation || !execution) return false;
  let scope: AutonomousAdmissionScope | undefined;
  let admission: Awaited<ReturnType<typeof admitExternalRequest>> | undefined;
  let transferred = false;
  try {
    scope = await openAutonomousAdmission(host, operation, execution, 'execute', 'Sandbox escalation');
    if (!scope) return false;
    const opened = scope;
    opened.assertCurrent();
    admission = await admitExternalRequest(host, { connectionId: randomUUID(), destination: 'owned-exec-sandbox', signal: opened.signal, assertCurrent: opened.assertCurrent }, operation, {
      tool: 'exec', args: { commands: [{ cmd: input.command, cwd: input.workingDirectory }], sandboxEscalation: input },
    }, opened);
    opened.assertCurrent();
    if (!admission.result.approved) return false;
    const owned = admission;
    transferred = true;
    return Object.freeze({ signal: opened.signal, assertCurrent: opened.assertCurrent, claim() { opened.assertCurrent(); owned.claim(); },
      close() { owned.close(); opened.close(); } });
  } catch (error) { logAdmissionFailure('sandbox escalation', error); return false; }
  finally { if (!transferred) { admission?.close(); scope?.close(); } }
}
