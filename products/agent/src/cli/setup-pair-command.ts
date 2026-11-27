import { createInterface } from 'node:readline/promises';
import { splitCommandOption } from '@goodvibes/engine/terminal-shell/cli-arguments';
import type { CliCommandRuntime } from './management.ts';
import { pairAgentHostWithCode, unpairAgentHost } from '../runtime/agent-host-pairing.ts';

import { formatSetupPairing } from '../runtime/setup-pairing-presentation.ts';
export { formatSetupPairing } from '../runtime/setup-pairing-presentation.ts';

export interface SetupPairingTerminal {
  readonly interactive: boolean;
  write(text: string): void;
  question(text: string, signal: AbortSignal): Promise<string>;
}

/**
 * `goodvibes-agent setup unpair`: forget the stored device credential for the selected host, or an earlier attempt
 * whose reply was lost. Local only; exit 0 when it was forgotten, 1 otherwise.
 */
export async function runSetupUnpairCommand(runtime: CliCommandRuntime): Promise<number> {
  if (runtime.cli.commandArgs.length > 1) {
    console.error('Usage: goodvibes-agent setup unpair. It forgets the device credential stored for the selected host (daemon.connectedHost.url, or the daemon on this machine).');
    return 2;
  }
  const result = await unpairAgentHost({ configManager: runtime.configManager, homeDirectory: runtime.homeDirectory });
  process.stdout.write(`${runtime.cli.flags.outputFormat === 'json' ? JSON.stringify(result) : formatSetupPairing(result)}\n`);
  return result.status === 'cleared' ? 0 : 1;
}

/**
 * `goodvibes-agent setup pair --with-code`: the owner's own pairing of this Agent as their device (gate-review-6 G1). They
 * start it in their signed-in web UI (Devices and network, Pair something, "Show the sign-in code once") and type or
 * paste the code here; it is read from the terminal (never an argument, which other processes can read), and the
 * host must confirm it as a device of the owner's.
 */
async function runSetupPairWithCode(runtime: CliCommandRuntime, name: string, terminal?: SetupPairingTerminal): Promise<number> {
  const interactive = terminal?.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) { console.error('Pairing with a code is typed in a terminal: run goodvibes-agent setup pair --with-code there. Nothing was changed.'); return 2; }
  const controller = new AbortController();
  const reader = terminal ? undefined : createInterface({ input: process.stdin, output: process.stdout });
  try {
    const prompt = 'In your signed-in web UI: Devices and network, Pair something, then "Show the sign-in code once". Type or paste that code here (Enter alone cancels): ';
    const code = terminal ? await terminal.question(prompt, controller.signal) : await reader!.question(prompt, { signal: controller.signal });
    if (!code.trim()) { process.stdout.write('Pairing cancelled. Nothing was changed.\n'); return 2; }
    const result = await pairAgentHostWithCode({ configManager: runtime.configManager, homeDirectory: runtime.homeDirectory }, code, name, controller.signal);
    (terminal?.write ?? ((text: string) => { process.stdout.write(`${text}\n`); }))(formatSetupPairing(result));
    return result.status === 'paired' ? 0 : result.status === 'cancelled' ? 2 : 1;
  } finally {
    reader?.close();
  }
}

/** `goodvibes-agent setup pair [--name <device-name>] --with-code`: the one way this Agent is paired as a device. */
export async function runSetupPairingCommand(runtime: CliCommandRuntime, terminal?: SetupPairingTerminal): Promise<number> {
  const args = runtime.cli.commandArgs.slice(1);
  let name = 'GoodVibes Agent'; let named = false; let withCode = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--with-code' && !withCode) { withCode = true; continue; }
    const option = splitCommandOption(arg ?? '');
    if (option.name === '--name' && !named) {
      if (option.value !== undefined && option.value.trim().length > 0) { named = true; name = option.value; continue; }
      if (option.value === undefined && args[index + 1] && !args[index + 1]!.startsWith('--')) { named = true; name = args[++index]!; continue; }
    }
    withCode = false;
    break;
  }
  if (!withCode) {
    console.error('Usage: goodvibes-agent setup pair [--name <device-name>] --with-code. It pairs this Agent as your own device with the sign-in code your signed-in web UI shows (Devices and network, Pair something, "Show the sign-in code once"). The daemon on this machine needs no pairing.');
    return 2;
  }
  return runSetupPairWithCode(runtime, name, terminal);
}
