/**
 * The paired-phone part of `/devices`, shared by both terminal apps: the phones
 * paired as device nodes and what each can serve, the durable "always allow"
 * grants with revoke, and the captures the daemon is keeping with delete. Every
 * line goes to the daemon over the `devices.*` verbs (DevicesClient); nothing
 * here decides a grant or a retention window.
 */
import type { DevicesClient } from '@goodvibes-jev/engine/platform/platform/runtime/client';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import type { CommandConfirmation } from './command-confirmation.js';

/** The subcommands this module answers, with their argument hints. */
export const DEVICE_CAPABILITY_SUBCOMMANDS = {
  nodes: '',
  grants: '',
  'revoke-grant': '<grant-id>',
  captures: '',
  'delete-capture': '<capture-id>',
} as const;

export const DEVICE_CAPABILITY_USAGE = 'nodes | grants | revoke-grant <grant-id> | captures | delete-capture <capture-id>';

export function isDeviceCapabilitySubcommand(sub: string): sub is keyof typeof DEVICE_CAPABILITY_SUBCOMMANDS {
  return Object.hasOwn(DEVICE_CAPABILITY_SUBCOMMANDS, sub);
}

/** The question a revoke or a delete asks once; undefined for a read or an incomplete line. */
export function deviceCapabilityConfirmation(args: readonly string[]): CommandConfirmation | undefined {
  const sub = (args[0] ?? '').toLowerCase();
  const id = args[1];
  if (!id) return undefined;
  if (sub === 'revoke-grant') {
    return {
      title: `Revoke device grant ${id}?`,
      detail: 'The "always allow" answer is removed; the next request for that capability asks you again.',
      confirmLabel: 'Revoke',
    };
  }
  if (sub === 'delete-capture') {
    return {
      title: `Delete capture ${id}?`,
      detail: 'The photo or screen capture and its record are removed from the daemon host now and cannot be recovered.',
      confirmLabel: 'Delete',
    };
  }
  return undefined;
}

const when = (at: unknown): string => typeof at === 'number' && Number.isFinite(at) ? new Date(at).toISOString().replace('T', ' ').slice(0, 16) : 'n/a';
const size = (bytes: unknown): string => typeof bytes === 'number' ? (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`) : '?';

/**
 * Run one paired-phone subcommand. Returns false when `args[0]` is not one of
 * them, so a product's `/devices` can fall through to its own subcommands.
 * A revoke or delete runs only after its confirmation was answered.
 */
export async function runDeviceCapabilitySubcommand(
  args: readonly string[],
  devices: DevicesClient | undefined,
  print: (message: string) => void,
): Promise<boolean> {
  const sub = (args[0] ?? '').toLowerCase();
  if (!isDeviceCapabilitySubcommand(sub)) return false;
  if (!devices) {
    print('[devices] Paired phones are served by the daemon, and this runtime has no daemon connection. Start the daemon and try again.');
    return true;
  }
  const unavailable = devices.describeAvailability();
  if (unavailable) {
    print(`[devices] No daemon to ask: ${unavailable}`);
    return true;
  }
  try {
    if (sub === 'nodes') {
      const nodes = await devices.listNodes();
      print(nodes.length === 0
        ? '[devices] No phone is paired as a device node. Pair one with /pair, then open the GoodVibes page on it.'
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
        '', 'Revoke one with /devices revoke-grant <grant-id>.'].join('\n'));
      return true;
    }
    if (sub === 'revoke-grant') {
      const grantId = args[1];
      if (!grantId) { print('[devices] Usage: /devices revoke-grant <grant-id> (ids are in /devices grants)'); return true; }
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
          '', 'Delete one now with /devices delete-capture <capture-id>.'].join('\n'));
      return true;
    }
    const artifactId = args[1];
    if (!artifactId) { print('[devices] Usage: /devices delete-capture <capture-id> (ids are in /devices captures)'); return true; }
    const deleted = await devices.deleteArtifact(artifactId);
    print(deleted.deleted ? `[devices] Deleted capture ${deleted.artifactId} (${size(deleted.byteLength)}).` : `[devices] ${deleted.detail}`);
    return true;
  } catch (error) {
    print(`[devices] ${sub} failed: ${summarizeError(error)}`);
    return true;
  }
}
