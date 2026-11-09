/** Compatibility only: invoked after concrete old hashed Discord mirrors exist.
 * These exact historical filenames are necessary to keep existing mirrors and
 * their triage receipts reachable. Never issue a digest for a new scope. */
import { createHash } from 'node:crypto';
import type { DiscordInboxBinding } from './discord-identity.js';
const historicalDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function findSavedDiscordScope(binding: DiscordInboxBinding, configuredRegistry: boolean, mirrors: ReadonlySet<string>): string | undefined {
  if (!mirrors.size) return undefined;
  // Old native settings encoded this exact account/DM membership as a revision.
  const revision = configuredRegistry ? historicalDigest([binding.userId, binding.channelIds]) : binding.registryRevision;
  const candidate = historicalDigest(binding.screening.kind === 'hosted'
    ? ['discord-inbox-hosted', 1, binding.userId, binding.channelIds, revision,
      'abacus-route-llm+typesafe-jev-latest', 'provider-managed-zero-retention-unverified']
    : ['discord-inbox', 1, binding.userId, binding.channelIds, revision, binding.screening.ownerId, binding.screening.revision]);
  return mirrors.has(candidate) ? candidate : undefined;
}
export function findSavedDiscordTriage(scopeId: string, files: ReadonlySet<string>): string | undefined {
  if (!files.size) return undefined;
  // Existing triage was keyed by this exact historical provider/account tuple.
  const name = `inbox-triage-${historicalDigest(['owned-inbox-triage-v1', 'discord', scopeId])}.sqlite`;
  return files.has(name) ? name : undefined;
}
