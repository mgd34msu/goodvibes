/** Exact account facts stay in a private native registry, never in local selectors.
 * Distributed elections separately retain the published cross-machine codec. */
import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod/v4';
import { captureRegistryOwner, synchronous, updateInboxIdentityRegistry, type InboxIdentityRegistryFormat, type InboxIdentityRegistryOwner as AccountInboxIdentityOwner } from './identity-registry.js';
import { findSavedAccountInboxIdentity, findSavedOwnedTriageIdentity, publishedAccountElectionScope } from './saved-account-scope.js';

const metadata = z.string().min(1).max(500);
const bindingSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('slack'), account: z.object({ workspaceId: metadata, userId: metadata }).strict() }).strict(),
  z.object({ provider: z.literal('email'), account: z.object({ host: metadata, username: metadata, mailbox: metadata,
    port: z.number().int().min(1).max(65535), security: z.literal('tls') }).strict() }).strict(),
  z.object({ provider: z.literal('owned-triage'), providerId: metadata, accountScopeId: metadata }).strict(),
]);
export type AccountInboxBinding = z.infer<typeof bindingSchema>;
export type AccountInboxIdentityInput = Exclude<AccountInboxBinding, { provider: 'owned-triage' }>;
export type { InboxIdentityRegistryOwner as AccountInboxIdentityOwner } from './identity-registry.js';
export interface AccountInboxSelectors {
  readonly scopeId: string;
  readonly mirrorFileName: string;
  readonly triageFileName: string;
}
const opaque = z.string().regex(/^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{64})$/);
const mirrorFile = z.string().regex(/^inbox-(?:slack|email|owned)-(?:[0-9a-f-]{36}|[0-9a-f]{64})\.sqlite$/);
const triageFile = z.string().regex(/^inbox-triage-(?:[0-9a-f]{64}|(?:slack|email|owned)-[0-9a-f-]{36})\.sqlite$/);
const entrySchema = z.object({ binding: bindingSchema, id: opaque, mirrorFileName: mirrorFile, triageFileName: triageFile }).strict();
const registrySchema = z.object({ schema: z.literal(1), scopes: z.array(entrySchema).max(2048) }).strict();
type Registry = z.infer<typeof registrySchema>;
type Entry = z.infer<typeof entrySchema>;
const unavailable = () => new Error('Account inbox native identity registry is unavailable');
const format: InboxIdentityRegistryFormat<Registry> = {
  fileName: 'account-inbox-identities.json', empty: () => ({ schema: 1, scopes: [] }),
  parse(value) {
    const registry = registrySchema.parse(value);
    if (new Set(registry.scopes.map(entry => entry.id)).size !== registry.scopes.length
      || new Set(registry.scopes.map(entry => JSON.stringify(entry.binding))).size !== registry.scopes.length
      || new Set(registry.scopes.map(entry => entry.mirrorFileName)).size !== registry.scopes.length) throw unavailable();
    const triageAccounts = new Map<string, string>();
    for (const entry of registry.scopes) {
      const provider = entry.binding.provider === 'owned-triage' ? 'owned' : entry.binding.provider;
      if (entry.mirrorFileName !== `inbox-${provider}-${entry.id}.sqlite`) throw unavailable();
      const account = JSON.stringify(entry.binding.provider === 'owned-triage'
        ? [entry.binding.providerId, entry.binding.accountScopeId] : [entry.binding.provider, entry.id]);
      const previous = triageAccounts.get(entry.triageFileName);
      if (previous !== undefined && previous !== account) throw unavailable();
      triageAccounts.set(entry.triageFileName, account);
    }
    return registry;
  },
  assertStored(registry, directory) {
    const known = new Set(registry.scopes.flatMap(entry => [entry.mirrorFileName, entry.triageFileName]));
    const stored = new Set(readdirSync(directory));
    for (const name of stored) {
      const base = name.replace(/-(?:wal|shm)$/, '');
      if (name !== base && /^inbox-(?:(?:slack|email|owned)-(?:[0-9a-f-]{36}|[0-9a-f]{64})|triage-(?:(?:slack|email|owned)-[0-9a-f-]{36}|[0-9a-f]{64}))\.sqlite$/.test(base)
        && !stored.has(base)) throw unavailable();
      if (/^inbox-(?:(?:slack|email|owned)|triage-(?:slack|email|owned))-[0-9a-f-]{36}\.sqlite$/.test(base) && !known.has(base)) throw unavailable();
    }
  },
};
declare const identityBrand: unique symbol;
export interface AccountInboxIdentity { readonly [identityBrand]: true }
interface RetainedIdentity { readonly binding: AccountInboxBinding; readonly selectors: AccountInboxSelectors; readonly current: () => void; electionScope: string | undefined }
const identities = new WeakMap<AccountInboxIdentity, RetainedIdentity>();
function captureBinding(input: AccountInboxBinding): AccountInboxBinding {
  const binding = bindingSchema.parse(input);
  if ('account' in binding) Object.freeze(binding.account);
  return Object.freeze(binding);
}
function savedFiles(directory: string): ReadonlySet<string> {
  const files = new Set<string>();
  for (const name of readdirSync(directory)) {
    if (!/^inbox-(?:(?:slack|email|owned)-[0-9a-f]{64}|triage-[0-9a-f]{64})\.sqlite$/.test(name)) continue;
    const stat = lstatSync(join(directory, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw unavailable();
    files.add(name);
  }
  return files;
}
async function acquireIdentity(owner: AccountInboxIdentityOwner, input: AccountInboxBinding): Promise<AccountInboxIdentity> {
  owner = captureRegistryOwner(owner);
  const binding = captureBinding(input);
  let discoveredElectionScope: string | undefined;
  const result = await updateInboxIdentityRegistry(owner, format, (registry, directory, current) => {
    const found = registry.scopes.find(entry => isDeepStrictEqual(entry.binding, binding));
    if (found) return { value: found, changed: false };
    if (registry.scopes.length >= 2048) throw unavailable();
    const files = savedFiles(directory); current();
    const native = binding.provider === 'owned-triage'
      ? registry.scopes.find(entry => entry.binding.provider === binding.providerId && entry.id === binding.accountScopeId) : undefined;
    if (native && ![...files].some(name => /^inbox-owned-[0-9a-f]{64}\.sqlite$/.test(name))) return { value: native, changed: false };
    const historical = binding.provider === 'owned-triage' ? undefined : findSavedAccountInboxIdentity(binding, files);
    const saved = binding.provider === 'owned-triage' ? findSavedOwnedTriageIdentity(binding, files) : historical?.saved;
    // A native account already owns its selector pair. A default triage caller
    // must not create another namespace merely because it omitted the pair.
    // Preserve a real older generic mirror when one actually exists, however.
    if (binding.provider === 'owned-triage' && (!saved || !files.has(saved.mirrorFileName))) {
      if (native) return { value: native, changed: false };
    }
    if (binding.provider !== 'owned-triage') discoveredElectionScope = historical?.scopeId;
    const id = saved?.scopeId ?? randomUUID();
    const provider = binding.provider === 'owned-triage' ? 'owned' : binding.provider;
    const entry: Entry = { binding, id, mirrorFileName: saved?.mirrorFileName ?? `inbox-${provider}-${id}.sqlite`,
      triageFileName: saved?.triageFileName ?? `inbox-triage-${provider}-${randomUUID()}.sqlite` };
    registry.scopes.push(entry); return { value: entry, changed: true };
  });
  synchronous(owner.assertCurrent);
  const identity = Object.freeze({}) as AccountInboxIdentity;
  identities.set(identity, { binding, selectors: Object.freeze({ scopeId: result.value.id,
    mirrorFileName: result.value.mirrorFileName, triageFileName: result.value.triageFileName }), current: result.assertDirectoryCurrent, electionScope: discoveredElectionScope });
  return identity;
}
export function acquireAccountInboxIdentity(owner: AccountInboxIdentityOwner, input: AccountInboxIdentityInput): Promise<AccountInboxIdentity> {
  return acquireIdentity(owner, input);
}
export function resolveAccountInboxIdentity(identity: AccountInboxIdentity, input: AccountInboxIdentityInput): AccountInboxSelectors {
  const found = identities.get(identity);
  if (!found || !isDeepStrictEqual(found.binding, captureBinding(input))) throw unavailable();
  found.current(); return found.selectors;
}
/** One published v3.1.1 wire commitment per genuine clustered account selection.
 * Local mirror UUIDs cannot coordinate independent machines. This exact codec
 * remains necessary for the existing inboxSurface wire consumer, not authority,
 * local equality or privacy against dictionary guesses. No prompt is retained.
 */
export function resolveAccountInboxElectionScope(identity: AccountInboxIdentity): string {
  const found = identities.get(identity);
  if (!found || found.binding.provider === 'owned-triage') throw unavailable();
  found.current();
  return found.electionScope ??= publishedAccountElectionScope(found.binding);
}
export async function acquireOwnedTriageIdentity(owner: AccountInboxIdentityOwner, providerId: string, accountScopeId: string): Promise<AccountInboxSelectors> {
  const binding = captureBinding({ provider: 'owned-triage', providerId, accountScopeId });
  const identity = await acquireIdentity(owner, binding);
  const found = identities.get(identity)!; found.current(); return found.selectors;
}
