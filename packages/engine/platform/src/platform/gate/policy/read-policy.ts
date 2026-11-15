/** Agent read mechanics. Access follows owner configuration, never a Jev classification. */
import type { Tool } from '../../types/tools.js';
import { hasAgentReadAdmission } from '../../tools/read/admission.js';
import { describeToolInputProjectionProblem } from '../../tools/input-projection.js';
export { assertAdmittedAgentRead } from '../../tools/read/admission.js';

/** The refusal for a read that reached the tool with no admission recorded for its files. */
export const AGENT_READ_ADMISSION_DENIAL_MESSAGE = describeToolInputProjectionProblem('held',
  'No admission was recorded for these files, so nothing was read. Issue the read as its own tool call.');

/**
 * In the Agent a read runs only under the admission recorded for its exact
 * subjects. This wrapper requires that one exists; the reader's own guard
 * checks it still holds and names the state (stale, cancelled, changed) when not.
 */
export function wrapReadToolForAdmittedAgentPolicy(tool: Tool): void {
  const execute = tool.execute.bind(tool);
  tool.execute = async (args, options) => {
    if (!hasAgentReadAdmission(options)) return { success: false, error: AGENT_READ_ADMISSION_DENIAL_MESSAGE };
    return execute(args, options);
  };
}
