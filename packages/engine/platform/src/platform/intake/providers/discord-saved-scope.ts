/** Published v3.1.1 Discord account codecs. File discovery runs only after
 * actual old mirrors exist; genuine clustered owners also use the deployed
 * wire codec once. Fresh local selectors remain opaque UUIDs. */
import { createHash } from 'node:crypto';
import type { DiscordInboxBinding } from './discord-identity.js';
const historicalDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Exact deployed account/channel/screening wire codec for v3.1.1 peers. */
export function publishedDiscordElectionScope(binding: DiscordInboxBinding, configuredRegistry: boolean): string {
  // Old native settings encoded this exact account/DM membership as a revision.
  const revision = configuredRegistry ? historicalDigest([binding.userId, binding.channelIds]) : binding.registryRevision;
  return historicalDigest(binding.screening.kind === 'hosted'
    ? ['discord-inbox-hosted', 1, binding.userId, binding.channelIds, revision,
      'abacus-route-llm+typesafe-jev-latest', 'provider-managed-zero-retention-unverified']
    : ['discord-inbox', 1, binding.userId, binding.channelIds, revision, binding.screening.ownerId, binding.screening.revision]);
}
export function findSavedDiscordScope(binding: DiscordInboxBinding, configuredRegistry: boolean, mirrors: ReadonlySet<string>): { readonly candidate: string; readonly found: boolean } | undefined {
  if (!mirrors.size) return undefined;
  const candidate = publishedDiscordElectionScope(binding, configuredRegistry);
  return { candidate, found: mirrors.has(candidate) };
}
export function findSavedDiscordTriage(scopeId: string, files: ReadonlySet<string>): string | undefined {
  if (!files.size) return undefined;
  // Existing triage was keyed by this exact historical provider/account tuple.
  const name = `inbox-triage-${historicalDigest(['owned-inbox-triage-v1', 'discord', scopeId])}.sqlite`;
  return files.has(name) ? name : undefined;
}
