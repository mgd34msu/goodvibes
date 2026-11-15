/** Agent settings writes use the configured tool permissions and native settings validation. */
import type { Tool } from '../../types/tools.js';
import { isValidConfigKey } from '../../config/schema.js';
import { assertAdmittedAgentSettings } from '../../tools/goodvibes-runtime/settings-admission.js';
import { agentSettingsWriteRefusal } from './agent-settings-refusals.js';
import type { SettingsToolArgs } from './settings-write-evidence.js';
export type { SettingsToolArgs } from './settings-write-evidence.js';

/** Mechanical explanation only. Passing it never authorizes a settings effect. */
export function validateAgentSettingsMechanics(args: SettingsToolArgs): string | null {
  if (args.mode !== 'set' && args.mode !== 'reset') return 'Settings accepts only set or reset.';
  if (typeof args.key !== 'string' || !isValidConfigKey(args.key.trim())) return 'Settings requires a registered key.';
  return agentSettingsWriteRefusal(args);
}

/** Adopted Agent surface: the same recorded admission owns hazard/request judgment. */
export function wrapSettingsToolForAdmittedAgentPolicy(tool: Tool): void {
  tool.definition.description = [
    'Apply or reset a GoodVibes setting through its actual owning runtime.',
    'Writes use the configured tool permissions and the owning runtime’s settings validation.',
    'Raw credentials are refused; use an existing goodvibes:// secret reference or clear the setting.',
  ].join(' ');
  const original = tool.execute.bind(tool);
  tool.execute = async (args, options) => {
    const problem = validateAgentSettingsMechanics(args);
    if (problem) return { success: false, error: problem };
    assertAdmittedAgentSettings(args, options);
    return original(args, options);
  };
}
