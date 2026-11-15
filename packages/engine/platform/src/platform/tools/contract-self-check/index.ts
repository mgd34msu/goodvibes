// contract_self_check: a contract unit's agent reading how its own acceptance criteria read now.
//
// The identity comes from the host (the runner binds the calling agent around each call), never from
// an argument, so the tool cannot be pointed at another agent's unit. It reads state the runner already
// recorded and passes nothing.
import type { Tool, ToolDefinition, ToolResult } from '../../types/tools.js';
import type { ContractRunner } from '../../contract/runner.js';
import { describeUnitSelfCheck, UNIT_SELF_CHECK_TOOL } from '../../contract/self-check.js';
import { callingAgentId } from '../../agents/calling-agent.js';
import { summarizeError } from '../../utils/error-display.js';

const SCHEMA: Record<string, unknown> = { type: 'object', properties: {}, additionalProperties: false };

export function createContractSelfCheckTool(runner: Pick<ContractRunner, 'list'>): Tool {
  const definition: ToolDefinition = {
    name: UNIT_SELF_CHECK_TOOL,
    description: 'Read how your contract unit\'s acceptance criteria read now, from the last check, without ending your turn. '
      + 'Read-only; it passes nothing and describes the last check, not work done since.',
    parameters: SCHEMA,
    sideEffects: ['read_fs'],
    concurrency: 'parallel',
  };

  async function execute(): Promise<Omit<ToolResult, 'callId'>> {
    const agentId = callingAgentId();
    if (agentId === undefined) {
      return { success: false, error: 'This tool answers for a contract unit\'s agent; no agent is calling it.' };
    }
    try {
      const result = describeUnitSelfCheck(runner.list({ includeTerminal: false }), agentId);
      return result.found ? { success: true, output: JSON.stringify(result.selfCheck) } : { success: false, error: result.reason };
    } catch (error) {
      return { success: false, error: `${UNIT_SELF_CHECK_TOOL} failed: ${summarizeError(error)}` };
    }
  }

  return { definition, execute };
}
