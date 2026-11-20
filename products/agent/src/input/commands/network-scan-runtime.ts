import type { CommandRegistry } from '../command-registry.ts';
import { requireShellPaths } from './runtime-services.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import {
  discoveredProvidersFilePath,
  loadLanScanConsent,
  saveLanScanConsent,
  startLanScanNow,
  NETWORK_SCAN_DISABLE_COMMAND,
  NETWORK_SCAN_ENABLE_COMMAND,
} from '../../runtime/lan-scan-consent.ts';
import type { CommandContext } from '../command-registry.ts';
import { defineCommand } from '@goodvibes/engine/terminal-shell/command-actions';
import { readAction } from '@goodvibes/engine/terminal-shell/described-command-kit';

function statusText(storePath: string, decision: ReturnType<typeof loadLanScanConsent>): string {
  if (!decision || decision.decision === 'declined') {
    return [
      'Local network scanning: off',
      '  At each start      Model servers on this computer (such as Ollama or LM Studio) are found and registered; providers whose API key is in the environment are registered.',
      '  What it would do   Check other devices on your local network (your subnet only, nothing beyond it) for model servers.',
      `  What it stores     Found servers would be saved to ${storePath}.`,
      `  Turn it on         ${NETWORK_SCAN_ENABLE_COMMAND}`,
    ].join('\n');
  }
  return [
    'Local network scanning: on',
    `  Turned on           ${decision.decidedAt}`,
    '  What it does        Checks other devices on your local network (your subnet only, nothing beyond it) for model servers such as Ollama or LM Studio, each time the agent starts.',
    `  What it stores      Found servers are saved to ${storePath}.`,
    '  See discovered      /provider',
    `  Turn it off         ${NETWORK_SCAN_DISABLE_COMMAND}`,
  ].join('\n');
}

function storeOf(ctx: CommandContext): { readonly shellPaths: ReturnType<typeof requireShellPaths>; readonly storePath: string } {
  const shellPaths = requireShellPaths(ctx);
  return { shellPaths, storePath: discoveredProvidersFilePath(shellPaths, GOODVIBES_AGENT_SURFACE_ROOT) };
}

/**
 * /network-scan, the consent + status surface for the subnet part of provider
 * discovery (see src/runtime/lan-scan-consent.ts). Declining or never deciding
 * is a first-class path: this computer is still scanned at each start, the
 * network never is until this command turns it on, and turning it on scans at
 * once. Turning it on is the owner's consent to probe other devices on his
 * network, so it counts only when he types it; a model may read the status and
 * turn scanning off.
 */
export function registerNetworkScanRuntimeCommands(registry: CommandRegistry): void {
  registry.register(defineCommand<CommandContext>({
    name: 'network-scan',
    title: 'Network scan for model servers',
    summary: 'Whether the Agent checks other devices on your local network for model servers, and turning that on or off',
    group: 'Models',
    report: 'status',
    actions: [
      readAction<CommandContext>({
        id: 'status', label: 'See whether your network is scanned', word: 'status',
        sentence: 'Shows whether other devices on your local network are checked for model servers, and where found servers are kept.',
        operator: { terminalOnly: 'the consent is kept by this Agent' },
        async run(_values, ctx) {
          const { shellPaths, storePath } = storeOf(ctx);
          return statusText(storePath, loadLanScanConsent(shellPaths, GOODVIBES_AGENT_SURFACE_ROOT));
        },
      }),
      {
        id: 'on', label: 'Scan your network for model servers', word: 'on', inputs: [],
        sentence: 'Other devices on your local network (your subnet only) are checked for model servers now and at each start, until you change it.', done: '',
        touches: 'another-machine', lasts: 'kept', risk: 'none', undoneBy: 'off',
        ownerOnly: { reason: 'it gives consent to scan other devices on the local network', instead: '/network-scan status shows whether it is on' },
        operator: { terminalOnly: 'the consent is kept by this Agent' },
        example: {},
        async run(_values, ctx) {
          const { shellPaths, storePath } = storeOf(ctx);
          saveLanScanConsent(shellPaths, GOODVIBES_AGENT_SURFACE_ROOT, 'granted');
          const scanning = startLanScanNow();
          return `Local network scanning is now on. ${scanning ? 'Scanning now, and at each start,' : 'From the next start,'} the agent checks other devices on your ` +
            `local network (your subnet only) for model servers such as Ollama or LM Studio, and saves what it finds to ${storePath}. ` +
            `Run /provider to see discovered servers. Turn it off anytime with ${NETWORK_SCAN_DISABLE_COMMAND}.`;
        },
      },
      {
        id: 'off', label: 'Stop scanning your network', word: 'off', inputs: [],
        sentence: 'Nothing on your local network is checked for model servers, until you change it; this computer still is.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'on',
        operator: { terminalOnly: 'the consent is kept by this Agent' },
        example: {},
        async run(_values, ctx) {
          const { shellPaths } = storeOf(ctx);
          saveLanScanConsent(shellPaths, GOODVIBES_AGENT_SURFACE_ROOT, 'declined');
          return `Local network scanning is now off. Nothing on your network will be probed. Turn it back on anytime with ${NETWORK_SCAN_ENABLE_COMMAND}.`;
        },
      },
    ],
  }));
}
