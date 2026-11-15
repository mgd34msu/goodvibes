import { endpointKind, HOSTED_BASE_URL, validEndpointURL } from '@goodvibes-jev/judgment';
import { BrowserJudgmentError } from '@goodvibes-jev/engine/daemon-api';
import { captureJudgmentFallbackSettings, type ConfigManager, type SecretsManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { ProviderRegistry } from '@goodvibes-jev/engine/platform/platform/providers';
import type { GatewayMethodCatalog } from '@goodvibes-jev/engine/platform/platform/control-plane';
import { createWebuiBrowserJudgment, type BrowserJudgmentRoute } from '@goodvibes-jev/engine/platform/platform/judgment-browser';
import { createJudgmentSourceLifetime, type JudgmentServices } from '@goodvibes-jev/engine/platform/platform/runtime/operations';

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/**
 * The daemon's configured Jev service owns these fixed WebUI purposes:
 * interpreting an authenticated canonical daemon failure, deciding a reply
 * prefix the reply-marker rule does not know, finding speech seams in a host
 * chat message and matching an undeclared provider to a model catalog. This is
 * the same settings-owned route and metadata-only decision log used by the
 * engine. Read scopes and browser text never grant an arbitrary destination,
 * prompt, source category, or retention store.
 */
export function composeBrowserJudgment(input: {
  readonly judgment: JudgmentServices;
  readonly providers?: () => Pick<ProviderRegistry, 'captureProviderCatalogIds'>;
  readonly config: ConfigManager;
  readonly secrets: Pick<SecretsManager, 'onDidChange'> & Partial<Pick<SecretsManager,
    'list' | 'getCredentialMutationState' | 'onDidInvalidateCredentials' | 'resolveLocalCredentialSnapshot'>>;
  readonly methods: GatewayMethodCatalog;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly disposal: { add(label: string, dispose: () => void | Promise<void>): void };
}) {
  const sourceLifetime = createJudgmentSourceLifetime(input);
  let credentialLifetime = new AbortController();
  let configLifetime = new AbortController();
  const revisions = new WeakMap<object, string>();
  let revision: string | undefined;
  let closed = false;
  const subscriptions = [input.config.onDidInvalidate(() => { configLifetime.abort(); configLifetime = new AbortController(); })];
  subscriptions.push(input.secrets.onDidChange(() => {
    credentialLifetime.abort(); credentialLifetime = new AbortController();
  }));
  const currentRoute = (): BrowserJudgmentRoute | undefined => {
    if (closed) return undefined;
    // The same private config/credential observation as the native composition,
    // acquired from these explicit owners rather than the global installed port.
    let frame: ReturnType<typeof sourceLifetime.capture>;
    try { frame = sourceLifetime.capture(); }
    catch { throw new BrowserJudgmentError('JUDGMENT_PERMISSION_HELD'); }
    const fallbacks = captureJudgmentFallbackSettings(input.config.get('judgment.fallbacks'));
    const endpoint = text(input.config.get('judgment.endpoint')) || text(input.env['TYPESAFE_BASE_URL']) || HOSTED_BASE_URL;
    if (!validEndpointURL(endpoint)) return undefined;
    const kind = endpointKind(endpoint);
    const endpointKinds = Object.freeze([...new Set([kind, ...fallbacks.map(target => endpointKind(target.endpoint))])]);
    const credentials = credentialLifetime;
    let capturedRevision = revisions.get(frame.identity);
    if (!capturedRevision) { capturedRevision = crypto.randomUUID(); revisions.set(frame.identity, capturedRevision); }
    revision = capturedRevision;
    const signal = AbortSignal.any([...(frame.signal ? [frame.signal] : []), credentials.signal]);
    const assertCurrent = () => {
      try {
        frame.assertCurrent();
        if (closed || signal.aborted || credentials !== credentialLifetime || revision !== capturedRevision) throw new Error('Retired route');
      } catch { throw new BrowserJudgmentError('JUDGMENT_PERMISSION_HELD'); }
    };
    assertCurrent();
    return {
      revision: capturedRevision, kind, endpointKinds, port: input.judgment.browserPort ?? input.judgment.port, signal, assertCurrent,
    };
  };
  const service = createWebuiBrowserJudgment({ methods: input.methods, currentRoute,
    ...(input.providers ? { providerCatalog: {
      capture() {
        const registry = input.providers!();
        const source = registry.captureProviderCatalogIds();
        const config = configLifetime;
        const credentials = credentialLifetime;
        return {
          snapshot: { providerIds: source.providerIds, catalogProviderIds: source.catalogProviderIds },
          signal: AbortSignal.any([config.signal, credentials.signal]),
          assertCurrent() {
            if (closed || input.providers!() !== registry || config !== configLifetime || credentials !== credentialLifetime
              || config.signal.aborted || credentials.signal.aborted) throw new BrowserJudgmentError('JUDGMENT_REFERENCE_HELD');
            source.assertCurrent();
          },
        };
      },
    } } : {}),
    authorize({ battery, sources, route }) {
      if (closed || route.revision !== revision || !sources.length) return false;
      // Explicit source/purpose allowlist. Reference ownership is independently
      // proved by the source owner before this product policy is consulted.
      return battery === 'webui.errors.daemon-refusal'
        ? sources.length === 1 && sources[0] === 'daemon-error'
        : battery === 'webui.models.catalog-provider-match'
          ? sources.length === 1 && sources[0] === 'provider-catalog-ids'
          : battery === 'webui.voice.speech-seams'
            ? sources.length === 1 && sources[0] === 'chat-speech'
            : battery === 'webui.mail.reply-subject' && sources.length === 1 && sources[0] === 'mail-subject';
    },
  });
  input.disposal.add('browser judgment transport', async () => {
    closed = true;
    for (const unsubscribe of subscriptions) unsubscribe();
    const closing = service.close();
    sourceLifetime.dispose();
    credentialLifetime.abort();
    configLifetime.abort();
    await closing;
  });
  return service;
}
