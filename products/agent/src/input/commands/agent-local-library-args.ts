import type { CommandContext } from '../command-registry.ts';
import { requireShellPaths } from './runtime-services.ts';

export interface ParsedAgentLocalLibraryArgs {
  readonly rest: readonly string[];
  readonly flags: ReadonlyMap<string, string>;
  readonly yes: boolean;
}

export interface AgentLocalLibraryArgOptions {
  readonly valueFlags: readonly string[];
}

export function parseAgentLocalLibraryArgs(
  args: readonly string[],
  options: AgentLocalLibraryArgOptions,
): ParsedAgentLocalLibraryArgs {
  const valueFlags = new Set(options.valueFlags);
  const flags = new Map<string, string>();
  const rest: string[] = [];
  let yes = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? '';
    if (token === '--') {
      rest.push(...args.slice(index + 1));
      break;
    }
    if (token === '--yes') {
      yes = true;
      continue;
    }
    if (token.startsWith('--') && token.length > 2) {
      const raw = token.slice(2);
      const equalIndex = raw.indexOf('=');
      if (equalIndex >= 0) {
        flags.set(raw.slice(0, equalIndex), raw.slice(equalIndex + 1));
        continue;
      }
      if (valueFlags.has(raw)) {
        const next = args[index + 1];
        if (next !== undefined) {
          flags.set(raw, next);
          index += 1;
        } else {
          flags.set(raw, '');
        }
        continue;
      }
      flags.set(raw, 'true');
      continue;
    }
    rest.push(token);
  }
  return { rest, flags, yes };
}

/**
 * A file argument resolved the way every other Agent command resolves one: relative
 * to the workspace, `~` meaning the Agent home. A model-run command may only name
 * a place inside the workspace; the owner typing the command may name any path.
 * Returns null after printing why when the path is refused.
 */
export function resolveCommandFilePath(ctx: CommandContext, raw: string, purpose: 'read' | 'write'): string | null {
  const shellPaths = requireShellPaths(ctx);
  const resolved = shellPaths.resolveWorkspacePath(raw);
  if (ctx.invokedByModel === true && !shellPaths.isWithinWorkingDirectory(resolved)) {
    ctx.print(`Refused: ${raw} is outside the workspace (${shellPaths.workingDirectory}). A command run by the model can ${purpose} only inside the workspace; the owner can type the command with that path.`);
    return null;
  }
  return resolved;
}
