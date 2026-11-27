import type { JsonRecord } from './route-helpers.js';
import type { RequestPrincipal } from './http-policy.js';
import type { RuntimeEventDomain } from '@goodvibes/engine/contracts';

export type { RuntimeEventDomain };

export interface IntegrationRuntimeStoreLike {
  getState(): {
    readonly deliveries: {
      readonly deliveryAttempts: Map<string, unknown>;
    };
  };
}

/** What decides whether a caller may read one shared session: its id and the kind that created it. */
export interface SessionReadSubject {
  readonly id: string;
  readonly kind?: unknown;
}

/**
 * Whether the request's caller may read this session. A hosted session is
 * readable only by its owners and admins (as sessions.hosted.list); absent,
 * every session is listed to every caller the route admits.
 */
export type SessionReadPolicy = (req: Request, session: SessionReadSubject) => boolean;

export interface IntegrationHelperServiceLike {
  buildReview(): unknown;
  getSessionSnapshot(): unknown;
  getTaskSnapshot(limit?: number): unknown;
  getAutomationSnapshot(): unknown;
  /** The session list; `readable` keeps only the sessions the caller may read (totals count those). */
  getSessionBrokerSnapshot(readable?: (session: SessionReadSubject) => boolean): unknown;
  getDeliverySnapshot(): unknown;
  getRouteSnapshot(): unknown;
  getRemoteSnapshot(): unknown;
  getHealthSnapshot(): unknown;
  getAccountsSnapshot(): Promise<unknown>;
  getSettingsSnapshot(): unknown;
  getSecuritySettingsReport(): unknown;
  getContinuitySnapshot(): unknown;
  getWorktreeSnapshot(): unknown;
  getIntelligenceSnapshot(): unknown;
  getLocalAuthSnapshot(): unknown;
  listPanels(): readonly unknown[];
  openPanel(panelId: string, pane: 'top' | 'bottom'): boolean;
  getRuntimeStore(): IntegrationRuntimeStoreLike | null;
}

export interface ChannelAccountRegistryLike {
  listAccounts(): Promise<unknown[]>;
}

export interface ProviderRuntimeSnapshotServiceLike {
  listSnapshots(): Promise<readonly unknown[]>;
  getSnapshot(providerId: string): Promise<unknown | null>;
  getUsageSnapshot(providerId: string): Promise<unknown | null>;
}

/** A provenance link on a memory record, as carried on the wire. */
export interface MemoryProvenanceLinkInput {
  readonly kind: string;
  readonly ref: string;
  readonly label?: string | undefined;
}

/** The add-record body, structurally compatible with the platform's MemoryAddOptions. */
export interface MemoryRecordAddInput {
  /** A caller-generated record id; a resend with the same id and record returns the stored row. */
  readonly id?: string | undefined;
  readonly cls: string;
  readonly summary: string;
  readonly scope?: string | undefined;
  /** The project (its resolved folder) a "this project" record is for; absent, the person's own. */
  readonly project?: string | undefined;
  readonly detail?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly provenance?: readonly MemoryProvenanceLinkInput[] | undefined;
  readonly review?: {
    readonly state?: string | undefined;
    readonly confidence?: number | undefined;
    readonly reviewedBy?: string | undefined;
    readonly staleReason?: string | undefined;
  } | undefined;
  /** Who wrote it: set by the route from the authenticated caller (`memoryAuthorOf`), never read from the body. */
  readonly author?: MemoryRecordAuthorLike | undefined;
}

/** The search filter body, structurally compatible with the platform's MemorySearchFilter. */
export interface MemoryRecordSearchFilterInput {
  readonly scope?: string | undefined;
  /** The asking project (its resolved folder): only its records and the person's own. */
  readonly project?: string | undefined;
  /**
   * Every project's records: the owner's explicit choice in their place's project chooser ("Every project"), refused from
   * anyone else. Without it and without a project, only the records that belong to no project.
   */
  readonly everyProject?: boolean | undefined;
  /** Only the records that belong to no project (the person's own, given everywhere). Set by the daemon, never read from a body. */
  readonly projectless?: boolean | undefined;
  readonly cls?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly query?: string | undefined;
  readonly semantic?: boolean | undefined;
  readonly since?: number | undefined;
  readonly reviewState?: string | readonly string[] | undefined;
  readonly minConfidence?: number | undefined;
  readonly provenanceKinds?: readonly string[] | undefined;
  readonly staleOnly?: boolean | undefined;
  readonly limit?: number | undefined;
}

/** The review-update body, structurally compatible with the platform's MemoryReviewPatch. */
export interface MemoryRecordReviewInput {
  readonly state?: string | undefined;
  readonly confidence?: number | undefined;
  readonly reviewedBy?: string | undefined;
  readonly staleReason?: string | undefined;
}

/**
 * The editable-field update body (scope/summary/detail/tags + the temporal
 * validity window), NOT a review update. For validFrom/validUntil, an omitted
 * field leaves the bound unchanged, a number sets it, and `null` clears it, so a
 * proposal that changes only the window can be applied.
 */
export interface MemoryRecordUpdateInput {
  /** The record's class; the store checks it as it checks a new record's. */
  readonly cls?: string | undefined;
  readonly scope?: string | undefined;
  /** The project a record made "this project" is for (its resolved folder). */
  readonly project?: string | undefined;
  readonly summary?: string | undefined;
  readonly detail?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly validFrom?: number | null | undefined;
  readonly validUntil?: number | null | undefined;
  /** Who makes the change: set by the route from the authenticated caller, never read from the body. */
  readonly by?: MemoryRecordAuthorLike | undefined;
}

/** The link-create body, the source id comes from the path, target + relation from the body. */
export interface MemoryLinkInput {
  readonly toId: string;
  readonly relation: string;
}

/** The import body, a { bundle } envelope. The bundle is passed through loosely to the store. */
export interface MemoryBundleInput {
  readonly bundle: {
    readonly records: readonly unknown[];
    readonly links?: readonly unknown[] | undefined;
    readonly [key: string]: unknown;
  };
}

/**
 * The memory subsystem the daemon exposes to its routes. The concrete platform
 * `MemoryRegistry` satisfies this structurally (method params are compared
 * bivariantly, exactly as `reviewQueue`'s `scope?: string` already binds to the
 * registry's `scope?: MemoryScope`). The route layer stays decoupled from the platform
 * store types, it hands loose bodies in and serializes whatever comes back.
 */
export interface MemoryRegistryLike {
  doctor(): Promise<unknown>;
  vectorStats(): unknown;
  rebuildVectorsAsync(): Promise<unknown>;
  reviewQueue(limit?: number, scope?: string): Promise<unknown[]>;
  add(opts: MemoryRecordAddInput): Promise<unknown>;
  /**
   * Search honoring the recall-honesty contract; returns the honest envelope the
   * route serializes verbatim. `filter`/`options` are optional so the concrete
   * MemoryRegistry (whose defaults make BOTH params optional) binds bivariantly,
   * exactly as `reviewQueue`'s optional params already do.
   */
  honestSearch(filter?: MemoryRecordSearchFilterInput, options?: { readonly recall?: boolean | undefined }): Promise<unknown>;
  get(id: string): unknown | null;
  review(id: string, patch: MemoryRecordReviewInput): unknown | null;
  delete(id: string): boolean;
  // ── Full-detach catalog (1.2.0) ─────────────────────────────────────────────
  /** Literal search / bulk read. Serves both records.list and getAll (empty filter). */
  search(filter?: MemoryRecordSearchFilterInput): Promise<unknown[]>;
  /** Scored semantic search, returns MemorySemanticSearchResult[] the route wraps as { results }. */
  searchSemantic(filter?: MemoryRecordSearchFilterInput): Promise<unknown[]>;
  /** Edit scope/summary/detail/tags. Returns the updated record or null when the id is unknown. */
  update(id: string, patch: MemoryRecordUpdateInput): unknown | null;
  /** Resolves once the last update, review or delete is on disk; rejects with why when it was not saved. */
  saved(): Promise<void>;
  /** Relate two records. Returns the link or null when either id is unknown. */
  link(fromId: string, toId: string, relation: string): Promise<unknown | null>;
  /** All links touching a record. */
  linksFor(id: string): unknown[];
  /** Export a no-loss bundle for the given filter. */
  exportBundle(filter?: MemoryRecordSearchFilterInput): unknown;
  /**
   * Import a bundle (id-keyed union, no overwrite). Returns the import result. `importedBy`: who loaded it, the author
   * of every record it adds, whatever the file says.
   */
  importBundle(bundle: unknown, options?: undefined, intoProject?: string, importedBy?: MemoryRecordAuthorLike): Promise<unknown>;
}

export interface MemoryEmbeddingRegistryLike {
  setDefaultProvider(providerId: string): void;
}

export interface UserAuthManagerLike {
  addUser(username: string, password: string, roles: readonly string[], scopes?: readonly string[]): unknown;
  /** A narrower scope list for the user, or `null` for its role's default set. */
  setUserScopes(username: string, scopes: readonly string[] | null): unknown;
  deleteUser(username: string): boolean;
  /** `by`: who asks; the owner's own account is refused unless it is the owner in person. */
  rotatePassword(username: string, password: string, by?: { readonly ownerHimself: boolean }): void;
  revokeSession(sessionId: string): boolean;
  clearBootstrapCredentialFile(): boolean;
}

/** The memory-consolidation scheduler slice the receipts route reads (RuntimeServices.memoryConsolidationScheduler satisfies it structurally). */
export interface MemoryConsolidationSchedulerLike {
  listReceipts(): readonly unknown[];
  /** The proposals still waiting for a person, from the memory store (they outlive the run that raised them). */
  listProposals?(): readonly unknown[];
}

export interface DaemonIntegrationRouteContext {
  readonly channelPlugins: ChannelAccountRegistryLike;
  readonly integrationHelpers: IntegrationHelperServiceLike | null;
  /**
   * The control-plane listener as bound right now, or null while none is
   * bound. Present on a daemon: the health snapshot then reports this listener
   * instead of the settings. Absent: the settings are reported as they are.
   */
  readonly servingListener?: (() => { readonly host: string; readonly port: number; readonly scheme: 'http' | 'https' } | null) | undefined;
  readonly memoryEmbeddingRegistry: MemoryEmbeddingRegistryLike;
  readonly memoryRegistry: MemoryRegistryLike;
  /**
   * The project a folder is in, as the memory store keys "this project" records (memory-project.ts). A memory read
   * whose call names a project (`x-goodvibes-project`) is that project's and the person's own records only.
   */
  readonly memoryProjectOf?: ((folder: string) => string | undefined) | undefined;
  /**
   * Why the caller of `req` may not name `folder` as its project (the one project check, workspace/caller-project.ts:
   * a device or a member who is not the owner names only a project given to it), or undefined when it may. A memory read
   * naming a project it may not name is refused, nothing read.
   */
  readonly callerProjectRefusal?: ((req: Request, folder: string) => string | undefined) | undefined;
  /**
   * Whether the request is the owner in person (the one definition, method-owner-decision.ts `ownerHimself`): only the owner may
   * read every project's memory at once (`everyProject`). Absent: nobody may.
   */
  readonly ownerHimself?: ((req: Request) => boolean) | undefined;
  /**
   * Whether the request makes an act only the owner makes (method-owner-decision.ts `makesOwnerOnlyAct`: the owner in
   * person, or the owner's own verified command line, `do`): only such a request changes the owner's own password. Absent: read
   * as `ownerHimself`.
   */
  readonly makesOwnerOnlyAct?: ((req: Request) => boolean) | undefined;
  /** Optional: absent on embedders without the consolidation scheduler, the receipts route answers 501 honestly. */
  readonly memoryConsolidation?: MemoryConsolidationSchedulerLike | null | undefined;
  readonly parseJsonBody: (req: Request) => Promise<JsonRecord | Response>;
  readonly providerRuntime: ProviderRuntimeSnapshotServiceLike;
  readonly requireAdmin: (req: Request) => Response | null;
  /**
   * The credential's own identity and grant. A memory review is recorded under
   * it, never under a name the body claims, and a task row's text is shown only
   * to a caller holding read:transcripts. Absent: reviews carry no reviewer and
   * task rows are served whole.
   */
  readonly resolveAuthenticatedPrincipal?: ((req: Request) => Pick<RequestPrincipal, 'principalId' | 'admin' | 'scopeSet'> | null) | undefined;
  /** Which sessions `GET /api/sessions` lists to the caller. Absent: all of them. */
  readonly mayReadSession?: SessionReadPolicy | undefined;
  readonly userAuth: UserAuthManagerLike;
  /**
   * Who writes a memory record over these routes, from the credential the daemon authenticated (never a body field):
   * the owner in person (their own press from one of their terminal programs), their model (a terminal program's own call), or
   * someone else, named. Absent: every write is someone else's.
   */
  readonly memoryAuthorOf?: ((req: Request) => MemoryRecordAuthorLike) | undefined;
  /** Whether the caller registered a session: a session a caller names is kept as a record's origin only then. */
  readonly mayNameSession?: ((req: Request, sessionId: string) => boolean) | undefined;
}

/** Who wrote a memory record (the platform's state/memory-author.ts MemoryAuthor, without its acceptance). */
export interface MemoryRecordAuthorLike {
  readonly kind: 'owner' | 'owner-model' | 'other';
  readonly who?: string | undefined;
  /** Someone else's record: the principal the daemon authenticated for it (never a body's); it changes its own records. */
  readonly madeBy?: string | undefined;
}
