/** Only actual saved hash-shaped selectors activate these historical matchers.
 * Fresh account names, owner facts and selectors never acquire a digest. */
import { createHash } from 'node:crypto';
import type { AccountInboxBinding, AccountInboxIdentityInput } from './account-identity.js';
const historicalDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
interface SavedSelectors { readonly scopeId: string; readonly mirrorFileName: string; readonly triageFileName?: string }
function savedTriage(providerId: string, scopeId: string, files: ReadonlySet<string>): string | undefined {
  if (![...files].some(name => /^inbox-triage-[0-9a-f]{64}\.sqlite$/.test(name))) return undefined;
  const name = `inbox-triage-${historicalDigest(['owned-inbox-triage-v1', providerId, scopeId])}.sqlite`;
  return files.has(name) ? name : undefined;
}
export function findSavedAccountInboxIdentity(binding: AccountInboxIdentityInput, files: ReadonlySet<string>): SavedSelectors | undefined {
  if (![...files].some(name => name.startsWith(`inbox-${binding.provider}-`) || name.startsWith('inbox-triage-'))) return undefined;
  // Historical Email captureAccount constructed this exact key order.
  const scopeId = binding.provider === 'slack'
    ? historicalDigest(['slack-inbox', 1, binding.account.workspaceId, binding.account.userId])
    : historicalDigest(['email-inbox', 1, { host: binding.account.host, username: binding.account.username,
      mailbox: binding.account.mailbox, port: binding.account.port, security: binding.account.security }]);
  const mirrorFileName = `inbox-${binding.provider}-${scopeId}.sqlite`;
  const triageFileName = savedTriage(binding.provider, scopeId, files);
  return files.has(mirrorFileName) || triageFileName ? { scopeId, mirrorFileName, ...(triageFileName ? { triageFileName } : {}) } : undefined;
}
export function findSavedOwnedTriageIdentity(binding: Extract<AccountInboxBinding, { provider: 'owned-triage' }>, files: ReadonlySet<string>): SavedSelectors | undefined {
  if (![...files].some(name => name.startsWith('inbox-owned-') || name.startsWith('inbox-triage-'))) return undefined;
  const scopeId = historicalDigest(['owned-inbox-triage-v1', binding.providerId, binding.accountScopeId]);
  const mirrorFileName = `inbox-owned-${scopeId}.sqlite`, triageFileName = `inbox-triage-${scopeId}.sqlite`;
  return files.has(mirrorFileName) || files.has(triageFileName)
    ? { scopeId, mirrorFileName, ...(files.has(triageFileName) ? { triageFileName } : {}) } : undefined;
}
