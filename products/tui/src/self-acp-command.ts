import { join } from 'node:path';

/**
 * `/remote dispatch` and delegation start copies of this program as ACP
 * agents; only the product knows how it was launched, so it says how. Called
 * before a command that may start one (a turn, the terminal UI, management),
 * never for `status` or `doctor`, which load none of the ACP code.
 */
export async function registerSelfAcpCommand(): Promise<void> {
  const { registerSelfAcpAgentCommand } = await import('@goodvibes/engine/platform/platform/acp');
  const compiled = import.meta.path.startsWith('/$bunfs/') || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(import.meta.path);
  registerSelfAcpAgentCommand(compiled ? [process.execPath, 'acp'] : [process.execPath, 'run', join(import.meta.dir, 'main.ts'), 'acp']);
}
