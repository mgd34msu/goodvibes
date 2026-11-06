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

/** Capture the shared terminal capabilities once; product-only authorities are added explicitly by composition. */
export function projectBootstrapShellCommandOptions<
  Input extends {
    readonly configManager: unknown;
    readonly services: {
      readonly providerRegistry: unknown;
      readonly keybindingsManager: unknown;
      readonly mcpRegistry: unknown;
      readonly voiceProviders: unknown;
      readonly voiceService: unknown;
      readonly artifactStore: unknown;
      readonly shellPaths: unknown;
      readonly surface: unknown;
      readonly fileUndoManager: unknown;
      readonly memoryRegistry: unknown;
      readonly integrationHelpers: unknown;
      readonly automationManager: unknown;
      readonly projectPlanningService: unknown;
      readonly projectPlanningProjectId: unknown;
      readonly workPlanStore: unknown;
      readonly providerOptimizer: unknown;
      readonly pluginManager: unknown;
      readonly hookWorkbench: unknown;
      readonly agentManager: unknown;
      readonly modeManager: unknown;
      readonly sessionManager: unknown;
      readonly profileManager: unknown;
      readonly bookmarkManager: unknown;
      readonly favoritesStore: unknown;
      readonly benchmarkStore: unknown;
      readonly subscriptionManager: unknown;
      readonly secretsManager: unknown;
      readonly serviceRegistry: unknown;
      readonly localUserAuthManager: unknown;
      readonly tokenAuditor: unknown;
      readonly replayEngine: unknown;
      readonly webhookNotifier: unknown;
      readonly sessionMemoryStore: unknown;
      readonly sessionLineageTracker: unknown;
      readonly sessionChangeTracker: unknown;
      readonly planManager: unknown;
      readonly adaptivePlanner: unknown;
      readonly sessionOrchestration: unknown;
      readonly worktreeRegistry: unknown;
      readonly sandboxSessionRegistry: unknown;
      readonly componentHealthMonitor: unknown;
    };
    readonly conversation: unknown;
    readonly runtime: unknown;
    readonly requestRender: unknown;
    readonly toolRegistry: unknown;
    readonly forensicsRegistry: unknown;
    readonly policyRuntimeState: unknown;
    readonly uiServices: { readonly readModels: unknown };
    readonly remoteRuntime: unknown;
    readonly planRuntime: unknown;
    readonly providerApi: unknown;
    readonly directTransport: { readonly operator: unknown; readonly peer: unknown };
    readonly hookApi: unknown;
    readonly mcpApi: unknown;
    readonly opsApi: unknown;
    readonly completeModelSelectionSideEffect: unknown;
    readonly hydrateSessionUsage: unknown;
  },
>(input: Input) {
  return {
    configManager: input.configManager,
    providerRegistry: input.services.providerRegistry,
    conversation: input.conversation,
    runtime: input.runtime,
    requestRender: input.requestRender,
    keybindingsManager: input.services.keybindingsManager,
    toolRegistry: input.toolRegistry,
    mcpRegistry: input.services.mcpRegistry,
    voiceProviderRegistry: input.services.voiceProviders,
    voiceService: input.services.voiceService,
    artifactStore: input.services.artifactStore,
    forensicsRegistry: input.forensicsRegistry,
    policyRuntimeState: input.policyRuntimeState,
    readModels: input.uiServices.readModels,
    shellPaths: input.services.shellPaths,
    surface: input.services.surface,
    remoteRuntime: input.remoteRuntime,
    planRuntime: input.planRuntime,
    fileUndoManager: input.services.fileUndoManager,
    memoryRegistry: input.services.memoryRegistry,
    integrationHelpers: input.services.integrationHelpers,
    automationManager: input.services.automationManager,
    projectPlanningService: input.services.projectPlanningService,
    projectPlanningProjectId: input.services.projectPlanningProjectId,
    workPlanStore: input.services.workPlanStore,
    providerOptimizer: input.services.providerOptimizer,
    pluginManager: input.services.pluginManager,
    hookWorkbench: input.services.hookWorkbench,
    agentManager: input.services.agentManager,
    modeManager: input.services.modeManager,
    sessionManager: input.services.sessionManager,
    profileManager: input.services.profileManager,
    bookmarkManager: input.services.bookmarkManager,
    favoritesStore: input.services.favoritesStore,
    benchmarkStore: input.services.benchmarkStore,
    providerApi: input.providerApi,
    subscriptionManager: input.services.subscriptionManager,
    secretsManager: input.services.secretsManager,
    serviceRegistry: input.services.serviceRegistry,
    localUserAuthManager: input.services.localUserAuthManager,
    tokenAuditor: input.services.tokenAuditor,
    replayEngine: input.services.replayEngine,
    webhookNotifier: input.services.webhookNotifier,
    sessionMemoryStore: input.services.sessionMemoryStore,
    sessionLineageTracker: input.services.sessionLineageTracker,
    changeTracker: input.services.sessionChangeTracker,
    planManager: input.services.planManager,
    adaptivePlanner: input.services.adaptivePlanner,
    sessionOrchestration: input.services.sessionOrchestration,
    operatorClient: input.directTransport.operator,
    peerClient: input.directTransport.peer,
    hookApi: input.hookApi,
    mcpApi: input.mcpApi,
    opsApi: input.opsApi,
    directTransport: input.directTransport,
    worktreeRegistry: input.services.worktreeRegistry,
    sandboxSessionRegistry: input.services.sandboxSessionRegistry,
    completeModelSelectionSideEffect: input.completeModelSelectionSideEffect,
    componentHealthMonitor: input.services.componentHealthMonitor,
    hydrateSessionUsage: input.hydrateSessionUsage,
  } as {
    configManager: Input['configManager'];
    providerRegistry: Input['services']['providerRegistry'];
    conversation: Input['conversation'];
    runtime: Input['runtime'];
    requestRender: Input['requestRender'];
    keybindingsManager: Input['services']['keybindingsManager'];
    toolRegistry: Input['toolRegistry'];
    mcpRegistry: Input['services']['mcpRegistry'];
    voiceProviderRegistry: Input['services']['voiceProviders'];
    voiceService: Input['services']['voiceService'];
    artifactStore: Input['services']['artifactStore'];
    forensicsRegistry: Input['forensicsRegistry'];
    policyRuntimeState: Input['policyRuntimeState'];
    readModels: Input['uiServices']['readModels'];
    shellPaths: Input['services']['shellPaths'];
    surface: Input['services']['surface'];
    remoteRuntime: Input['remoteRuntime'];
    planRuntime: Input['planRuntime'];
    fileUndoManager: Input['services']['fileUndoManager'];
    memoryRegistry: Input['services']['memoryRegistry'];
    integrationHelpers: Input['services']['integrationHelpers'];
    automationManager: Input['services']['automationManager'];
    projectPlanningService: Input['services']['projectPlanningService'];
    projectPlanningProjectId: Input['services']['projectPlanningProjectId'];
    workPlanStore: Input['services']['workPlanStore'];
    providerOptimizer: Input['services']['providerOptimizer'];
    pluginManager: Input['services']['pluginManager'];
    hookWorkbench: Input['services']['hookWorkbench'];
    agentManager: Input['services']['agentManager'];
    modeManager: Input['services']['modeManager'];
    sessionManager: Input['services']['sessionManager'];
    profileManager: Input['services']['profileManager'];
    bookmarkManager: Input['services']['bookmarkManager'];
    favoritesStore: Input['services']['favoritesStore'];
    benchmarkStore: Input['services']['benchmarkStore'];
    providerApi: Input['providerApi'];
    subscriptionManager: Input['services']['subscriptionManager'];
    secretsManager: Input['services']['secretsManager'];
    serviceRegistry: Input['services']['serviceRegistry'];
    localUserAuthManager: Input['services']['localUserAuthManager'];
    tokenAuditor: Input['services']['tokenAuditor'];
    replayEngine: Input['services']['replayEngine'];
    webhookNotifier: Input['services']['webhookNotifier'];
    sessionMemoryStore: Input['services']['sessionMemoryStore'];
    sessionLineageTracker: Input['services']['sessionLineageTracker'];
    changeTracker: Input['services']['sessionChangeTracker'];
    planManager: Input['services']['planManager'];
    adaptivePlanner: Input['services']['adaptivePlanner'];
    sessionOrchestration: Input['services']['sessionOrchestration'];
    operatorClient: Input['directTransport']['operator'];
    peerClient: Input['directTransport']['peer'];
    hookApi: Input['hookApi'];
    mcpApi: Input['mcpApi'];
    opsApi: Input['opsApi'];
    directTransport: Input['directTransport'];
    worktreeRegistry: Input['services']['worktreeRegistry'];
    sandboxSessionRegistry: Input['services']['sandboxSessionRegistry'];
    completeModelSelectionSideEffect: Input['completeModelSelectionSideEffect'];
    componentHealthMonitor: Input['services']['componentHealthMonitor'];
    hydrateSessionUsage: Input['hydrateSessionUsage'];
  };
}

/** Common tool capabilities survive wholesale orchestrator dependency replacement. Private knowledge and surface identity are explicit product ports. */
export function projectAgentToolDependencies<
  Input extends {
    readonly services: {
      readonly contractRunner: unknown;
      readonly permissionManager: unknown;
      readonly sandboxEscalationHandler: unknown;
      readonly onSandboxedRun: unknown;
      readonly agentManager: unknown;
      readonly execPromptAnswerHandler: unknown;
      readonly localhostFetchApproval: unknown;
      readonly workingDirectory: unknown;
      readonly fileUndoManager: unknown;
      readonly modeManager: unknown;
      readonly processManager: unknown;
      readonly agentMessageBus: unknown;
      readonly webSearchService: unknown;
      readonly channelPlugins: unknown;
      readonly remoteRunnerRegistry: unknown;
      readonly archetypeLoader: unknown;
      readonly providerRegistry: unknown;
      readonly providerOptimizer: unknown;
      readonly toolLLM: unknown;
      readonly serviceRegistry: unknown;
      readonly sessionOrchestration: unknown;
      readonly featureFlags: unknown;
      readonly overflowHandler: unknown;
      readonly memoryRegistry: unknown;
      readonly sandboxSessionRegistry: unknown;
      readonly workflow: unknown;
      readonly contextAccountingHolder: unknown;
    };
    readonly fileCache: unknown;
    readonly projectIndex: unknown;
    readonly configManager: unknown;
  },
>(input: Input) {
  return {
    contractRunner: input.services.contractRunner,
    permissionManager: input.services.permissionManager,
    sandboxEscalationHandler: input.services.sandboxEscalationHandler,
    onSandboxedRun: input.services.onSandboxedRun,
    agentManager: input.services.agentManager,
    execPromptAnswerHandler: input.services.execPromptAnswerHandler,
    localhostFetchApproval: input.services.localhostFetchApproval,
    fileCache: input.fileCache,
    projectIndex: input.projectIndex,
    workingDirectory: input.services.workingDirectory,
    fileUndoManager: input.services.fileUndoManager,
    modeManager: input.services.modeManager,
    processManager: input.services.processManager,
    agentMessageBus: input.services.agentMessageBus,
    webSearchService: input.services.webSearchService,
    channelRegistry: input.services.channelPlugins,
    remoteRunnerRegistry: input.services.remoteRunnerRegistry,
    archetypeLoader: input.services.archetypeLoader,
    configManager: input.configManager,
    providerRegistry: input.services.providerRegistry,
    providerOptimizer: input.services.providerOptimizer,
    toolLLM: input.services.toolLLM,
    serviceRegistry: input.services.serviceRegistry,
    sessionOrchestration: input.services.sessionOrchestration,
    featureFlags: input.services.featureFlags,
    overflowHandler: input.services.overflowHandler,
    memoryRegistry: input.services.memoryRegistry,
    sandboxSessionRegistry: input.services.sandboxSessionRegistry,
    workflowServices: input.services.workflow,
    contextAccountingHolder: input.services.contextAccountingHolder,
  } as {
    contractRunner: Input['services']['contractRunner'];
    permissionManager: Input['services']['permissionManager'];
    sandboxEscalationHandler: Input['services']['sandboxEscalationHandler'];
    onSandboxedRun: Input['services']['onSandboxedRun'];
    agentManager: Input['services']['agentManager'];
    execPromptAnswerHandler: Input['services']['execPromptAnswerHandler'];
    localhostFetchApproval: Input['services']['localhostFetchApproval'];
    fileCache: Input['fileCache'];
    projectIndex: Input['projectIndex'];
    workingDirectory: Input['services']['workingDirectory'];
    fileUndoManager: Input['services']['fileUndoManager'];
    modeManager: Input['services']['modeManager'];
    processManager: Input['services']['processManager'];
    agentMessageBus: Input['services']['agentMessageBus'];
    webSearchService: Input['services']['webSearchService'];
    channelRegistry: Input['services']['channelPlugins'];
    remoteRunnerRegistry: Input['services']['remoteRunnerRegistry'];
    archetypeLoader: Input['services']['archetypeLoader'];
    configManager: Input['configManager'];
    providerRegistry: Input['services']['providerRegistry'];
    providerOptimizer: Input['services']['providerOptimizer'];
    toolLLM: Input['services']['toolLLM'];
    serviceRegistry: Input['services']['serviceRegistry'];
    sessionOrchestration: Input['services']['sessionOrchestration'];
    featureFlags: Input['services']['featureFlags'];
    overflowHandler: Input['services']['overflowHandler'];
    memoryRegistry: Input['services']['memoryRegistry'];
    sandboxSessionRegistry: Input['services']['sandboxSessionRegistry'];
    workflowServices: Input['services']['workflow'];
    contextAccountingHolder: Input['services']['contextAccountingHolder'];
  };
}
