import { createInterface } from 'node:readline/promises';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils';
import { splitCommandOption } from '@goodvibes/engine/terminal-shell/cli-arguments';
import type { CliCommandRuntime } from './management.ts';
import { pairAgentHostWithCode, previewAgentHostPairing, unpairAgentHost } from '../runtime/agent-host-pairing.ts';

import { formatSetupPairing } from '../runtime/setup-pairing-presentation.ts';
export { formatSetupPairing } from '../runtime/setup-pairing-presentation.ts';

export interface SetupPairingTerminal {
  readonly interactive: boolean;
  write(text: string): void;
  question(text: string, signal: AbortSignal): Promise<string>;
}

/**
 * `goodvibes-agent setup unpair`: forget the stored device credential for the
 * selected host. Local only; exit 0 when it was forgotten, 1 otherwise.
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
 * `goodvibes-agent setup pair --with-code`: the owner's own pairing of this Agent as his device (gate-review-6 G1). He
 * starts it in his signed-in web UI (Devices and network, Pair something, "Show the sign-in code once") and types or
 * pastes the code here; it is read from the terminal (never an argument, which other processes can read), and the
 * host must confirm it as a device of his.
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

/** No --yes, scripted answer, or model-supplied confirmation bypass. */
export async function runSetupPairingCommand(runtime: CliCommandRuntime, terminal?: SetupPairingTerminal): Promise<number> {
  const args = runtime.cli.commandArgs.slice(1);
  let name = 'GoodVibes Agent'; let apply = false; let named = false; let withCode = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--apply' && !apply) { apply = true; continue; }
    if (arg === '--with-code' && !withCode) { withCode = true; continue; }
    const option = splitCommandOption(arg ?? '');
    if (option.name === '--name' && !named) {
      if (option.value !== undefined && option.value.trim().length > 0) { named = true; name = option.value; continue; }
      if (option.value === undefined && args[index + 1] && !args[index + 1]!.startsWith('--')) { named = true; name = args[++index]!; continue; }
    }
    console.error('Usage: goodvibes-agent setup pair [--name <device-name>] [--apply | --with-code]. --apply asks you to confirm in the terminal; there is no --yes. --with-code pairs this Agent as your own device with the sign-in code your signed-in web UI shows (Devices and network, Pair something).');
    return 2;
  }
  if (withCode && apply) { console.error('Use --with-code or --apply, not both.'); return 2; }
  if (withCode) return runSetupPairWithCode(runtime, name, terminal);
  if (apply && runtime.cli.flags.outputFormat !== 'text') { console.error('Pairing with --apply is confirmed on screen, so it needs text output; with --output json it only shows what pairing would do.'); return 2; }
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  let reader: ReturnType<typeof createInterface> | undefined;
  let confirmInvoked = false;
  const io = terminal ?? {
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    write: (text: string) => { process.stdout.write(`${text}\n`); },
    question: (text: string, signal: AbortSignal) => {
      reader = createInterface({ input: process.stdin, output: process.stdout });
      // In a real terminal readline owns raw input: Ctrl-C is its SIGINT
      // event, not a process signal. EOF also closes a pending question without
      // settling it. Keep both cancellation owners through the request and
      // verification, then remove them before our own intentional close.
      reader.on('SIGINT', interrupt);
      reader.on('close', interrupt);
      return reader.question(text, { signal });
    },
  };
  try {
    const preview = await previewAgentHostPairing({ configManager: runtime.configManager, homeDirectory: runtime.homeDirectory }, name, controller.signal);
    io.write(runtime.cli.flags.outputFormat === 'json' ? JSON.stringify(preview.result) : formatSetupPairing(preview.result));
    // The preview names the one command that goes on from it.
    if (!apply && preview.result.status === 'preview' && runtime.cli.flags.outputFormat === 'text') {
      io.write(`  Next: run goodvibes-agent setup pair --apply${named ? ` --name ${JSON.stringify(name)}` : ''} in a terminal to confirm and pair.`);
    }
    if (!apply || !preview.confirm || !preview.result.confirmation) return controller.signal.aborted ? 130 : preview.result.status === 'preview' || preview.result.status === 'already-paired' ? 0 : 1;
    if (!io.interactive) { io.write('Nothing was created. Pairing gives lasting administrator access, so it is confirmed only in a terminal: run goodvibes-agent setup pair --apply there.'); return 2; }
    const answer = await io.question(`To ${preview.result.confirmationPrompt ?? 'give this Agent its own administrator key for this host'}, type ${preview.result.confirmation} and press Enter (Enter alone cancels): `, controller.signal);
    confirmInvoked = true;
    const result = await preview.confirm(answer, controller.signal, (text) => io.write(text));
    io.write(formatSetupPairing(result));
    return controller.signal.aborted ? 130 : result.status === 'paired' || result.status === 'paired-shadowed' || result.status === 'cleared' ? 0 : result.status === 'cancelled' ? 2 : 1;
  } catch (error) {
    // Only an interruption, or a failure after the credential request was issued, leaves an outcome to inspect;
    // an earlier failure is a plain error and its cause is shown.
    if (controller.signal.aborted || confirmInvoked) {
      io.write('Pairing interrupted. If a request may have been sent, run goodvibes-agent setup pair to see where it got to before doing anything else.');
    } else {
      console.error(`Pairing failed before anything was sent to the host: ${summarizeError(error)}`);
    }
    return controller.signal.aborted ? 130 : 1;
  }
  finally {
    reader?.removeListener('SIGINT', interrupt); reader?.removeListener('close', interrupt); reader?.close();
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
}
