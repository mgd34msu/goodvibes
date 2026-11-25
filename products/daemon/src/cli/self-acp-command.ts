import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { registerSelfAcpAgentCommand } from '@goodvibes/engine/platform/platform/acp';

/**
 * The remote runners the daemon starts are copies of the terminal app run as
 * ACP agents (`goodvibes acp`). The daemon is not that program, so it names
 * it: the `goodvibes` installed beside this daemon, or, run from source, the
 * terminal app's entry point in the same tree. `ACP_AGENT_CMD` still wins.
 * When neither is found nothing is registered, and starting a runner says
 * what to set.
 */
export function registerDaemonAcpAgentCommand(): void {
  const compiled = import.meta.path.startsWith('/$bunfs/') || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(import.meta.path);
  if (compiled) {
    const sibling = join(dirname(process.execPath), process.platform === 'win32' ? 'goodvibes.exe' : 'goodvibes');
    if (existsSync(sibling)) registerSelfAcpAgentCommand([sibling, 'acp']);
    return;
  }
  const entry = join(import.meta.dir, '..', '..', '..', 'tui', 'src', 'main.ts');
  if (existsSync(entry)) registerSelfAcpAgentCommand([process.execPath, 'run', entry, 'acp']);
}
