/** Capture the admitted product bindings before any factory runs, then compose once in lifecycle order. */
export function composeTerminalCommandContext<
  Options,
  Shell,
  Session,
  Provider,
  Workspace,
  Platform,
  Extensions,
  Clients,
  Actions extends object,
  Ops,
>(
  options: Options,
  keys: readonly (keyof Options)[],
  factories: {
    readonly shell: (options: Options) => Shell;
    readonly session: (options: Options) => Session;
    readonly provider: (options: Options) => Provider;
    readonly workspace: (options: Options, shell: Shell) => Workspace;
    readonly platform: (options: Options, shell: Shell) => Platform;
    readonly extensions: (options: Options, shell: Shell) => Extensions;
    readonly clients: (options: Options) => Clients;
    readonly actions: (options: Options) => Actions;
    readonly ops: (shell: Shell, options: Options) => Ops;
  },
) {
  const captured = {} as Options;
  for (const key of keys) captured[key] = options[key];
  const shell = factories.shell(captured);
  const session = factories.session(captured);
  const provider = factories.provider(captured);
  const workspace = factories.workspace(captured, shell);
  const platform = factories.platform(captured, shell);
  const extensions = factories.extensions(captured, shell);
  const clients = factories.clients(captured);
  const actions = factories.actions(captured);
  return { session, provider, workspace, platform, ops: factories.ops(shell, captured), extensions, clients, ...actions };
}
export function projectCommandProviderServices<
  Options extends {
    readonly providerRegistry: unknown;
    readonly providerOptimizer?: unknown | undefined;
    readonly favoritesStore?: unknown | undefined;
    readonly benchmarkStore?: unknown | undefined;
  },
>(options: Options) {
  return {
    providerRegistry: options.providerRegistry,
    providerOptimizer: options.providerOptimizer,
    favoritesStore: options.favoritesStore,
    benchmarkStore: options.benchmarkStore,
  } as {
    [Key in 'providerRegistry' | 'providerOptimizer' | 'favoritesStore' | 'benchmarkStore']: Options[Key];
  };
}

export function projectCommandSessionSection<
  Options extends {
    readonly conversation?: unknown | undefined;
    readonly runtime?: unknown | undefined;
    readonly sessionManager?: unknown | undefined;
    readonly sessionMemoryStore?: unknown | undefined;
    readonly sessionLineageTracker?: unknown | undefined;
    readonly changeTracker?: unknown | undefined;
    readonly hydrateSessionUsage?: unknown | undefined;
  },
>(options: Options) {
  return {
    conversationManager: options.conversation,
    runtime: options.runtime,
    sessionManager: options.sessionManager,
    sessionMemoryStore: options.sessionMemoryStore,
    sessionLineageTracker: options.sessionLineageTracker,
    changeTracker: options.changeTracker,
    hydrateSessionUsage: options.hydrateSessionUsage,
  } as {
    conversationManager: Options['conversation'];
    runtime: Options['runtime'];
    sessionManager: Options['sessionManager'];
    sessionMemoryStore: Options['sessionMemoryStore'];
    sessionLineageTracker: Options['sessionLineageTracker'];
    changeTracker: Options['changeTracker'];
    hydrateSessionUsage: Options['hydrateSessionUsage'];
  };
}

export function projectCommandWorkspaceSection<
  Options extends {
    readonly keybindingsManager?: unknown | undefined;
    readonly fileUndoManager?: unknown | undefined;
    readonly profileManager?: unknown | undefined;
    readonly bookmarkManager?: unknown | undefined;
    readonly projectPlanningService?: unknown | undefined;
    readonly projectPlanningProjectId?: unknown | undefined;
    readonly workPlanStore?: unknown | undefined;
  },
>(options: Options) {
  return {
    keybindingsManager: options.keybindingsManager,
    fileUndoManager: options.fileUndoManager,
    profileManager: options.profileManager,
    bookmarkManager: options.bookmarkManager,
    projectPlanningService: options.projectPlanningService,
    projectPlanningProjectId: options.projectPlanningProjectId,
    workPlanStore: options.workPlanStore,
  } as {
    keybindingsManager: Options['keybindingsManager'];
    fileUndoManager: Options['fileUndoManager'];
    profileManager: Options['profileManager'];
    bookmarkManager: Options['bookmarkManager'];
    projectPlanningService: Options['projectPlanningService'];
    projectPlanningProjectId: Options['projectPlanningProjectId'];
    workPlanStore: Options['workPlanStore'];
  };
}

export function projectCommandClientsSection<
  Options extends {
    readonly operatorClient?: unknown | undefined;
    readonly peerClient?: unknown | undefined;
    readonly providerApi?: unknown | undefined;
    readonly hookApi?: unknown | undefined;
    readonly mcpApi?: unknown | undefined;
    readonly opsApi?: unknown | undefined;
    readonly directTransport?: unknown | undefined;
  },
>(options: Options) {
  return {
    operator: options.operatorClient,
    peer: options.peerClient,
    providerApi: options.providerApi,
    hookApi: options.hookApi,
    mcpApi: options.mcpApi,
    opsApi: options.opsApi,
    transport: options.directTransport,
  } as {
    operator: Options['operatorClient'];
    peer: Options['peerClient'];
    providerApi: Options['providerApi'];
    hookApi: Options['hookApi'];
    mcpApi: Options['mcpApi'];
    opsApi: Options['opsApi'];
    transport: Options['directTransport'];
  };
}
