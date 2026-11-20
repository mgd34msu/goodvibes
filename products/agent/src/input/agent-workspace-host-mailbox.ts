/**
 * The connected host's inbox state for the workspace.
 *
 * The mailbox keys (`surfaces.email.*`) are daemon-owned: `/mail set` and the
 * connect form write them to the connected host only, and `/mail status` reads
 * them from there. The workspace snapshot is built synchronously, so it cannot
 * ask the host itself; the workspace takes one reading when it opens (and after
 * the connect form saves) and the snapshot shows that reading, the same fact
 * `/mail status` reports. Until the first reading lands the snapshot says it
 * is reading from the host instead of reporting this process's local copy.
 *
 * Cost: one effective-config read from the host per workspace open, and one
 * after a connect-form save, only when a connected-host config client is
 * installed; nothing per repaint, and nothing without a host.
 */
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { agentDaemonConfigClient, openEffectiveConfigView } from '../config/daemon-config-routing.ts';
import type { CommandContext } from './command-registry.ts';
import { readMailboxStatus, type MailboxStatus } from './commands/email-settings.ts';

export type HostMailboxReading =
  | { readonly state: 'reading' }
  | { readonly state: 'read'; readonly status: MailboxStatus }
  | { readonly state: 'failed'; readonly reason: string };

let held: Exclude<HostMailboxReading, { state: 'reading' }> | null = null;
let pending: Promise<void> | null = null;

/**
 * The host's inbox state as last read, `reading` before the first answer, or
 * null when no connected host holds the inbox settings (this process's own
 * settings are then the answer).
 */
export function heldHostMailboxReading(): HostMailboxReading | null {
  if (!agentDaemonConfigClient()) return null;
  return held ?? { state: 'reading' };
}

/**
 * Read the inbox settings from the connected host. Null when no host client is
 * installed. Never rejects: a failed read is held as a reading that says why.
 * `fresh` is for a caller that just wrote the settings: a read already in
 * flight may have started before the write, so a new one follows it.
 */
export function readHostMailboxStatus(context: CommandContext | null, options: { readonly fresh?: boolean } = {}): Promise<void> | null {
  if (!context || !agentDaemonConfigClient()) return null;
  if (pending) return options.fresh === true ? pending.then(() => readHostMailboxStatus(context) ?? undefined) : pending;
  const configManager = context.platform.configManager;
  const homeDir = configManager.getHomeDirectory();
  pending = openEffectiveConfigView(configManager, homeDir ? { homeDir } : {})
    .then((view) => { held = { state: 'read', status: readMailboxStatus((key) => view.get(key)) }; })
    .catch((error: unknown) => { held = { state: 'failed', reason: summarizeError(error) }; })
    .finally(() => { pending = null; });
  return pending;
}
