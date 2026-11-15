/**
 * The one rule for what makes a `contract.gates` entry runnable. The settings
 * schema refuses a list that breaks it when the list is saved, and the contract
 * runner reports what is wrong when a contract starts, so the owner hears it
 * before any check rather than through a worker's nudge. No imports: the
 * settings schema and the contract reader both use it.
 */

/** Why a gate entry is left out, or undefined when it can run. */
export function qualityGateEntryProblem(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'it is not a { name, command, enabled } object';
  const gate = value as Record<string, unknown>;
  if (typeof gate['name'] !== 'string' || typeof gate['command'] !== 'string' || typeof gate['enabled'] !== 'boolean') {
    return 'it needs a name and a command (text) and enabled (true or false)';
  }
  if (gate['required'] !== undefined && typeof gate['required'] !== 'boolean') return 'its required option has the wrong value (true or false)';
  if (gate['verification'] !== undefined && gate['verification'] !== 'command' && gate['verification'] !== 'assertions') {
    return 'its verification option has the wrong value ("command" or "assertions")';
  }
  return undefined;
}

/**
 * What is wrong with a `contract.gates` value, one sentence each with the fix.
 * Empty when every gate can run. One pass over the list.
 */
export function contractGateListProblems(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return ['contract.gates is not a list of gates, so no gate runs; set it to a list of { name, command, enabled }.'];
  const problems: string[] = [];
  const names = new Set<string>();
  raw.forEach((value, index) => {
    const named = value !== null && typeof value === 'object' && typeof (value as Record<string, unknown>)['name'] === 'string'
      ? (value as Record<string, unknown>)['name'] as string : undefined;
    const label = named !== undefined ? `the gate "${named}"` : `gate ${index + 1}`;
    const problem = qualityGateEntryProblem(value);
    if (problem !== undefined) {
      problems.push(`${label} does not run: ${problem}.`);
      return;
    }
    const gate = value as { name: string; command: string; enabled: boolean };
    if (names.has(gate.name)) problems.push(`${label} is listed twice; give each gate its own name.`);
    names.add(gate.name);
    if (gate.enabled && gate.command.trim().length === 0) problems.push(`${label} is enabled with an empty command, so it fails every check; give it a command or disable it.`);
  });
  return problems;
}

export const CONTRACT_GATE_LIST_HINT = 'list of { name, command, enabled } objects with optional required (true or false) and verification ("command" or "assertions"); each name once, and an enabled gate needs a command';
