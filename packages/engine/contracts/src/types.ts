import type { RuntimeEventDomain } from './generated/runtime-event-domains.js';
export type JsonSchema = Record<string, unknown>;
export type GatewayMethodTransport = 'http' | 'ws' | 'internal';
export type GatewayMethodSource = 'builtin' | 'plugin';
export type GatewayMethodAccess = 'public' | 'authenticated' | 'admin' | 'remote-peer';
export type GatewayEventTransport = 'sse' | 'ws' | 'internal';
export type { RuntimeEventDomain } from './generated/runtime-event-domains.js';
export type DistributedPeerKind = 'node' | 'device';
export const DISTRIBUTED_WORK_TYPES = [
  'invoke',
  'status.request',
  'location.request',
  'session.message',
  'automation.run',
  'device.capability',
] as const;
export type DistributedWorkType = (typeof DISTRIBUTED_WORK_TYPES)[number];
export type DistributedWorkStatus = 'queued' | 'claimed' | 'completed' | 'failed' | 'cancelled' | 'expired';

export interface ContractHttpDefinition {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly alsoAt?: readonly ('GET' | 'POST' | 'PATCH' | 'DELETE')[] | undefined;
  /** The status a success answers with (201 created, 202 accepted); absent: 200. */
  readonly successStatus?: 201 | 202 | undefined;
}

/**
 * How a retry of a method is recognised as the same request: a request header
 * or a request-body field whose repeated value replays the first result
 * instead of acting twice.
 */
export interface ContractReplayKey {
  readonly in: 'header' | 'body';
  readonly name: string;
  /** What a repeated value returns, and what a different request under the same value gets. */
  readonly behavior: string;
}

/** A `code` a method's route puts on an error body, with the HTTP status it comes with. */
export interface ContractErrorCode {
  readonly code: string;
  readonly status: number;
  /** The state the code reports and the next step, in one sentence. */
  readonly meaning: string;
}

export interface OperatorMethodContract {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly source: GatewayMethodSource;
  readonly access: GatewayMethodAccess;
  readonly transport: readonly GatewayMethodTransport[];
  readonly scopes: readonly string[];
  readonly http?: ContractHttpDefinition | undefined;
  readonly events?: readonly string[] | undefined;
  readonly inputSchema?: JsonSchema | undefined;
  readonly outputSchema?: JsonSchema | undefined;
  readonly pluginId?: string | undefined;
  readonly dangerous?: boolean | undefined;
  /**
   * What calling the method does: `read` changes nothing, `write` changes the
   * daemon's own state, `outward` sends messages, drives a remote host or a
   * browser, or runs metered model work. Set where the method is defined.
   */
  readonly effect?: 'read' | 'write' | 'outward' | undefined;
  /** The owner's own act: taken only with the owner-request signal; an agent is refused. */
  readonly ownerOnly?: boolean | undefined;
  /** A model never makes the call, whoever it acts for; an agent is refused and told how the owner does it. */
  readonly modelRefused?: boolean | undefined;
  /**
   * The confirmation the call needs before it runs, checked by the catalog
   * before the handler: `confirm` (input `confirm: true`, not declared a
   * non-person request), `owner-request` (`confirm: true` from a credential
   * that states a person asked), or `not-declined`. Refused with
   * CONFIRMATION_REQUIRED.
   */
  readonly confirmation?: 'confirm' | 'owner-request' | 'not-declined' | undefined;
  /** The call cannot be undone: an agent's call is the owner's to decide, never Jev's. */
  readonly irreversible?: boolean | undefined;
  /** The call changes what a running contract requires: an agent's call is the owner's to decide. */
  readonly changesContract?: boolean | undefined;
  /** Input paths (`to`, `attendees[]`) of the recipients the call sends to as the owner. */
  readonly recipients?: readonly string[] | undefined;
  readonly invokable?: boolean | undefined;
  /** Whether this method is idempotent. When true, safe to retry on 5xx + network errors. */
  readonly idempotent?: boolean | undefined;
  /** The header or body field that makes a retry of this method safe, when it has one. */
  readonly replay?: ContractReplayKey | undefined;
  /**
   * What sending the same call twice does: `safe`, nothing more happens;
   * `keyed`, safe when the call carries its `replay` key; `unsafe`, it acts
   * again. Every builtin method states it, read from its handler.
   */
  readonly repeat?: 'safe' | 'keyed' | 'unsafe' | undefined;
  /** Codes this method's route answers with beyond the shared engine codes. */
  readonly errorCodes?: readonly ContractErrorCode[] | undefined;
  /**
   * Intentionally open bag for generator-supplied extension fields (e.g.
   * plugin manifests, analytics tags, UI hints). Consumers must not rely on any
   * specific key being present, treat as advisory display metadata only.
   * Narrowing this type would require a versioned generator ABI bump.
   */
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface OperatorEventContract {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly source: GatewayMethodSource;
  readonly transport: readonly GatewayEventTransport[];
  readonly scopes: readonly string[];
  readonly domains?: readonly RuntimeEventDomain[] | undefined;
  readonly wireEvents?: readonly string[] | undefined;
  readonly payloadSchema?: JsonSchema | undefined;
  readonly outputSchema?: JsonSchema | undefined;
  readonly pluginId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface OperatorSchemaCoverageContract {
  readonly methods: number;
  readonly typedInputs: number;
  readonly genericInputs: number;
  readonly typedOutputs: number;
  readonly genericOutputs: number;
}

export interface OperatorEventCoverageContract {
  readonly events: number;
  readonly withDomains: number;
  readonly withWireEvents: number;
}

/**
 * How many cataloged verbs the invoke-layer input gate structurally validates
 * (typed object inputSchema) versus skips (generic object schema with no
 * declared properties, or no inputSchema at all). Surfaces the validation gap so
 * it is visible and shrinkable as verbs adopt typed input schemas.
 */
export interface OperatorValidationCoverageContract {
  readonly methods: number;
  readonly validated: number;
  readonly skippedGeneric: number;
  readonly skippedUntyped: number;
}

export interface OperatorContractManifest {
  readonly version: number;
  readonly product: {
    readonly id: string;
    readonly surface: string;
    readonly version: string;
  };
  readonly auth: {
    readonly modes: readonly string[];
    readonly login: {
      readonly method: string;
      readonly path: string;
      readonly requestSchema: JsonSchema;
      readonly responseSchema: JsonSchema;
    };
    readonly current: {
      readonly method: string;
      readonly path: string;
      readonly aliasPaths?: readonly string[] | undefined;
      readonly responseSchema: JsonSchema;
    };
    readonly sessionCookie: {
      readonly name: string;
      readonly httpOnly: boolean;
      readonly sameSite: string;
      readonly path: string;
    };
    readonly bearer: {
      readonly header: string;
      readonly queryParameters: readonly string[];
    };
  };
  readonly transports: {
    readonly http: {
      readonly statusPath: string;
      readonly methodsPath: string;
      readonly eventsCatalogPath: string;
    };
    readonly sse: {
      readonly path: string;
      readonly query: {
        readonly domains: string;
      };
    };
    readonly websocket: {
      readonly path: string;
      readonly clientFrames: readonly {
        readonly type: string;
        readonly fields?: readonly string[] | undefined;
      }[];
      readonly serverFrames: readonly {
        readonly type: string;
        readonly fields?: readonly string[] | undefined;
      }[];
    };
  };
  readonly operator: {
    readonly methods: readonly OperatorMethodContract[];
    readonly events: readonly OperatorEventContract[];
    readonly schemaCoverage: OperatorSchemaCoverageContract;
    readonly eventCoverage: OperatorEventCoverageContract;
    readonly validationCoverage?: OperatorValidationCoverageContract | undefined;
  };
  readonly peer: {
    readonly contractPath: string;
    readonly relationship: string;
  };
}

export interface PeerEndpointContract {
  readonly id: string;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly auth: 'none' | 'bearer-peer-token' | 'bearer-operator-token';
  readonly requiredScope?: string | undefined;
  readonly description: string;
  readonly inputSchema?: JsonSchema | undefined;
  readonly outputSchema?: JsonSchema | undefined;
  /** Whether this endpoint is idempotent. When true, safe to retry on 5xx + network errors. */
  readonly idempotent?: boolean | undefined;
}

export interface PeerContractManifest {
  readonly schemaVersion: 1;
  readonly transport: 'http-json';
  readonly basePath: '/api/remote';
  readonly peerKinds: readonly DistributedPeerKind[];
  readonly workTypes: readonly DistributedWorkType[];
  readonly scopes: readonly string[];
  readonly recommendedHeartbeatMs: number;
  readonly recommendedWorkPullMs: number;
  readonly endpoints: readonly PeerEndpointContract[];
  readonly workCompletionStatuses: readonly DistributedWorkStatus[];
  readonly metadata: Record<string, unknown>;
}
