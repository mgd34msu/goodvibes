// Small config-read helpers shared by agent-workspace-snapshot.ts and
// agent-workspace-snapshot-builders.ts (split out of the runtime-snapshot giant
// assembler). Each never throws: config reads fall back to the given default on any
// error. A runtime with no config manager is simply unconfigured, but when the manager
// exists and a read fails, `failures` (if passed) records `config:<key>` so the caller can
// say the shown value is a default, not the stored one.
import type { CommandContext } from './command-registry.ts';
import { getAgentWorkspaceConfigReader } from './agent-workspace-config-reader.ts';

export function readConfigValue(context: CommandContext, key: string, failures: Map<string, string> | undefined): unknown {
  let reader: ReturnType<typeof getAgentWorkspaceConfigReader>;
  try {
    reader = getAgentWorkspaceConfigReader(context);
  } catch {
    return undefined;
  }
  try {
    return reader?.get(key);
  } catch (error) {
    failures?.set(`config:${key}`, error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

export function readConfigString(context: CommandContext, key: string, fallback: string, failures?: Map<string, string>): string {
  const value = readConfigValue(context, key, failures);
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

export function readConfigNumber(context: CommandContext, key: string, fallback: number, failures?: Map<string, string>): number {
  const value = readConfigValue(context, key, failures);
  const numberValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

export function readConfigBoolean(context: CommandContext, key: string, fallback: boolean, failures?: Map<string, string>): boolean {
  const value = readConfigValue(context, key, failures);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
}
