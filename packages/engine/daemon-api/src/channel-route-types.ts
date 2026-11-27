import type { ChannelConversationKind, ChannelLifecycleAction, JsonRecord } from './route-helpers.js';

export type ChannelSurface = string;
export type ChannelDirectoryScope = string;

export interface ChannelAgentToolDefinitionLike {
  readonly definition: unknown;
}

export interface ChannelTargetResolutionInput {
  readonly input: string;
  readonly accountId?: string | undefined;
  readonly preferredKind?: ChannelConversationKind | undefined;
  readonly threadId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly createIfMissing?: boolean | undefined;
  readonly live?: boolean | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export type ChannelTargetSource = 'explicit' | 'directory' | 'route' | 'normalized' | 'synthetic' | 'miss';

/** A conversation `resolveTarget` found; the routes pass it back to authorization unchanged. */
export interface ChannelResolvedTargetLike {
  readonly surface: ChannelSurface;
  readonly input: string;
  readonly normalized: string;
  readonly kind: ChannelConversationKind;
  readonly to: string;
  readonly display?: string | undefined;
  readonly accountId?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly channelId?: string | undefined;
  readonly groupId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly parentId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly sessionTarget?: string | undefined;
  readonly bindingId?: string | undefined;
  readonly directoryEntryId?: string | undefined;
  readonly source: ChannelTargetSource;
  readonly metadata: Record<string, unknown>;
}

export interface ChannelAuthorizeActionInput {
  readonly actionId: string;
  readonly actorId?: string | undefined;
  readonly accountId?: string | undefined;
  readonly target?: ChannelResolvedTargetLike | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export type ChannelConversationPolicy = 'allow' | 'deny' | 'inherit';

export interface ChannelGroupPolicyInput {
  readonly id: string;
  readonly label?: string;
  readonly groupId?: string;
  readonly channelId?: string;
  readonly workspaceId?: string;
  readonly requireMention?: boolean;
  readonly allowGroupMessages?: boolean;
  readonly allowThreadMessages?: boolean;
  readonly allowTextCommandsWithoutMention?: boolean;
  readonly allowlistUserIds?: readonly string[];
  readonly allowlistChannelIds?: readonly string[];
  readonly allowlistGroupIds?: readonly string[];
  readonly allowedCommands?: readonly string[];
  readonly metadata?: Record<string, unknown>;
}

/** The fields a policy write may change; each one the route checked. */
export interface ChannelPolicyPatch {
  readonly enabled?: boolean;
  readonly requireMention?: boolean;
  readonly allowDirectMessages?: boolean;
  readonly allowGroupMessages?: boolean;
  readonly allowThreadMessages?: boolean;
  readonly allowTextCommandsWithoutMention?: boolean;
  readonly open?: boolean;
  /** "Project for this channel": a registered project's folder; empty clears it (none). */
  readonly project?: string | undefined;
  readonly dmPolicy?: ChannelConversationPolicy;
  readonly groupPolicy?: ChannelConversationPolicy;
  readonly allowlistUserIds?: readonly string[];
  readonly allowlistChannelIds?: readonly string[];
  readonly allowlistGroupIds?: readonly string[];
  readonly allowedCommands?: readonly string[];
  readonly groupPolicies?: readonly ChannelGroupPolicyInput[];
  readonly metadata?: Record<string, unknown>;
}

export interface ChannelAllowlistInput {
  readonly add?: readonly string[] | undefined;
  readonly remove?: readonly string[] | undefined;
  readonly groupId?: string | undefined;
  readonly channelId?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly kind?: 'user' | 'channel' | 'group' | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface ChannelDirectoryQuery {
  readonly query: string;
  readonly scope?: ChannelDirectoryScope | undefined;
  readonly groupId?: string | undefined;
  readonly limit?: number | undefined;
  readonly live?: boolean | undefined;
}

/** A refusal as a channel tool or action states it: what is true, why, and what to do next. */
export interface ChannelActionRefusalLike {
  readonly code: string;
  readonly state: string;
  readonly reason: string;
  readonly next: readonly string[];
  readonly status?: number | undefined;
}

/**
 * What a channel tool or operator action call came to: the answer, or a
 * refusal saying the thing asked about was not found, the call was refused, or
 * the surface has no such tool or action. Only `ok` is a success.
 */
export type ChannelActionOutcomeLike =
  | { readonly status: 'ok'; readonly result: unknown }
  | { readonly status: 'not-found' | 'refused' | 'unknown-action'; readonly refusal: ChannelActionRefusalLike };

export interface ChannelPluginServiceLike {
  listAccounts(surface?: ChannelSurface): Promise<readonly unknown[]>;
  getAccount(surface: ChannelSurface, accountId: string): Promise<unknown | null>;
  getSetupSchema(surface: ChannelSurface, accountId?: string): Promise<unknown | null>;
  doctor(surface: ChannelSurface, accountId?: string): Promise<unknown | null>;
  listRepairActions(surface: ChannelSurface, accountId?: string): Promise<readonly unknown[]>;
  getLifecycleState(surface: ChannelSurface, accountId?: string): Promise<unknown | null>;
  runAccountAction(
    surface: ChannelSurface,
    action: ChannelLifecycleAction,
    accountId: string | undefined,
    input?: JsonRecord,
  ): Promise<unknown | null>;
  listCapabilities(surface?: ChannelSurface): Promise<readonly unknown[]>;
  listTools(surface?: ChannelSurface): Promise<readonly unknown[]>;
  listAgentTools(surface?: ChannelSurface): readonly ChannelAgentToolDefinitionLike[];
  invokeTool(surface: ChannelSurface, toolId: string, input?: JsonRecord): Promise<ChannelActionOutcomeLike>;
  listOperatorActions(surface?: ChannelSurface): Promise<readonly unknown[]>;
  invokeOperatorAction(surface: ChannelSurface, actionId: string, input?: JsonRecord): Promise<ChannelActionOutcomeLike>;
  resolveTarget(surface: ChannelSurface, input: ChannelTargetResolutionInput): Promise<ChannelResolvedTargetLike | null>;
  authorizeActorAction(surface: ChannelSurface, input: ChannelAuthorizeActionInput): Promise<unknown | null>;
  resolveAllowlist(surface: ChannelSurface, input: ChannelAllowlistInput): Promise<unknown | null>;
  editAllowlist(surface: ChannelSurface, input: ChannelAllowlistInput): Promise<unknown | null>;
  listStatus(): Promise<readonly unknown[]>;
  queryDirectory(surface: ChannelSurface, query: ChannelDirectoryQuery): Promise<readonly unknown[]>;
}

export interface ChannelPolicyServiceLike {
  listPolicies(): readonly unknown[];
  /** Null when no channel by that name exists; nothing is written then. */
  upsertPolicy(surface: ChannelSurface, input: ChannelPolicyPatch): Promise<unknown | null>;
  listAudit(limit: number): readonly unknown[];
}

export interface SurfaceRegistryLike {
  /** Built on each call from the live enabled rule and each surface's health. */
  list(): Promise<readonly unknown[]>;
}

/**
 * Inbound mail's health entry, mirrored structurally the way this package
 * mirrors every platform type it routes.
 *
 * `kind` is the discriminant. It was declared on `InboundMailHealthEntry` and
 * documented as distinguishing this entry "from a channel's in a mixed list",
 * and there was no mixed list, the two functions that produce it had zero
 * callers repo-wide, so email appeared in no health surface at all. This is
 * the list it was named for.
 */
export interface InboundMailHealthLike {
  readonly kind: 'email-inbound';
  readonly account: string;
  readonly mailbox: string;
  readonly state: string;
  readonly mode: string;
  readonly reason: string;
  readonly enabled: boolean;
}

export interface DaemonChannelRouteContext {
  readonly channelPlugins: ChannelPluginServiceLike;
  /**
   * Inbound mail's health, when this daemon watches a mailbox.
   *
   * Optional because an embedder composing routes without the builtin channel
   * runtime has no mailbox to report on, not because the answer is optional
   * when there IS one.
   */
  readonly inboundMailHealth?: (() => InboundMailHealthLike | null) | undefined;
  readonly channelPolicy: ChannelPolicyServiceLike;
  readonly parseJsonBody: (req: Request) => Promise<JsonRecord | Response>;
  readonly parseOptionalJsonBody: (req: Request) => Promise<JsonRecord | null | Response>;
  readonly requireAdmin: (req: Request) => Response | null;
  readonly surfaceRegistry: SurfaceRegistryLike;
  /**
   * Why a folder cannot be a channel's project ("Project for this channel": a registered project's absolute folder), in
   * words; undefined when it can. Absent: no project can be chosen.
   */
  readonly channelProjectRefusal?: ((folder: string) => string | undefined) | undefined;
}
