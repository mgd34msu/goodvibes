import { assertSynchronousJudgmentGuard, drainOwned } from '@goodvibes-jev/judgment/decisions';
import { builtinTriggerSupervisorMethodDescriptors } from './method-catalog-trigger-supervisor.js';
import { builtinDelegatedInboundMethodDescriptors } from './method-catalog-delegated-inbound.js';
import { builtinGatewayNativeHostedTurnMethodDescriptors } from './method-catalog-native-hosted-turn.js';
import { builtinGatewayNativeConversationIntakeMethodDescriptors } from './method-catalog-native-intake.js';
import { builtinGatewayNativeWorkSubmissionMethodDescriptors } from './method-catalog-native-work-submission.js';
import { builtinGatewayWorkLedgerMethodDescriptors } from './method-catalog-work-ledger.js';
import { builtinGatewayNativeWorkExecutionMethodDescriptors } from './method-catalog-native-work-execution.js';
import { builtinBrowserJudgmentMethodDescriptors } from './method-catalog-browser-judgment.js';
import {
  builtinGatewayAdminMethodDescriptors,
} from './method-catalog-admin.js';
import {
  builtinGatewayChannelMethodDescriptors,
} from './method-catalog-channels.js';
import {
  builtinGatewayChannelTestMethodDescriptors,
} from './method-catalog-channels-test.js';
import {
  builtinGatewayCostMethodDescriptors,
} from './method-catalog-cost.js';
import {
  builtinGatewayPermissionRuleMethodDescriptors,
} from './method-catalog-permission-rules.js';
import { builtinGatewayOwnerInboxMethodDescriptors } from './method-catalog-owner-inbox.js';
import { builtinGatewayOpsDoctorMethodDescriptors } from './method-catalog-ops-doctor.js';
import { builtinGatewayNotificationMethodDescriptors } from './method-catalog-notifications.js';
import {
  builtinGatewayControlMethodDescriptors,
} from './method-catalog-control.js';
import {
  builtinGatewayEmailMethodDescriptors,
} from './method-catalog-email.js';
import { builtinGatewayHomeAssistantMethodDescriptors } from './method-catalog-homeassistant.js';
import { builtinGatewayPaymentsMethodDescriptors } from './method-catalog-payments.js';
import {
  builtinGatewayCalendarMethodDescriptors,
} from './method-catalog-calendar.js';
import {
  builtinGatewayBrowserMethodDescriptors,
} from './method-catalog-browser.js';
import {
  builtinGatewayEventDescriptors,
} from './method-catalog-events.js';
import {
  builtinGatewayKnowledgeMethodDescriptors,
} from './method-catalog-knowledge.js';
import {
  builtinGatewayMediaMethodDescriptors,
} from './method-catalog-media.js';
import {
  builtinGatewayPushMethodDescriptors,
} from './method-catalog-push.js';
import {
  builtinGatewayPairingMethodDescriptors,
} from './method-catalog-pairing.js';
import {
  builtinGatewayTailscaleMethodDescriptors,
} from './method-catalog-tailscale.js';
import {
  builtinGatewayAcpMethodDescriptors,
} from './method-catalog-acp.js';
import type {
  GatewayEventDescriptor,
  GatewayEventListOptions,
  GatewayMethodDescriptor,
  GatewayMethodHandler,
  GatewayMethodInvocation,
  GatewayMethodListOptions,
} from './method-catalog-shared.js';
import { OWNER_PRIVATE_READ_SCOPES } from './method-catalog-shared.js';
import {
  builtinGatewayRuntimeMethodDescriptors,
} from './method-catalog-runtime.js';
import {
  builtinGatewayModelMethodDescriptors,
} from './method-catalog-models.js';
import { builtinGatewayBatchMethodDescriptors } from './method-catalog-batch.js';
import { builtinGatewayCloudflareMethodDescriptors } from './method-catalog-cloudflare.js';
import {
  builtinGatewayUpdateMethodDescriptors,
} from './method-catalog-update.js';
import {
  builtinGatewayRelayMethodDescriptors,
} from './method-catalog-relay.js';
import {
  builtinGatewayPrincipalsMethodDescriptors,
} from './method-catalog-principals.js';
import {
  builtinGatewayOwnerProfileMethodDescriptors,
} from './method-catalog-owner-profile.js';
import {
  builtinGatewayOccasionsMethodDescriptors,
} from './method-catalog-occasions.js';
import {
  builtinGatewayChannelProfilesMethodDescriptors,
} from './method-catalog-channel-profiles.js';
import {
  builtinGatewayCheckinMethodDescriptors,
} from './method-catalog-checkin.js';
import {
  builtinGatewayCiMethodDescriptors,
} from './method-catalog-ci.js';
import {
  builtinGatewaySkillsMethodDescriptors,
} from './method-catalog-skills.js';
import {
  builtinGatewayFlagsMethodDescriptors,
} from './method-catalog-flags.js';
import {
  builtinGatewayFlagsStatusMethodDescriptors,
} from './method-catalog-flags-status.js';
import {
  builtinGatewayRewindMethodDescriptors,
} from './method-catalog-rewind.js';
import {
  builtinGatewayWorkspacesMethodDescriptors,
} from './method-catalog-workspaces.js';
import {
  builtinGatewayStepUpMethodDescriptors,
} from './method-catalog-stepup.js';
import { GatewayVerbError } from './routes/gateway-verb-error.js';
import { EngineErrorCodes } from '@goodvibes-jev/engine/errors';

export type {
  GatewayEventDescriptor,
  GatewayEventListOptions,
  GatewayEventTransport,
  GatewayHttpBinding,
  GatewayMethodAccess,
  GatewayMethodDescriptor,
  GatewayMethodHandler,
  GatewayMethodInvocation,
  GatewayMethodInvocationContext,
  GatewayMethodListOptions,
  GatewayMethodSource,
  GatewayMethodTransport,
} from './method-catalog-shared.js';

interface RegisteredGatewayMethod {
  readonly descriptor: GatewayMethodDescriptor;
  readonly handler?: GatewayMethodHandler | undefined;
}

interface RegisteredGatewayEvent {
  readonly descriptor: GatewayEventDescriptor;
}

const BUILTIN_GATEWAY_EVENTS: readonly GatewayEventDescriptor[] = builtinGatewayEventDescriptors;

/** Every builtin gateway method descriptor, in registration order. */
export const BUILTIN_GATEWAY_METHODS: readonly GatewayMethodDescriptor[] = [
  ...builtinGatewayWorkLedgerMethodDescriptors,
  ...builtinGatewayNativeWorkExecutionMethodDescriptors,
  ...builtinGatewayNativeWorkSubmissionMethodDescriptors,
  ...builtinGatewayNativeConversationIntakeMethodDescriptors,
  ...builtinDelegatedInboundMethodDescriptors,
  ...builtinGatewayNativeHostedTurnMethodDescriptors,
  ...builtinGatewayControlMethodDescriptors,
  ...builtinBrowserJudgmentMethodDescriptors,
  ...builtinGatewayChannelMethodDescriptors,
  ...builtinGatewayHomeAssistantMethodDescriptors,
  ...builtinTriggerSupervisorMethodDescriptors,
  ...builtinGatewayChannelTestMethodDescriptors,
  ...builtinGatewayCostMethodDescriptors,
  ...builtinGatewayPermissionRuleMethodDescriptors,
  ...builtinGatewayOwnerInboxMethodDescriptors,
  ...builtinGatewayOpsDoctorMethodDescriptors,
  ...builtinGatewayNotificationMethodDescriptors,
  ...builtinGatewayEmailMethodDescriptors,
  ...builtinGatewayPaymentsMethodDescriptors,
  ...builtinGatewayCalendarMethodDescriptors,
  ...builtinGatewayBrowserMethodDescriptors,
  ...builtinGatewayRuntimeMethodDescriptors,
  ...builtinGatewayModelMethodDescriptors,
  ...builtinGatewayBatchMethodDescriptors,
  ...builtinGatewayCloudflareMethodDescriptors,
  ...builtinGatewayUpdateMethodDescriptors,
  ...builtinGatewayRelayMethodDescriptors,
  ...builtinGatewayKnowledgeMethodDescriptors,
  ...builtinGatewayMediaMethodDescriptors,
  ...builtinGatewayAdminMethodDescriptors,
  ...builtinGatewayPushMethodDescriptors,
  ...builtinGatewayPairingMethodDescriptors,
  ...builtinGatewayTailscaleMethodDescriptors,
  ...builtinGatewayAcpMethodDescriptors,
  ...builtinGatewaySkillsMethodDescriptors,
  ...builtinGatewayPrincipalsMethodDescriptors,
  ...builtinGatewayOwnerProfileMethodDescriptors,
  ...builtinGatewayOccasionsMethodDescriptors,
  ...builtinGatewayChannelProfilesMethodDescriptors,
  ...builtinGatewayCheckinMethodDescriptors,
  ...builtinGatewayCiMethodDescriptors,
  ...builtinGatewayFlagsMethodDescriptors,
  ...builtinGatewayFlagsStatusMethodDescriptors,
  ...builtinGatewayRewindMethodDescriptors,
  ...builtinGatewayWorkspacesMethodDescriptors,
  ...builtinGatewayStepUpMethodDescriptors,
];

function normalizeDescriptor(descriptor: GatewayMethodDescriptor): GatewayMethodDescriptor {
  const id = descriptor.id.trim();
  if (!id) throw new Error('Gateway method id is required');
  return Object.freeze({
    ...descriptor,
    id,
    transport: Object.freeze([...new Set(descriptor.transport)]),
    scopes: Object.freeze([...new Set(descriptor.scopes)]),
    events: descriptor.events ? Object.freeze([...new Set(descriptor.events)]) : undefined,
    ...(descriptor.http ? { http: Object.freeze({ ...descriptor.http }) } : {}),
    invokable: descriptor.invokable ?? true,
  });
}

function normalizeEventDescriptor(descriptor: GatewayEventDescriptor): GatewayEventDescriptor {
  const id = descriptor.id.trim();
  if (!id) throw new Error('Gateway event id is required');
  return Object.freeze({
    ...descriptor,
    id,
    transport: Object.freeze([...new Set(descriptor.transport)]),
    scopes: Object.freeze([...new Set(descriptor.scopes)]),
    domains: descriptor.domains ? Object.freeze([...new Set(descriptor.domains)]) : undefined,
    wireEvents: descriptor.wireEvents ? Object.freeze([...new Set(descriptor.wireEvents)]) : undefined,
  });
}

/**
 * The actual grant ceiling used by authenticated transport and native recovery.
 *
 * The authorization model, stated once: a principal's default scopes come
 * from its role when it authenticates. An admin (the owner's shared token, a
 * paired device, an admin user) holds every scope the catalog declares, read
 * and write; any other signed-in user holds every read scope except those over
 * the owner's private records (OWNER_PRIVATE_READ_SCOPES: mail, profile,
 * purchases, dates, memory, transcripts, paired devices) and no write scope. A
 * pairing or user that stores its own scope list is granted that list, never
 * more than its role's default (daemon/control-plane.ts `principalFor`). What
 * restricts a non-admin beyond that is each method's and each event's
 * `access`. The event stream applies the same rule as the request path,
 * derived from the event descriptors (gateway-scope-enforcement.ts
 * `resolveEventGrant`), so an event a non-admin receives carries nothing that
 * principal could not read through a method.
 */
export function grantedGatewayScopes(catalog: Pick<GatewayMethodCatalog, 'getAllScopes'>, includeWrite: boolean): string[] {
  const scopes = new Set(catalog.getAllScopes({ includeWrite }));
  if (!includeWrite) for (const scope of OWNER_PRIVATE_READ_SCOPES) scopes.delete(scope);
  scopes.add('read:events'); scopes.add('read:control-plane'); scopes.add('read:telemetry');
  if (includeWrite) { scopes.add('read:telemetry-sensitive'); scopes.add('write:control-plane'); }
  return [...scopes].sort();
}

export type GatewayPolicySnapshot = Readonly<{ methods: readonly unknown[]; events: readonly unknown[] }>;
export type GatewayPolicyRevision = (snapshot: GatewayPolicySnapshot) => string;

export interface GatewayScopePolicyOwner {
  /** Exact immutable registered scope state. Requires this still-attached owner. */
  current(version?: 1 | 2): Readonly<{ revision: string; scopes: readonly string[] }>;
  /** Scope membership alone needs no serialized catalog revision or digest. */
  grantedScopes(): readonly string[];
  close(): void;
}

function pathSegments(value: string): string[] {
  return (value.replace(/\/+$/, '') || '/').split('/');
}

function segmentsMatchTemplate(templateParts: readonly string[], pathParts: readonly string[]): boolean {
  if (templateParts.length !== pathParts.length) return false;
  return templateParts.every((segment, index) => {
    if (segment.startsWith('{') && segment.endsWith('}')) return (pathParts[index]?.length ?? 0) > 0;
    return segment === pathParts[index];
  });
}

/** HTTP bindings grouped by verb and segment count, in registration order. */
type HttpBindingIndex = Map<string, { readonly parts: readonly string[]; readonly descriptor: GatewayMethodDescriptor }[]>;

export class GatewayMethodCatalog {
  private readonly methods = new Map<string, RegisteredGatewayMethod>();
  private readonly events = new Map<string, RegisteredGatewayEvent>();
  private scopePolicyOwner: { readonly beforeMutation: () => void } | undefined;
  private scopePolicyChanging = false;
  private scopePolicyRetired = false;
  private scopePolicyState: object = {};
  private scopePolicySnapshot: ReturnType<GatewayScopePolicyOwner['current']> | undefined;
  private scopePolicyLegacySnapshot: ReturnType<GatewayScopePolicyOwner['current']> | undefined;
  private scopePolicyData: GatewayPolicySnapshot | undefined;
  private scopePolicyScopesSnapshot: readonly string[] | undefined;
  /** The admin and non-admin grants, rebuilt only after a method or event changes. */
  private grantCache: { write?: readonly string[]; read?: readonly string[] } = {};
  /** Every authenticated REST request looks its route up here; rebuilt only after a method changes. */
  private httpBindingIndex: HttpBindingIndex | undefined;

  /**
   * Called after initial host construction. Startup registration is hydration,
   * while all subsequent mutations persist revocation before changing scopes.
   * The callback is an owner precondition, never an authority reconstructed from
   * a stored watch, grant identifier, or caller-supplied scope list.
   */
  attachScopePolicyOwner(beforeMutation: () => void, revisionForSnapshot?: GatewayPolicyRevision): GatewayScopePolicyOwner {
    if (this.scopePolicyOwner || this.scopePolicyRetired) throw new Error('Gateway scope policy owner is already attached or retired');
    const owner = { beforeMutation }; this.scopePolicyOwner = owner;
    const grantedScopes = () => {
      if (this.scopePolicyOwner !== owner || this.scopePolicyChanging) throw new Error('Gateway scope policy owner is unavailable');
      if (this.scopePolicyScopesSnapshot) return this.scopePolicyScopesSnapshot;
      const state = this.scopePolicyState, scopes = Object.freeze(grantedGatewayScopes(this, true));
      if (this.scopePolicyOwner !== owner || this.scopePolicyChanging || this.scopePolicyState !== state) throw new Error('Gateway scopes changed while reading');
      this.scopePolicyScopesSnapshot = scopes; return scopes;
    };
    const revision = (data: GatewayPolicySnapshot): string => {
      const state = this.scopePolicyState;
      let result: unknown;
      try { result = revisionForSnapshot!(data); } catch (error) { drainOwned(error); throw error; }
      if (typeof result !== 'string' || !result || result.length > 4096) { drainOwned(result); throw new Error('Gateway policy revision must be a bounded synchronous value'); }
      if (this.scopePolicyOwner !== owner || this.scopePolicyChanging || this.scopePolicyState !== state) throw new Error('Gateway policy owner changed during revision read');
      return result;
    };
    return Object.freeze({
      grantedScopes,
      current: (version: 1 | 2 = 2) => {
        if (this.scopePolicyOwner !== owner || this.scopePolicyChanging) throw new Error('Gateway scope policy owner is unavailable');
        if (version === 1 && this.scopePolicyLegacySnapshot) return this.scopePolicyLegacySnapshot;
        if (this.scopePolicySnapshot && version === 2) {
          if (revisionForSnapshot && revision(this.scopePolicyData!) !== this.scopePolicySnapshot.revision) throw new Error('Gateway scope policy durable owner changed');
          return this.scopePolicySnapshot;
        }
        const state = this.scopePolicyState;
        const methods = [...this.methods].sort(([a], [b]) => a.localeCompare(b)).map(([id, entry]) => {
          const value = entry.descriptor;
          return [id, value.source, value.pluginId ?? null, value.access, [...value.transport].sort(), [...value.scopes].sort(),
            value.http ? [value.http.method, value.http.path] : null, value.invokable ?? null, value.dangerous ?? false, typeof entry.handler === 'function'];
        });
        const events = [...this.events].sort(([a], [b]) => a.localeCompare(b)).map(([id, entry]) => {
          const value = entry.descriptor;
          return [id, value.source, value.pluginId ?? null, [...value.transport].sort(), [...value.scopes].sort(),
            [...(value.domains ?? [])].sort(), [...(value.wireEvents ?? [])].sort()];
        });
        // Original native composition can persist this nonprivate exact tuple.
        // Standalone catalogs use an owner-local label and are cold after restart.
        const data: GatewayPolicySnapshot = { methods, events };
        const pending: object[] = [data];
        while (pending.length) { const value = pending.pop()!; for (const nested of Object.values(value)) if (nested !== null && typeof nested === 'object') pending.push(nested); Object.freeze(value); }
        if (version === 1) {
          // Only actual saved CI1 readers request this representation. It binds
          // their independently retained original registered-policy expectation.
          const legacy = Object.freeze({ revision: createHash('sha256').update(JSON.stringify(data)).digest('hex'), scopes: grantedScopes() });
          if (this.scopePolicyOwner !== owner || this.scopePolicyChanging || this.scopePolicyState !== state) throw new Error('Gateway policy changed while reading saved-format expectation');
          this.scopePolicyLegacySnapshot = legacy; return legacy;
        }
        const snapshot = Object.freeze({ revision: revisionForSnapshot ? revision(data) : randomUUID(), scopes: grantedScopes() });
        if (this.scopePolicyOwner !== owner || this.scopePolicyChanging || this.scopePolicyState !== state) {
          throw new Error('Gateway scope policy changed while reading its registered state');
        }
        this.scopePolicyData = data; this.scopePolicySnapshot = snapshot;
        return snapshot;
      },
      close: () => {
        if (this.scopePolicyOwner !== owner) return;
        // Daemon retirement is not a policy withdrawal. Reconstructed startup
        // may recover unchanged durable grants. This instance cannot reattach
        // or mint durable custody after teardown starts.
        this.scopePolicyRetired = true; this.scopePolicyOwner = undefined; this.scopePolicySnapshot = undefined; this.scopePolicyData = undefined; this.scopePolicyLegacySnapshot = undefined; this.scopePolicyScopesSnapshot = undefined;
      },
    });
  }

  private invalidateScopePolicySnapshot(): void {
    this.grantCache = {};
    this.httpBindingIndex = undefined;
    if (!this.scopePolicyOwner) return;
    this.scopePolicyState = {};
    this.scopePolicySnapshot = undefined; this.scopePolicyData = undefined; this.scopePolicyLegacySnapshot = undefined;
    this.scopePolicyScopesSnapshot = undefined;
  }

  private beforeScopeMutation(): void {
    const owner = this.scopePolicyOwner; if (!owner) return;
    if (this.scopePolicyChanging) throw new Error('Gateway scope policy mutation is reentrant');
    this.scopePolicyChanging = true;
    try {
      assertSynchronousJudgmentGuard(() => owner.beforeMutation(), () => new Error('Gateway scope policy mutation must be synchronous'));
      if (this.scopePolicyOwner !== owner) throw new Error('Gateway scope policy owner changed');
    } finally { this.scopePolicyChanging = false; }
  }

  constructor(options: { readonly includeBuiltins?: boolean } = {}) {
    if (options.includeBuiltins !== false) {
      for (const descriptor of BUILTIN_GATEWAY_METHODS) {
        this.register(descriptor, undefined, { replace: true });
      }
      for (const descriptor of BUILTIN_GATEWAY_EVENTS) {
        this.registerEvent(descriptor, { replace: true });
      }
    }
  }

  register(
    descriptor: GatewayMethodDescriptor,
    handler?: GatewayMethodHandler,
    options: { readonly replace?: boolean } = {},
  ): () => void {
    const normalized = normalizeDescriptor(descriptor);
    if (this.methods.has(normalized.id) && !options.replace) {
      throw new Error(`Gateway method already registered: ${normalized.id}`);
    }
    const registered = { descriptor: normalized, handler };
    this.beforeScopeMutation();
    this.methods.set(normalized.id, registered);
    this.invalidateScopePolicySnapshot();
    return () => {
      const current = this.methods.get(normalized.id);
      if (current === registered) {
        this.unregister(normalized.id);
      }
    };
  }

  registerEvent(
    descriptor: GatewayEventDescriptor,
    options: { readonly replace?: boolean } = {},
  ): () => void {
    const normalized = normalizeEventDescriptor(descriptor);
    if (this.events.has(normalized.id) && !options.replace) {
      throw new Error(`Gateway event already registered: ${normalized.id}`);
    }
    const registered = { descriptor: normalized };
    this.beforeScopeMutation();
    this.events.set(normalized.id, registered);
    this.invalidateScopePolicySnapshot();
    return () => {
      const current = this.events.get(normalized.id);
      if (current === registered) {
        this.unregisterEvent(normalized.id);
      }
    };
  }

  unregister(id: string): boolean {
    if (!this.methods.has(id)) return false;
    this.beforeScopeMutation();
    const removed = this.methods.delete(id);
    this.invalidateScopePolicySnapshot();
    return removed;
  }

  unregisterEvent(id: string): boolean {
    if (!this.events.has(id)) return false;
    this.beforeScopeMutation();
    const removed = this.events.delete(id);
    this.invalidateScopePolicySnapshot();
    return removed;
  }

  clearPluginMethods(pluginId: string): void {
    if (![...this.methods.values(), ...this.events.values()].some(entry => entry.descriptor.pluginId === pluginId)) return;
    this.beforeScopeMutation();
    for (const [id, entry] of this.methods.entries()) {
      if (entry.descriptor.pluginId === pluginId) {
        this.methods.delete(id);
      }
    }
    for (const [id, entry] of this.events.entries()) {
      if (entry.descriptor.pluginId === pluginId) {
        this.events.delete(id);
      }
    }
    this.invalidateScopePolicySnapshot();
  }

  list(options: GatewayMethodListOptions = {}): GatewayMethodDescriptor[] {
    return [...this.methods.values()]
      .map((entry) => entry.descriptor)
      .filter((descriptor) => !options.category || descriptor.category === options.category)
      .filter((descriptor) => !options.source || descriptor.source === options.source)
      .filter((descriptor) => !options.pluginId || descriptor.pluginId === options.pluginId)
      .sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
  }

  listEvents(options: GatewayEventListOptions = {}): GatewayEventDescriptor[] {
    return [...this.events.values()]
      .map((entry) => entry.descriptor)
      .filter((descriptor) => !options.category || descriptor.category === options.category)
      .filter((descriptor) => !options.source || descriptor.source === options.source)
      .filter((descriptor) => !options.pluginId || descriptor.pluginId === options.pluginId)
      .filter((descriptor) => !options.domain || descriptor.domains?.includes(options.domain))
      .sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
  }

  get(id: string): GatewayMethodDescriptor | null {
    return this.methods.get(id)?.descriptor ?? null;
  }

  getEvent(id: string): GatewayEventDescriptor | null {
    return this.events.get(id)?.descriptor ?? null;
  }

  hasHandler(id: string): boolean {
    return typeof this.methods.get(id)?.handler === 'function';
  }

  /**
   * The method bound to this route: the most specific binding (fewest `{param}`
   * segments) when several match. With `unique`, null when more than one does.
   */
  findByHttpBinding(method: string, pathname: string, options?: { readonly unique?: boolean }): GatewayMethodDescriptor | null {
    const pathParts = pathSegments(pathname);
    const bucket = this.bindingIndex().get(`${method.toUpperCase()} ${pathParts.length}`);
    if (!bucket) return null;
    let found: GatewayMethodDescriptor | null = null;
    let foundParams = Number.POSITIVE_INFINITY;
    for (const entry of bucket) {
      if (!segmentsMatchTemplate(entry.parts, pathParts)) continue;
      if (options?.unique && found) return null;
      const params = entry.parts.reduce((count, segment) => count + (segment.startsWith('{') && segment.endsWith('}') ? 1 : 0), 0);
      if (params < foundParams) {
        found = entry.descriptor;
        foundParams = params;
      }
    }
    return found;
  }

  private bindingIndex(): HttpBindingIndex {
    if (this.httpBindingIndex) return this.httpBindingIndex;
    const index: HttpBindingIndex = new Map();
    for (const entry of this.methods.values()) {
      const binding = entry.descriptor.http;
      if (!binding) continue;
      const parts = pathSegments(binding.path);
      const key = `${binding.method} ${parts.length}`;
      const bucket = index.get(key);
      if (bucket) bucket.push({ parts, descriptor: entry.descriptor }); else index.set(key, [{ parts, descriptor: entry.descriptor }]);
    }
    return this.httpBindingIndex = index;
  }

  /**
   * The grant for an admin (`includeWrite`) or non-admin principal. Built from
   * every method and event descriptor once, then served from memory until the
   * catalog changes; callers compare against it per request and per frame.
   */
  grantedScopes(includeWrite: boolean): readonly string[] {
    const key = includeWrite ? 'write' : 'read';
    return this.grantCache[key] ??= Object.freeze(grantedGatewayScopes(this, includeWrite));
  }

  getAllScopes(options: { readonly includeWrite?: boolean } = {}): string[] {
    const scopes = new Set<string>();
    for (const descriptor of this.methods.values()) {
      for (const scope of descriptor.descriptor.scopes) {
        if (!options.includeWrite && !scope.startsWith('read:')) continue;
        scopes.add(scope);
      }
    }
    for (const descriptor of this.events.values()) {
      for (const scope of descriptor.descriptor.scopes) {
        if (!options.includeWrite && !scope.startsWith('read:')) continue;
        scopes.add(scope);
      }
    }
    return [...scopes].sort();
  }

  /**
   * Run a method's registered internal handler directly. Note this does NOT consult
   * `descriptor.invokable` for a method that HAS a handler, see the field's doc
   * comment in method-catalog-shared.ts: a runtime that registered a real handler is
   * authoritative over whether the method works, the descriptor's `invokable` flag
   * is not. `invokeGatewayMethodCall` (../daemon/control-plane.ts) is what enforces
   * `invokable` for the generic HTTP/WS dispatch surface, via
   * `validateGatewayInvocation`, BEFORE ever reaching here.
   */
  async invoke(id: string, invocation: GatewayMethodInvocation): Promise<unknown> {
    const entry = this.methods.get(id);
    // Uncataloged id, a real machine code (METHOD_NOT_FOUND), not a prose Error, so
    // any direct caller of invoke() (bypassing the HTTP dispatch's own 404 below) gets
    // the same code-driven signal as invokeGatewayMethod/getGatewayMethod
    // (daemon-api/control-routes.ts) and invokeGatewayMethodCall (../daemon/control-
    // plane.ts), distinct from NOT_INVOKABLE (cataloged but not invokable), which is
    // the id existing but refusing dispatch, not the id being unknown outright.
    if (!entry) {
      throw new GatewayVerbError(`Unknown gateway method: ${id}`, EngineErrorCodes.METHOD_NOT_FOUND, 404);
    }
    if (!entry.handler) {
      // A method explicitly marked invokable:false with no registered handler is
      // honestly "not invokable anywhere" (see the field's doc comment), distinct
      // from a method that a caller expected to have a handler here but doesn't (a
      // real bug in that caller's wiring). A GatewayVerbError flows straight through
      // invokeGatewayMethodCall's existing catch into an honest 400/NOT_INVOKABLE
      // instead of a generic 500, and gives any OTHER caller of `invoke()` directly
      // (bypassing the HTTP gate) the same honest, typed signal.
      if (entry.descriptor.invokable === false) {
        throw new GatewayVerbError(
          `Gateway method is not invokable and has no registered handler: ${id}`,
          'NOT_INVOKABLE',
          400,
        );
      }
      throw new Error(`Gateway method has no internal handler: ${id}`);
    }
    return entry.handler(invocation);
  }
}
import { createHash, randomUUID } from 'node:crypto';
