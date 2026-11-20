import { createInterface } from 'node:readline/promises';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils';
import type { CliCommandRuntime } from './management.ts';
import { previewAgentHostPairing, unpairAgentHost } from '../runtime/agent-host-pairing.ts';

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
    console.error('Usage: goodvibes-agent setup unpair. It forgets the device credential stored for the selected host (controlPlane.host and controlPlane.port).');
    return 2;
  }
  const result = await unpairAgentHost({ configManager: runtime.configManager, homeDirectory: runtime.homeDirectory });
  process.stdout.write(`${runtime.cli.flags.outputFormat === 'json' ? JSON.stringify(result) : formatSetupPairing(result)}\n`);
  return result.status === 'cleared' ? 0 : 1;
}

/** No --yes, scripted answer, or model-supplied confirmation bypass. */
export async function runSetupPairingCommand(runtime: CliCommandRuntime, terminal?: SetupPairingTerminal): Promise<number> {
  const args = runtime.cli.commandArgs.slice(1);
  let name = 'GoodVibes Agent'; let apply = false; let named = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--apply' && !apply) { apply = true; continue; }
    if (arg === '--name' && !named && args[index + 1] && !args[index + 1]!.startsWith('--')) {
      named = true; name = args[++index]!; continue;
    }
    console.error('Usage: goodvibes-agent setup pair [--name <device-name>] [--apply]. --apply requires fresh terminal confirmation; --yes is unsupported.');
    return 2;
  }
  if (apply && runtime.cli.flags.outputFormat !== 'text') { console.error('Pairing --apply requires a visible terminal confirmation; machine-readable output modes are preview-only.'); return 2; }
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
    if (!io.interactive) { io.write('No credential was created. Run --apply in a terminal to review and confirm persistent administrative access.'); return 2; }
    const answer = await io.question(`Type ${preview.result.confirmation} to ${preview.result.confirmationPrompt ?? 'create this host-bound administrative credential'}, or press Enter to cancel: `, controller.signal);
    confirmInvoked = true;
    const result = await preview.confirm(answer, controller.signal);
    io.write(formatSetupPairing(result));
    return controller.signal.aborted ? 130 : result.status === 'paired' || result.status === 'paired-shadowed' || result.status === 'cleared' ? 0 : result.status === 'cancelled' ? 2 : 1;
  } catch (error) {
    // Only an interruption, or a failure after the credential request was issued, leaves an outcome to inspect;
    // an earlier failure is a plain error and its cause is shown.
    if (controller.signal.aborted || confirmInvoked) {
      io.write('Pairing interrupted. If a request may have started, run goodvibes-agent setup pair to inspect its outcome before taking further action.');
    } else {
      console.error(`Pairing failed before any credential was requested: ${summarizeError(error)}`);
    }
    return controller.signal.aborted ? 130 : 1;
  }
  finally {
    reader?.removeListener('SIGINT', interrupt); reader?.removeListener('close', interrupt); reader?.close();
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
}
