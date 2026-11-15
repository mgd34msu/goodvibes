/** Agent read mechanics. Access follows owner configuration, never a Jev classification. */
import type { Tool } from '../../types/tools.js';
import { assertAdmittedAgentRead } from '../../tools/read/admission.js';
export { assertAdmittedAgentRead } from '../../tools/read/admission.js';

export const AGENT_READ_ADMISSION_DENIAL_MESSAGE = 'Agent read held: missing, stale, cancelled or unadmitted read authority.';

/** A read runs only under the admission recorded for its exact subjects; nothing here decides a second time. */
export function wrapReadToolForAdmittedAgentPolicy(tool: Tool): void {
  const execute = tool.execute.bind(tool);
  tool.execute = async (args, options) => {
    try { assertAdmittedAgentRead(args, options); }
    catch { return { success: false, error: AGENT_READ_ADMISSION_DENIAL_MESSAGE }; }
    return execute(args, options);
  };
}
