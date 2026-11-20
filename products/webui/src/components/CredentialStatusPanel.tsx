import { useMemo } from 'react';
import { readDeclaredProviderCredential } from '@goodvibes/engine/platform/platform/judgment-browser/catalogs';
/**
 * CredentialStatusPanel, the display-site adoption of the cross-surface
 * credential-status facade (src/lib/provider-status.ts: deriveCredentialAvailability
 * over `platform.operator.credentials.get`). The facade shipped in 1.0.1 with zero
 * consumers; this is the reference implementation the audit calls for, so the
 * pattern here is what the TUI/agent can later mirror.
 *
 * Renders three honest outcomes, never a fourth fabricated one:
 *   1. REFUSED, the admin-scoped `credentials.get` route 403s a non-admin
 *      token (control-plane.ts requireAdmin: `{error: 'Admin role required'}`,
 *      no machine `code`). Distinguished from (2) so "you can't see this" never
 *      reads as "the store is broken".
 *   2. DEGRADED, deriveCredentialAvailability's `available: false` states: a
 *      503 CREDENTIAL_STORE_UNAVAILABLE, a METHOD_NOT_FOUND from an older
 *      daemon, or any transport failure. The reason is the facade's own text,
 *      never invented here.
 *   3. AVAILABLE, the credential list, each entry rendered as
 *      configured+usable ("usable"), configured-but-not-usable ("configured,
 *      not usable", the honest degraded ref, distinct from a fault), or
 *      unconfigured ("not configured"). CredentialStatusEntry carries no
 *      secret value field by construction (see provider-status.ts), this
 *      component only ever reads key/configured/usable/source/secure.
 */
import { useQuery } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import type { StatusTone } from './ui/StatusDot';
import { client as platformClient } from '../lib/goodvibes';
import { deriveCredentialAvailability, type CredentialStatusEntry } from '../lib/provider-status';
import { errorCode, formatError, isAdminRequiredError, serializeError } from '../lib/errors';
import { asRecord } from '../lib/object';
import { EmptyState } from './feedback/EmptyState';
import { SkeletonBlock } from './feedback/SkeletonBlock';
import { Chip } from './ui/Chip';
import { Row, RowList } from './ui/Row';
import { SettingsBlock } from './settings/dialog/parts';
import '../styles/components/providers.css';

function isForbidden(error: unknown): boolean {
  const serialized = serializeError(error);
  const transport = serialized.transport as Record<string, unknown> | undefined;
  return serialized.status === 403 || transport?.status === 403;
}

function credentialTone(entry: CredentialStatusEntry): StatusTone {
  if (!entry.configured || entry.notChecked) return 'idle';
  return entry.usable ? 'ok' : 'warn';
}

function credentialLabel(entry: CredentialStatusEntry): string {
  if (!entry.configured) return 'not configured';
  // A password-manager reference is not run by a listing; it is resolved when used.
  if (entry.notChecked) return 'configured, in a password manager (not checked)';
  return entry.usable ? 'usable' : 'configured, not usable';
}

/**
 * The stored-credential names a provider's own sign-in routes name (`secretKeys`, `envVars`),
 * from the provider record the daemon returns. This is how a custom provider says which key is its own.
 */
function routeCredentialNames(record: unknown): ReadonlySet<string> {
  const root = asRecord(record);
  const names = new Set<string>();
  for (const routes of [root.routes, asRecord(root.auth).routes, asRecord(asRecord(root.runtime).auth).routes]) {
    if (!Array.isArray(routes)) continue;
    for (const route of routes) {
      const fields = asRecord(route);
      for (const list of [fields.secretKeys, fields.envVars]) {
        if (Array.isArray(list)) for (const name of list) if (typeof name === 'string' && name) names.add(name);
      }
    }
  }
  return names;
}

export interface CredentialStatusPanelProps {
  /**
   * The currently selected provider id, if any. A stored name is highlighted as this provider's
   * when the built-in catalog declares it or the provider's own sign-in routes name it; any other
   * name is listed without the caption.
   */
  selectedProviderId?: string;
}

export function CredentialStatusPanel({ selectedProviderId }: CredentialStatusPanelProps) {
  const query = useQuery({
    queryKey: ['credentials'],
    queryFn: () => platformClient.operator.credentials.get(),
    retry: false,
  });

  // Checked before deriveCredentialAvailability so a non-admin credential is
  // told the actual cause; any other 403 (a refused origin, a missing scope)
  // shows the daemon's own reason rather than a generic "unavailable".
  const refused = query.isError && isAdminRequiredError(query.error);
  const otherRefusal = query.isError && !refused && isForbidden(query.error) ? formatError(query.error) : null;
  const availability =
    query.isSuccess
      ? deriveCredentialAvailability({ ok: true, value: query.data })
      : query.isError && !refused
        ? deriveCredentialAvailability({ ok: false, error: { code: errorCode(query.error) } })
        : null;
  // Flattened once here (rather than repeated `availability && availability.available`
  // chains in the JSX below) so the discriminated union narrows cleanly and the
  // optional-chain lint rule has nothing to flag.
  const degradedReason = otherRefusal ?? (availability?.available === false ? availability.reason : null);
  const credentials = availability?.available === true ? availability.credentials : null;
  // Same query key and call as the provider detail view, so an open provider page answers from its cache.
  const providerDetail = useQuery({
    queryKey: ['providers', selectedProviderId],
    enabled: Boolean(selectedProviderId),
    queryFn: () => platformClient.operator.providers.get(selectedProviderId!),
    retry: false,
  });
  const providerNames = useMemo(() => routeCredentialNames(providerDetail.data), [providerDetail.data]);

  return (
    <SettingsBlock className="credential-status" title="Credential status">
      {query.isPending ? (
        <div className="credential-status__skeleton" aria-label="Loading credential status" aria-busy="true">
          {Array.from({ length: 3 }, (_, i) => (
            <SkeletonBlock key={i} variant="block" height={36} />
          ))}
        </div>
      ) : refused ? (
        <div className="credential-status__degraded" role="status">
          <strong>Admin access required</strong>
          <span>Sign in with an admin-scoped token to view credential status.</span>
        </div>
      ) : degradedReason !== null ? (
        <div className="credential-status__degraded" role="status">
          <strong>Credential status unavailable</strong>
          <span>{degradedReason}</span>
        </div>
      ) : credentials !== null && credentials.length === 0 ? (
        <EmptyState
          icon={<KeyRound size={24} aria-hidden="true" />}
          title="No credentials"
          description="No credential status reported by the daemon."
        />
      ) : credentials !== null ? (
        <RowList aria-label="Credentials">
          {credentials.map((entry) => {
            const matched = Boolean(
              selectedProviderId && (readDeclaredProviderCredential(selectedProviderId, entry.key) === true
                || providerNames.has(entry.key)),
            );
            return (
              <Row
                key={entry.key}
                selected={matched}
                title={<span className="credential-status__key">{entry.key}</span>}
                meta={`${entry.source ?? 'source unknown'}${matched ? ' · for the selected provider' : ''}`}
                trailing={<Chip tone={credentialTone(entry)}>{credentialLabel(entry)}</Chip>}
              />
            );
          })}
        </RowList>
      ) : null}
    </SettingsBlock>
  );
}
