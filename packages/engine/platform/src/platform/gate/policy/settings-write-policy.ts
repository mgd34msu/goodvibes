/** Agent settings writes use the configured tool permissions and native settings validation. */
import type { Tool } from '../../types/tools.js';
import { isValidConfigKey } from '../../config/schema.js';
import { agentSettingsWriteRefusal, type SettingsToolArgs } from './agent-settings-refusals.js';
export type { SettingsToolArgs } from './agent-settings-refusals.js';

/**
 * What the settings tool's input projector would say about a call, for an
 * explanation only: it runs no check on the write path and grants nothing.
 */
export function validateAgentSettingsMechanics(args: SettingsToolArgs): string | null {
  if (args.mode !== 'set' && args.mode !== 'reset') return 'Settings accepts only set or reset.';
  if (typeof args.key !== 'string' || !isValidConfigKey(args.key.trim())) return 'Settings requires a registered key.';
  return agentSettingsWriteRefusal(args);
}

/**
 * The adopted Agent settings tool. Its input projector validates and refuses a
 * write before any effect and the admitted backend checks the recorded
 * admission, so the wrapper only states what the tool does.
 */
export function wrapSettingsToolForAdmittedAgentPolicy(tool: Tool): void {
  tool.definition.description = [
    'Apply or reset a GoodVibes setting through its actual owning runtime.',
    'Writes use the configured tool permissions and the owning runtime’s settings validation.',
    'A secret-bearing setting takes only its own goodvibes:// secret reference; card details and credential destinations are the owner\'s to set.',
  ].join(' ');
}
