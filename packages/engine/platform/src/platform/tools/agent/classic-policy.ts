import { decisionModelPolicyState } from '@goodvibes-jev/engine/errors';
import type { AgentInput } from './schema.js';

/** Classic delegates run as ordinary owner-authorized workers, without semantic
 * contract planning, acceptance, correction or a claim that those checks passed.
 * Existing source/tool/workspace restrictions remain on the worker input.
 */
export function classicAgentInput(input: AgentInput): AgentInput {
  return decisionModelPolicyState().operation === 'classic'
    ? { ...input, outsideContract: true, reviewMode: 'none' }
    : input;
}
