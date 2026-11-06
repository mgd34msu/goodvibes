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
