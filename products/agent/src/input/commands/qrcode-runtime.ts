import type { CommandRegistry } from '../command-registry.ts';
import {
  buildCompanionConnectionInfo,
  type CompanionConnectionInfo,
  encodeConnectionPayload,
  formatHttpOrigin,
  generateQrMatrix,
  isWildcardBindHost,
  refreshStableHostInputs,
  renderQrToString,
  stableUrlHostForBindHost,
} from '@goodvibes-jev/engine/platform/platform/pairing';
import { GOODVIBES_AGENT_PAIRING_SURFACE } from '../../config/surface.ts';
import { resolveRuntimeEndpointBinding } from '../../cli/endpoints.ts';
import { connectedHostTokenRequiredMessage, readConnectedHostOperatorToken } from '../../runtime/connected-host-auth.ts';
import { requirePlatform, requireShellPaths } from './runtime-services.ts';



function formatTokenLine(token: string, showToken: boolean): string {
  if (showToken) return `Token:          ${token}`;
  return 'Token:          present (hidden in text; QR contains pairing payload)';
}

function formatAgentPairingBlock(info: CompanionConnectionInfo, qr: string, showToken: boolean, alternateUrl: string | undefined): string {
  return [
    `GoodVibes Agent companion pairing v${info.version}`,
    '━━━━━━━━━━━━━━━━━━━━━━━━',
    `Connected host: ${info.url}`,
    `Surface:        ${info.surface}`,
    `User:           ${info.username}`,
    formatTokenLine(info.token, showToken),
    '',
    'Scan to connect:',
    '',
    qr,
    '',
    ...(alternateUrl ? [`If the device cannot open ${info.url}, use ${alternateUrl} instead.`, ''] : []),
    showToken
      ? 'Manual token display was explicitly confirmed for this command.'
      : 'For manual setup, rerun /pair --show-token --yes to print the token once.',
    'Agent is waiting for the companion app to connect to the owning GoodVibes host.',
  ].join('\n');
}

function shouldShowToken(args: readonly string[]): boolean {
  return args.includes('--show-token') || args.includes('--manual-token');
}

export function registerQrcodeRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'qrcode',
    aliases: ['qr', 'pair'],
    description: 'Print companion pairing details and a QR code',
    hidden: true,
    usage: '',
    async handler(args, ctx) {
      // The QR payload and the --show-token text both carry the host's admin token.
      if (ctx.invokedByModel === true) {
        ctx.print('Pairing details contain the connected host operator token, so /qrcode is refused when a model runs it. The owner can type /qrcode in the live Agent terminal.');
        return;
      }
      const shellPaths = requireShellPaths(ctx);
      const configManager = requirePlatform(ctx).configManager;
      const tokenRecord = readConnectedHostOperatorToken(shellPaths.homeDirectory);
      if (!tokenRecord.token) {
        ctx.print(connectedHostTokenRequiredMessage(tokenRecord.path));
        return;
      }
      const binding = resolveRuntimeEndpointBinding(configManager, 'controlPlane');
      // The full host ladder (Tailscale name, a `.local` name that resolves here) needs
      // the asynchronous probes; a wildcard bind waits for them once, then they are cached.
      const hostInputs = isWildcardBindHost(binding.host) ? await refreshStableHostInputs() : undefined;
      const resolvedHost = stableUrlHostForBindHost(binding.host, hostInputs ? () => hostInputs : undefined);
      const connectedHostUrl = formatHttpOrigin(resolvedHost.host, binding.port);
      const alternateUrl = resolvedHost.alternateHost ? formatHttpOrigin(resolvedHost.alternateHost, binding.port) : undefined;
      const info = buildCompanionConnectionInfo({
        daemonUrl: connectedHostUrl,
        token: tokenRecord.token,
        username: 'admin',
        surface: GOODVIBES_AGENT_PAIRING_SURFACE,
      });
      const payload = encodeConnectionPayload(info);
      const qr = renderQrToString(generateQrMatrix(payload));
      const showToken = shouldShowToken(args);
      if (showToken && !args.includes('--yes')) {
        ctx.print([
          'Manual companion token display requires confirmation.',
          '  rerun: /pair --show-token --yes',
          '  QR pairing remains available without printing the raw token.',
        ].join('\n'));
        return;
      }
      ctx.print(formatAgentPairingBlock(info, qr, showToken, alternateUrl));
    },
  });
}
