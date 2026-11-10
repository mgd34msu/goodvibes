/** Published v3.1.1 Discord account codecs. File discovery runs only after
 * actual old mirrors or receipts exist; genuine clustered owners also use the deployed
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
export function findSavedDiscordScope(binding: DiscordInboxBinding, configuredRegistry: boolean, mirrors: ReadonlySet<string>, triageFiles: ReadonlySet<string>): { readonly candidate: string; readonly found: boolean; readonly triageFileName?: string } | undefined {
  if (!mirrors.size && !triageFiles.size) return undefined;
  const candidate = publishedDiscordElectionScope(binding, configuredRegistry);
  // A saved receipt remains the same account's history when its optional
  // mirror has been removed. Match the original filename; never manufacture
  // receipt contents or treat an unrelated store as the selected account.
  const triageFileName = findSavedDiscordTriage(candidate, triageFiles);
  return { candidate, found: mirrors.has(candidate) || triageFileName !== undefined,
    ...(triageFileName === undefined ? {} : { triageFileName }) };
}
export function findSavedDiscordTriage(scopeId: string, files: ReadonlySet<string>): string | undefined {
  if (!files.size) return undefined;
  // Existing triage was keyed by this exact historical provider/account tuple.
  const name = `inbox-triage-${historicalDigest(['owned-inbox-triage-v1', 'discord', scopeId])}.sqlite`;
  return files.has(name) ? name : undefined;
}
