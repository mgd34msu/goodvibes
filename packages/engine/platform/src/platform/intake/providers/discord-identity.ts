/** Private native identity registry. Exact facts stay on owner-only local disk;
 * only opaque IDs cross into inbox rows, selectors and locks. Distributed
 * elections separately retain the exact published cross-machine wire codec. */
import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod/v4';
import type { ProtectedSourceOwnerOptions } from '../../security/source-screening/types.js';
import { updateInboxIdentityRegistry, captureRegistryOwner, synchronous, type InboxIdentityRegistryFormat } from './identity-registry.js';
import { findSavedDiscordScope, findSavedDiscordTriage, publishedDiscordElectionScope } from './discord-saved-scope.js';

const snowflake = z.string().regex(/^[1-9]\d{0,19}$/).refine(value => BigInt(value) < (1n << 64n));
const metadata = z.string().min(1).max(4096);
const bindingSchema = z.object({ userId: snowflake, channelIds: z.array(snowflake).min(1).max(200), registryRevision: z.string().min(1).max(200),
  screening: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('hosted'), policy: z.literal('abacus-route-llm+typesafe-jev-latest'), retention: z.literal('provider-managed-zero-retention-unverified') }).strict(),
    z.object({ kind: z.literal('local'), ownerId: metadata, revision: metadata }).strict(),
  ]),
}).strict();
export type DiscordInboxBinding = z.infer<typeof bindingSchema>;
const opaqueId = z.string().regex(/^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{64})$/);
const revisionSchema = z.object({ userId: snowflake, channelIds: z.array(snowflake).min(1).max(200), revision: opaqueId }).strict();
const entrySchema = z.object({ binding: bindingSchema, id: opaqueId,
  triageFileName: z.string().regex(/^inbox-triage-(?:discord-[0-9a-f-]{36}|[0-9a-f]{64})\.sqlite$/),
}).strict();
const registrySchema = z.object({ schema: z.literal(1), registries: z.array(revisionSchema).max(1024), scopes: z.array(entrySchema).max(1024) }).strict();
type Registry = z.infer<typeof registrySchema>;
interface IdentityData { readonly configuredRegistry: boolean; electionScope?: string; readonly binding: DiscordInboxBinding; readonly scopeId: string; readonly triageFileName: string; readonly assertDirectoryCurrent: () => void }
declare const discordIdentity: unique symbol;
export interface DiscordInboxIdentity { readonly [discordIdentity]: true }
const identities = new WeakMap<DiscordInboxIdentity, IdentityData>();
export interface DiscordInboxIdentityInput {
  readonly account: { readonly userId: string };
  readonly channels: { readonly channelIds: readonly string[]; readonly revision: string };
  readonly screening: ProtectedSourceOwnerOptions;
}
export function captureDiscordInboxBinding(input: DiscordInboxIdentityInput): DiscordInboxBinding {
  const { account, channels, screening } = input; const authority = screening.authority;
  const binding = bindingSchema.parse({ userId: account.userId, channelIds: [...channels.channelIds].sort(), registryRevision: channels.revision,
    screening: 'kind' in screening
      ? { kind: 'hosted', policy: 'abacus-route-llm+typesafe-jev-latest', retention: 'provider-managed-zero-retention-unverified' }
      : { kind: 'local', ownerId: authority.ownerId, revision: authority.revision } });
  if (new Set(binding.channelIds).size !== binding.channelIds.length) throw new Error('Discord inbox registry contains duplicate channels');
  Object.freeze(binding.channelIds); Object.freeze(binding.screening); return Object.freeze(binding);
}
/** A caller cannot substitute another account's stored selector into an owner. */
export function resolveDiscordInboxIdentity(identity: DiscordInboxIdentity, input: DiscordInboxIdentityInput): Readonly<{ scopeId: string; triageFileName: string }> {
  const found = identities.get(identity);
  if (!found || !isDeepStrictEqual(found.binding, captureDiscordInboxBinding(input))) throw new Error('Discord inbox identity does not bind the selected account and source scope');
  // The immutable entry was admitted under the original file/lock guards.
  // Later legitimate appends must not revoke a selector for an unchanged entry.
  found.assertDirectoryCurrent();
  return Object.freeze({ scopeId: found.scopeId, triageFileName: found.triageFileName });
}
export interface DiscordInboxIdentityOwner {
  readonly workingDirectory: string;
  readonly assertCurrent: () => void;
  /** Actual admitted installation owner; synchronous and completed before publication. */
  readonly beforeWrite?: (() => void) | undefined;
}
const unavailable = () => new Error('Discord inbox native identity registry is unavailable');
const discordIdentityRegistry: InboxIdentityRegistryFormat<Registry> = {
  fileName: 'discord-inbox-identities.json',
  empty: () => ({ schema: 1, registries: [], scopes: [] }),
  parse(value) {
    const registry = registrySchema.parse(value);
    if (new Set(registry.scopes.map(entry => entry.id)).size !== registry.scopes.length
      || new Set(registry.scopes.map(entry => JSON.stringify(entry.binding))).size !== registry.scopes.length
      || new Set(registry.registries.map(entry => entry.revision)).size !== registry.registries.length
      || new Set(registry.registries.map(entry => JSON.stringify([entry.userId, entry.channelIds]))).size !== registry.registries.length) throw unavailable();
    for (const ids of [...registry.scopes.map(entry => entry.binding.channelIds), ...registry.registries.map(entry => entry.channelIds)]) {
      if (new Set(ids).size !== ids.length || !isDeepStrictEqual(ids, [...ids].sort())) throw unavailable();
    }
    return registry;
  },
  assertStored(registry, directory) {
    // An opaque mirror cannot be reconstructed from its name. Missing/partial
    // registry recovery must hold, rather than silently opening an empty mirror.
    const knownMirrors = new Set(registry.scopes.map(entry => `inbox-discord-${entry.id}.sqlite`));
    const knownTriage = new Set(registry.scopes.map(entry => entry.triageFileName));
    for (const name of readdirSync(directory)) {
      const base = name.replace(/-(?:wal|shm)$/, '');
      if ((/^inbox-discord-[0-9a-f-]{36}\.sqlite$/.test(base) && !knownMirrors.has(base))
        || (/^inbox-triage-discord-[0-9a-f-]{36}\.sqlite$/.test(base) && !knownTriage.has(base))) throw unavailable();
    }
  },
};
function updateRegistry<T>(owner: DiscordInboxIdentityOwner, change: (registry: Registry, directory: string, assertCurrent: () => void) => { value: T; changed: boolean }) {
  return updateInboxIdentityRegistry(owner, discordIdentityRegistry, change);
}
/** Exact configured DM membership owns a stable revision, rather than a digest. */
export function acquireDiscordInboxRegistryRevision(owner: DiscordInboxIdentityOwner, account: { readonly userId: string }, ids: readonly string[]): Promise<string> {
  const selection = revisionSchema.omit({ revision: true }).parse({ userId: account.userId, channelIds: [...ids].sort() });
  if (new Set(selection.channelIds).size !== selection.channelIds.length) throw unavailable();
  return updateRegistry(owner, registry => {
    const found = registry.registries.find(entry => entry.userId === selection.userId && isDeepStrictEqual(entry.channelIds, selection.channelIds));
    if (found) return { value: found.revision, changed: false };
    if (registry.registries.length >= 1024) throw unavailable();
    const revision = randomUUID(); registry.registries.push({ ...selection, revision }); return { value: revision, changed: true };
  }).then(result => result.value);
}
export async function acquireDiscordInboxIdentity(owner: DiscordInboxIdentityOwner, input: DiscordInboxIdentityInput,
  options: { readonly configuredRegistry?: boolean } = {}): Promise<DiscordInboxIdentity> {
  owner = captureRegistryOwner(owner);
  const binding = captureDiscordInboxBinding(input), configuredRegistry = options.configuredRegistry === true;
  let discoveredElectionScope: string | undefined;
  const { value: data, assertDirectoryCurrent } = await updateRegistry(owner, (registry, directory, current) => {
    const found = registry.scopes.find(entry => isDeepStrictEqual(entry.binding, binding));
    if (found) return { value: found, changed: false };
    if (registry.scopes.length >= 1024) throw unavailable();
    const mirrors = new Set<string>(), triage = new Set<string>();
    for (const name of readdirSync(directory)) {
      const match = /^inbox-discord-([0-9a-f]{64})\.sqlite$/.exec(name);
      if (match || /^inbox-triage-[0-9a-f]{64}\.sqlite$/.test(name)) {
        const stat = lstatSync(join(directory, name)); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw unavailable();
        if (match) mirrors.add(match[1]!); else triage.add(name);
      }
    }
    current();
    const historical = findSavedDiscordScope(binding, configuredRegistry, mirrors);
    const saved = historical?.found ? historical.candidate : undefined;
    discoveredElectionScope = historical?.candidate;
    const id = saved ?? randomUUID();
    const triageFileName = saved ? findSavedDiscordTriage(saved, triage) ?? `inbox-triage-discord-${randomUUID()}.sqlite` : `inbox-triage-discord-${randomUUID()}.sqlite`;
    const entry = { binding, id, triageFileName }; registry.scopes.push(entry); return { value: entry, changed: true };
  });
  synchronous(owner.assertCurrent);
  const identity = Object.freeze({}) as DiscordInboxIdentity;
  identities.set(identity, { configuredRegistry, electionScope: discoveredElectionScope, binding, scopeId: data.id, triageFileName: data.triageFileName, assertDirectoryCurrent }); return identity;
}

/** Only the genuine selected account may recover its published wire identity.
 * Compute once per native selection; the local mirror/receipt UUID stays local.
 */
export function resolveDiscordInboxElectionScope(identity: DiscordInboxIdentity): string {
  const found = identities.get(identity); if (!found) throw unavailable();
  found.assertDirectoryCurrent();
  return found.electionScope ??= publishedDiscordElectionScope(found.binding, found.configuredRegistry);
}
