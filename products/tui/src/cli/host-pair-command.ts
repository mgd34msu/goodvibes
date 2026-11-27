import { GOODVIBES_TUI_SURFACE_ROOT } from '../config/surface.ts';
import { createInterface } from 'node:readline/promises';
import { TuiConfigManager } from '../config/host-settings.ts';
import { applyRuntimeConfigValue } from '@goodvibes/engine/terminal-shell';
import { canonicalizePairingHost } from '../runtime/tui-host-credential-store.ts';
import { formatTuiHostPairing, pairTuiHostWithCode, unpairTuiHost } from '../runtime/tui-host-pairing.ts';

export const TUI_HOST_PAIR_HELP = 'Usage: goodvibes host pair [--url <exact-origin>] [--name <device-name>] | goodvibes host unpair [--url <exact-origin>]. pair reads the sign-in code your own signed-in screen shows (Devices and network, Pair something, "Show the sign-in code once") and keeps it as this terminal\'s key for the host. unpair forgets the stored device credential for the host, or an earlier attempt whose reply was lost.';
export interface TuiHostPairingTerminal {
  readonly interactive: boolean;
  write(text: string): void;
  question(text: string, signal: AbortSignal): Promise<string>;
}

/** This standalone route exits before ordinary startup, onboarding, daemon
 * adoption, generic command dispatch, or any model/tool runtime is created.
 */
export async function runTuiHostCommand(
  args: readonly string[],
  roots: { readonly homeDirectory: string; readonly defaultWorkingDirectory: string },
  terminal?: TuiHostPairingTerminal,
): Promise<number> {
  let reader: ReturnType<typeof createInterface> | undefined;
  const controller = new AbortController(); const interrupt = () => controller.abort();
  const io = terminal ?? {
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    write: (text: string) => { process.stdout.write(`${text}\n`); },
    question: (text: string, signal: AbortSignal) => {
      reader = createInterface({ input: process.stdin, output: process.stdout });
      reader.on('SIGINT', interrupt); reader.on('close', interrupt);
      return reader.question(text, { signal });
    },
  };
  let name = 'GoodVibes TUI'; let url: string | undefined;
  const seen = new Set<string>();
  if (args.length === 0 || args.length === 1 && (args[0] === '--help' || args[0] === 'help')) { io.write(TUI_HOST_PAIR_HELP); return 0; }
  if (args[0] === 'unpair') {
    let unpairUrl: string | undefined;
    if (args.length === 3 && args[1] === '--url') unpairUrl = args[2];
    else if (args.length !== 1) { io.write(TUI_HOST_PAIR_HELP); return 2; }
    if (unpairUrl !== undefined && !canonicalizePairingHost(unpairUrl)) { io.write('Use an exact HTTP(S) origin without a path, user information, query or fragment.'); return 2; }
    const configManager = new TuiConfigManager({ workingDir: roots.defaultWorkingDirectory, homeDir: roots.homeDirectory, surfaceRoot: GOODVIBES_TUI_SURFACE_ROOT, readOnly: true });
    if (unpairUrl !== undefined) applyRuntimeConfigValue(configManager, 'controlPlane.publicBaseUrl', canonicalizePairingHost(unpairUrl)!);
    const result = await unpairTuiHost({ configManager, homeDirectory: roots.homeDirectory });
    io.write(formatTuiHostPairing(result));
    return result.status === 'cleared' ? 0 : 1;
  }
  if (args[0] !== 'pair') { io.write(TUI_HOST_PAIR_HELP); return 2; }
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--help' && args.length === 2) { io.write(TUI_HOST_PAIR_HELP); return 0; }
    if (seen.has(arg)) { io.write(TUI_HOST_PAIR_HELP); return 2; }
    seen.add(arg);
    if ((arg === '--url' || arg === '--name') && args[index + 1] && !args[index + 1]!.startsWith('--')) {
      const value = args[++index]!;
      if (arg === '--url') url = value; else name = value;
      continue;
    }
    io.write(TUI_HOST_PAIR_HELP); return 2;
  }
  if (url !== undefined && !canonicalizePairingHost(url)) { io.write('Use an exact HTTP(S) origin without a path, user information, query or fragment.'); return 2; }
  // The code is the device's key: it is read from the terminal, never an argument other processes can read.
  if (!io.interactive) { io.write('Pairing with a sign-in code is typed in a terminal: run goodvibes host pair there. Nothing was changed.'); return 2; }
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    const configManager = new TuiConfigManager({ workingDir: roots.defaultWorkingDirectory, homeDir: roots.homeDirectory, surfaceRoot: GOODVIBES_TUI_SURFACE_ROOT, readOnly: true });
    if (url !== undefined) applyRuntimeConfigValue(configManager, 'controlPlane.publicBaseUrl', canonicalizePairingHost(url)!);
    const code = await io.question('In your signed-in web UI: Devices and network, Pair something, then "Show the sign-in code once". Type or paste that code here (Enter alone cancels): ', controller.signal);
    if (!code.trim()) { io.write('Pairing cancelled. Nothing was changed.'); return 2; }
    const result = await pairTuiHostWithCode({ configManager, homeDirectory: roots.homeDirectory }, code, name, controller.signal);
    io.write(formatTuiHostPairing(result));
    return controller.signal.aborted ? 130 : result.status === 'paired' ? 0 : result.status === 'cancelled' ? 2 : 1;
  } catch {
    io.write('Pairing interrupted. Run goodvibes host pair again to see where it got to.');
    return controller.signal.aborted ? 130 : 1;
  } finally {
    reader?.removeListener('SIGINT', interrupt); reader?.removeListener('close', interrupt); reader?.close();
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
}
