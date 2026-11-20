/**
 * The paired-phone actions of `/devices` (devices-command.ts), shared by both terminal apps: the phones
 * paired as device nodes and what each can serve, the durable "always allow"
 * grants with revoke, and the captures the daemon is keeping with delete. Every
 * line goes to the daemon over the `devices.*` verbs (DevicesClient); nothing
 * here decides a grant or a retention window.
 */
import type { DevicesClient } from '@goodvibes-jev/engine/platform/platform/runtime/client';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import { RefusalError, readRefusal, refusal } from '@goodvibes-jev/engine/errors';
import { commandRefusal } from './command-confirmation.js';

const DEVICE_CAPABILITY_SUBCOMMANDS = ['nodes', 'grants', 'revoke-grant', 'captures', 'delete-capture'] as const;

function isDeviceCapabilitySubcommand(sub: string): sub is (typeof DEVICE_CAPABILITY_SUBCOMMANDS)[number] {
  return (DEVICE_CAPABILITY_SUBCOMMANDS as readonly string[]).includes(sub);
}

const when = (at: unknown): string => typeof at === 'number' && Number.isFinite(at) ? new Date(at).toISOString().replace('T', ' ').slice(0, 16) : 'n/a';
const size = (bytes: unknown): string => typeof bytes === 'number' ? (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`) : '?';

/**
 * Run one paired-phone subcommand. Returns false when `args[0]` is not one of
 * them, so a product's `/devices` can fall through to its own subcommands.
 * A delete runs only after its confirmation was answered. A line that
 * did not happen (no daemon, a missing id, a daemon refusal or failure) throws
 * its refusal, so a modal or the model's command runner sees it failed.
 */
export async function runDeviceCapabilitySubcommand(
  args: readonly string[],
  devices: DevicesClient | undefined,
  print: (message: string) => void,
): Promise<boolean> {
  const sub = (args[0] ?? '').toLowerCase();
  if (!isDeviceCapabilitySubcommand(sub)) return false;
  if (!devices) {
    throw commandRefusal('Paired phones are served by the daemon, and this runtime has no daemon connection.', 'Start the daemon and try again', 'DAEMON_UNAVAILABLE');
  }
  const unavailable = devices.describeAvailability();
  if (unavailable) {
    throw commandRefusal(`No daemon to ask: ${unavailable}`, 'Start the daemon and try again', 'DAEMON_UNAVAILABLE');
  }
  try {
    if (sub === 'nodes') {
      const nodes = await devices.listNodes();
      print(nodes.length === 0
        ? '[devices] No phone is paired as a device node. Pair one with /devices pair device, then open the GoodVibes page on it.'
        : ['[devices] Paired phones:', ...nodes.map((node) =>
          `  ${node.label || node.nodeId}  ${node.platform ?? ''}  id ${node.nodeId}\n    can serve: ${(node.supported ?? []).join(', ') || 'nothing yet'}`)].join('\n'));
      return true;
    }
    if (sub === 'grants') {
      const grants = await devices.listGrants();
      print(grants.length === 0
        ? '[devices] No "always allow" grants: every phone capability asks you first.'
        : ['[devices] Always-allow grants:', ...grants.map((grant) =>
          `  ${grant.grantId}  ${grant.capabilityTitle ?? grant.capabilityId ?? '?'} on ${grant.nodeId ?? '?'}  ${grant.scope ?? ''}  used ${grant.useCount ?? 0}x  expires ${when(grant.expiresAt)}`),
        '', 'Revoke one with /devices revoke-grant <grant>.'].join('\n'));
      return true;
    }
    if (sub === 'revoke-grant') {
      const grantId = args[1];
      if (!grantId) throw commandRefusal('Usage: /devices revoke-grant <grant-id>', '/devices grants lists the grant ids');
      await devices.revokeGrant(grantId);
      print(`[devices] Revoked grant ${grantId}; the next request for that capability asks you again.`);
      return true;
    }
    if (sub === 'captures') {
      const listed = await devices.listArtifacts();
      print(listed.artifacts.length === 0
        ? `[devices] The daemon is keeping no captures (they are kept ${listed.retentionHours} hour(s)).`
        : [`[devices] Captures kept on the daemon host (${listed.retained}, each kept ${listed.retentionHours} hour(s)):`,
          ...listed.artifacts.map((artifact) =>
            `  ${artifact.artifactId}  ${String(artifact.capabilityId ?? '?')} from ${String(artifact.nodeId ?? '?')}  ${size(artifact.byteLength)}  taken ${when(artifact['capturedAt'])}  deleted ${when(artifact['expiresAt'])}${typeof artifact['reason'] === 'string' && artifact['reason'] ? `\n    reason: ${artifact['reason']}` : ''}`),
          '', 'Delete one now with /devices delete-capture <capture>.'].join('\n'));
      return true;
    }
    const artifactId = args[1];
    if (!artifactId) throw commandRefusal('Usage: /devices delete-capture <capture-id>', '/devices captures lists the capture ids');
    const deleted = await devices.deleteArtifact(artifactId);
    // A file already gone leaves nothing behind once its record is removed; any other answer kept something.
    if (!deleted.deleted && deleted.reason !== 'file-missing') {
      throw commandRefusal(deleted.detail || `Capture ${artifactId} was not deleted.`, '/devices captures lists the captures the daemon keeps', 'NOT_DONE');
    }
    print(deleted.deleted ? `[devices] Deleted capture ${deleted.artifactId} (${size(deleted.byteLength)}).` : `[devices] ${deleted.detail}`);
    return true;
  } catch (error) {
    if (error instanceof RefusalError) throw error;
    throw new RefusalError(readRefusal(error) ?? refusal({ code: 'DEVICES_FAILED', state: 'not done', reason: `/devices ${sub} failed: ${summarizeError(error)}` }), { cause: error });
  }
}
