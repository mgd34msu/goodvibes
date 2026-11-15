import { createSpeechSeamsAdapter } from './batteries/speech-seams.js';
import { canonicalSpeechSeams, snapshotSpeechSeams } from './speech-source.js';
import {
  BrowserJudgmentError, missingScopes,
  type AuthenticatedPrincipal, type BrowserJudgmentBatteryId, type BrowserJudgmentErrorSource, type BrowserJudgmentChatSessions, type BrowserJudgmentMailSubjectSource,
} from '@goodvibes-jev/engine/daemon-api';
import type { GatewayMethodDescriptor } from '../control-plane/method-catalog-shared.js';
import { snapshotJudgmentInput } from '../gate/judgment-input.js';
import { BrowserJudgmentReferences } from './references.js';
import { BrowserJudgmentRegistry } from './registry.js';
import { BrowserJudgmentService } from './service.js';
import type { BrowserJudgmentAuthorization, BrowserJudgmentRoute } from './types.js';
import { createWebuiCatalogProviderAdapter, webuiDaemonRefusalAdapter, webuiMailReplySubjectAdapter } from './batteries/webui-adapters.js';
import { readStructuredDaemonRefusal, snapshotWebuiDaemonRefusal, snapshotWebuiMailSubject, snapshotWebuiCredentialNames } from './batteries/webui-readers.js';
import { granted, requireSynchronousAssertion } from './guards.js';

const ERRORS = 'webui.errors.daemon-refusal';
const MAIL = 'webui.mail.reply-subject';
export type WebuiJudgmentSourceKind = 'daemon-error' | 'mail-subject' | 'chat-speech' | 'provider-catalog-ids';

/** Source/purpose permission is owned by the host, separately from read scopes. */
export interface WebuiBrowserJudgmentOptions {
  /** Canonical identity metadata only. The host retains the original registry generation and provider owners. */
  readonly providerCatalog?: {
    readonly capture: () => {
      readonly snapshot: { readonly providerIds: readonly string[]; readonly catalogProviderIds: readonly string[] };
      readonly signal: AbortSignal;
      readonly assertCurrent: () => void;
    };
  };
  readonly methods: { get(id: string): GatewayMethodDescriptor | null };
  readonly currentRoute: () => BrowserJudgmentRoute | undefined;
  readonly authorize: (input: BrowserJudgmentAuthorization & { readonly sources: readonly WebuiJudgmentSourceKind[] }) => boolean;
}

const held = (): never => { throw new BrowserJudgmentError('JUDGMENT_REFERENCE_HELD'); };
function canRead(principal: AuthenticatedPrincipal, scopes: readonly string[]): boolean {
  return principal.admin === true || missingScopes(principal.scopes, scopes).length === 0;
}

/**
 * The real WebUI source owner. Only host chat messages read for speech, provider
 * catalog ids, canonical mail-read subjects and authenticated failures enter this closed registry.
 * Status enums stay in the pure catalog; no dynamic status issuer is invented.
 */
export function createWebuiBrowserJudgment(options: WebuiBrowserJudgmentOptions): BrowserJudgmentService {
  const references = new BrowserJudgmentReferences();
  const registry = new BrowserJudgmentRegistry();
  let chatSource: BrowserJudgmentChatSessions | undefined;
  const bindings = new Map<string, { readonly principalId: string; readonly principalKind: AuthenticatedPrincipal['principalKind']; readonly battery: BrowserJudgmentBatteryId;
    readonly sources: readonly WebuiJudgmentSourceKind[] }>();
  const remember = (id: string, principal: AuthenticatedPrincipal, battery: BrowserJudgmentBatteryId,
    sources: readonly WebuiJudgmentSourceKind[]) => {
    try {
      const lease = references.resolve(id, () => principal, battery, (value) => value);
      bindings.set(id, { principalId: principal.principalId, principalKind: principal.principalKind, battery, sources: Object.freeze([...sources]) });
      lease.signal!.addEventListener('abort', () => bindings.delete(id), { once: true });
      return id;
    } catch (error) { references.revoke(id); throw error; }
  };

  registry.register(createSpeechSeamsAdapter(async (input, context) => {
    const battery = 'webui.voice.speech-seams';
    const principal = context.currentPrincipal();
    const sessions = chatSource;
    if (!sessions || (!sessions.getMessage && !sessions.getMessages) || !canRead(principal, ['read:sessions'])) return held();
    const session = sessions.getSession(input.sessionId);
    const readMessage = () => sessions.getMessage
      ? sessions.getMessage(input.sessionId, input.messageId)
      : sessions.getMessages?.(input.sessionId).find(item => item.id === input.messageId);
    const message = readMessage();
    if (!session || session.id !== input.sessionId || !message || message.id !== input.messageId || message.sessionId !== input.sessionId || !message.contentRevision || message.contentRevision !== input.contentRevision) return held();
    const content = message.content; const contentRevision = message.contentRevision; const createdAt = message.createdAt; const supersededAt = message.supersededAt;
    const assertCurrent = () => {
      context.signal.throwIfAborted();
      const current = context.currentPrincipal();
      if (current.principalId !== principal.principalId || current.principalKind !== principal.principalKind || !canRead(current, ['read:sessions'])
        || chatSource !== sessions || sessions.getSession(input.sessionId) !== session || session.id !== input.sessionId
        || readMessage() !== message
        || message.id !== input.messageId || message.sessionId !== input.sessionId || message.contentRevision !== contentRevision || message.content !== content || message.createdAt !== createdAt || message.supersededAt !== supersededAt) return held();
    };
    assertCurrent();
    let snapshot;
    try {
      // Screen the complete canonical source before selecting any outward content.
      const original = snapshotJudgmentInput({ content }) as { readonly content: string };
      snapshot = canonicalSpeechSeams(original.content, input.start, input.end, input.cursor);
    } catch { throw new BrowserJudgmentError('JUDGMENT_INPUT_HELD'); }
    const id = remember(references.issue({ principalId: principal.principalId, battery, revision: crypto.randomUUID(),
      expiresAt: Date.now() + 300_000, snapshot, assertCurrent,
      mayRead: actor => actor.principalId === principal.principalId && actor.principalKind === principal.principalKind && canRead(actor, ['read:sessions']),
    }), principal, battery, ['chat-speech']);
    try { return { ...references.resolve(id, context.currentPrincipal, battery, snapshotSpeechSeams), dispose: () => references.revoke(id) }; }
    catch (error) { references.revoke(id); throw error; }
  }));
  registry.register(createWebuiCatalogProviderAdapter(async (input, context) => {
    const battery = 'webui.models.catalog-provider-match';
    const principal = context.currentPrincipal();
    const { principalId, principalKind } = principal;
    const source = options.providerCatalog;
    const methods = ['providers.list', 'models.list'].map(id => options.methods.get(id));
    if (!source || methods.some(method => !method || (method.access === 'admin' && !principal.admin) || !canRead(principal, method.scopes))) return held();
    const captured = source.capture();
    const assertCurrent = () => {
      context.signal.throwIfAborted(); captured.signal.throwIfAborted();
      requireSynchronousAssertion(captured.assertCurrent, 'JUDGMENT_REFERENCE_HELD');
      const current = context.currentPrincipal();
      if (current.principalId !== principalId || current.principalKind !== principalKind
        || options.providerCatalog !== source || methods.some((method, index) => !method
          || options.methods.get(index === 0 ? 'providers.list' : 'models.list') !== method
          || (method.access === 'admin' && !current.admin) || !canRead(current, method.scopes))) return held();
    };
    assertCurrent();
    let snapshot;
    try {
      // The complete authoritative ID inventory is screened before request selection or hashing.
      const inventory = snapshotJudgmentInput(captured.snapshot) as typeof captured.snapshot;
      snapshot = snapshotWebuiCredentialNames(input);
      const validIds = (value: readonly string[]) => Array.isArray(value)
        && value.every(id => typeof id === 'string' && id.trim().length > 0 && id.length <= 128)
        && new Set(value).size === value.length;
      if (Object.keys(inventory).length !== 2 || !Object.hasOwn(inventory, 'providerIds') || !Object.hasOwn(inventory, 'catalogProviderIds')
        || !validIds(inventory.providerIds) || !validIds(inventory.catalogProviderIds)
        || !inventory.providerIds.includes(snapshot.providerId)
        || snapshot.keys.some(key => !inventory.catalogProviderIds.includes(key))) return held();
    } catch { throw new BrowserJudgmentError('JUDGMENT_INPUT_HELD'); }
    assertCurrent();
    const id = remember(references.issue({ principalId, battery, revision: crypto.randomUUID(),
      expiresAt: Date.now() + 300_000, snapshot, assertCurrent,
      mayRead: actor => actor.principalId === principalId && actor.principalKind === principalKind
        && methods.every(method => !!method && (method.access !== 'admin' || actor.admin === true) && canRead(actor, method.scopes)),
    }), principal, battery, ['provider-catalog-ids']);
    const revoke = () => references.revoke(id);
    captured.signal.addEventListener('abort', revoke, { once: true });
    try {
      const lease = references.resolve(id, context.currentPrincipal, battery, snapshotWebuiCredentialNames);
      lease.signal!.addEventListener('abort', () => captured.signal.removeEventListener('abort', revoke), { once: true });
      assertCurrent();
      return { ...lease, dispose: revoke };
    } catch (error) { captured.signal.removeEventListener('abort', revoke); revoke(); throw error; }
  }));
  registry.register(webuiDaemonRefusalAdapter);
  registry.register(webuiMailReplySubjectAdapter);

  const issueMailSubjectReference = ({ principal, snapshot: source }: BrowserJudgmentMailSubjectSource): string | undefined => {
    let id: string | undefined;
    try {
      const method = options.methods.get('email.inbox.read');
      if (!method || method.access === 'remote-peer'
        || (method.access === 'admin' && !principal.admin) || !canRead(principal, [...method.scopes, 'read:email', 'write:judgment'])
        || !source.revision || source.signal.aborted) return undefined;
      const scopes = [...method.scopes];
      const access = method.access;
      const assertCurrent = () => {
        if (source.signal.aborted || options.methods.get('email.inbox.read') !== method || method.access !== access
          || method.scopes.length !== scopes.length
          || method.scopes.some((scope, index) => scope !== scopes[index])) return held();
        requireSynchronousAssertion(source.assertCurrent, 'JUDGMENT_REFERENCE_HELD');
      };
      assertCurrent();
      // The complete sender-authored subject is the only model state. Screening
      // may hold it, but may never turn a verdict about changed text into a
      // prefix decision for the original message.
      const subject = source.subject;
      const snapshot = snapshotWebuiMailSubject({ subject });
      if (snapshot.subject !== subject) return undefined;
      id = remember(references.issue({ principalId: principal.principalId, battery: MAIL, revision: source.revision,
        expiresAt: Date.now() + 300_000, snapshot, assertCurrent,
        mayRead: (actor) => actor.principalKind === principal.principalKind && (access !== 'admin' || actor.admin)
          && canRead(actor, [...scopes, 'read:email', 'write:judgment']),
      }), principal, MAIL, ['mail-subject']);
      const referenceId = id;
      const revoke = () => references.revoke(referenceId);
      source.signal.addEventListener('abort', revoke, { once: true });
      const lease = references.resolve(id, () => principal, MAIL, snapshotWebuiMailSubject);
      lease.signal!.addEventListener('abort', () => source.signal.removeEventListener('abort', revoke), { once: true });
      assertCurrent();
      return id;
    } catch { if (id) references.revoke(id); return undefined; }
  };

  const issueErrorReference = ({ principal, methodId, status, body }: BrowserJudgmentErrorSource): string | undefined => {
    try {
      if (!canRead(principal, ['write:judgment']) || status < 400 || status > 599) return undefined;
      const method = options.methods.get(methodId);
      if (!method || method.access === 'remote-peer' || (method.access === 'admin' && !principal.admin)
        || !canRead(principal, method.scopes)) return undefined;
      const scopes = Object.freeze([...method.scopes]);
      const access = method.access;
      // The canonical response is inspected in full before selecting its
      // bounded original error message. No stack, URL, header or payload is
      // staged by the browser, and no returned errorRef is ever trusted.
      const source = snapshotJudgmentInput(body);
      if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
      const fields = source as Record<string, unknown>;
      const message = typeof fields['error'] === 'string' ? fields['error'] : fields['message'];
      const snapshot = snapshotWebuiDaemonRefusal({ methodId, status, message,
        ...(typeof fields['code'] === 'string' ? { code: fields['code'] } : {}),
        ...(fields['category'] === 'network' || fields['category'] === 'authentication' ? { category: fields['category'] } : {}),
      });
      if (!snapshot.message.trim() || readStructuredDaemonRefusal(snapshot) !== undefined) return undefined;
      const assertCurrent = () => {
        if (options.methods.get(methodId) !== method || method.access !== access || method.scopes.length !== scopes.length
          || method.scopes.some((scope, index) => scope !== scopes[index])) return held();
      };
      return remember(references.issue({ principalId: principal.principalId, battery: ERRORS,
        revision: crypto.randomUUID(), expiresAt: Date.now() + 300_000, snapshot, assertCurrent,
        mayRead: (actor) => actor.principalKind === principal.principalKind && canRead(actor, ['write:judgment', ...scopes]) && (access !== 'admin' || actor.admin),
      }), principal, ERRORS, ['daemon-error']);
    } catch { return undefined; }
  };
  return new BrowserJudgmentService({ registry, references, currentRoute: options.currentRoute, issueErrorReference, issueMailSubjectReference,
    bindChatSessions(source) {
      const invalidate = () => {
        for (const [id, binding] of bindings) if (binding.sources.includes('chat-speech')) references.revoke(id);
      };
      invalidate();
      chatSource = source;
      return () => { if (chatSource === source) { chatSource = undefined; invalidate(); } };
    },
    authorize(input) {
      const binding = bindings.get(input.sourceBinding);
      return !!binding && binding.principalId === input.principal.principalId && binding.principalKind === input.principal.principalKind && binding.battery === input.battery
        && granted(options.authorize({ ...input, sources: binding.sources }));
    },
  });
}
