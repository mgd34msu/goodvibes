/**
 * Triage asks its question on the model route the account already admitted for
 * privacy screening: the same destination, the same retention promise and the
 * same revocation. Only screened previews (the text the inbox stores and
 * shows) are sent, never the raw message.
 */
import { createSystemOnePort, DEFAULT_MODEL, type JudgmentPort } from '@goodvibes/judgment';
import { captureLoopbackEndpoint, createScreeningTransport } from '../../security/source-screening/transport.js';
import type { HostedProtectedSourceOwnerOptions, ProtectedSourceOwnerOptions } from '../../security/source-screening/types.js';
import type { InboxTriageAuthority } from './owned.js';

const HOSTED_JUDGMENT = Object.freeze({ endpoint: 'https://api.typesafe.ai', model: 'jev-latest' });

function isHosted(options: ProtectedSourceOwnerOptions): options is HostedProtectedSourceOwnerOptions {
  return 'kind' in options && options.kind === 'hosted';
}

/** The account's triage grant, bound to its screening route. Revoked whenever screening is. */
export function triageAuthorityFromScreening(providerId: string, accountScopeId: string | undefined, screening: ProtectedSourceOwnerOptions): InboxTriageAuthority {
  const hosted = isHosted(screening);
  const judgment = hosted ? HOSTED_JUDGMENT
    : { endpoint: captureLoopbackEndpoint(screening.judgment.endpoint), model: screening.judgment.model ?? DEFAULT_MODEL };
  const timeoutMs = screening.timeoutMs ?? 30_000;
  const authority = screening.authority;
  const port: JudgmentPort = {
    model: judgment.model,
    async ask(request) {
      // One owned connection per request, closed with it, like screening's own.
      const transport = createScreeningTransport({
        ...(hosted ? { kind: 'hosted' as const, credentials: screening.credentials } : { endpoints: [`${judgment.endpoint}/v1/systemone`] }),
        signal: AbortSignal.any([authority.signal, ...(request.signal ? [request.signal] : [])]),
        assertCurrent: () => authority.assertCurrent(), timeoutMs,
      });
      try {
        const route = createSystemOnePort({ endpoint: { kind: hosted ? 'hosted' : 'local', baseURL: judgment.endpoint,
          apiKey: hosted ? screening.credentials.typesafeApiKey : 'source-screening-local' },
        model: judgment.model, timeoutMs, retry: {}, fetch: transport.fetch });
        return await route.ask(request);
      } finally { await transport.close(); }
    },
  };
  return Object.freeze({
    providerId, ...(accountScopeId === undefined ? {} : { accountScopeId }),
    destinationId: hosted ? HOSTED_JUDGMENT.endpoint : judgment.endpoint,
    retention: authority.retention,
    port, signal: authority.signal,
    assertCurrent: () => authority.assertCurrent(),
  });
}
