import { ConfigurationError } from '@goodvibes/engine/errors';

export interface NodeRuntimeBoundaryStatus {
  readonly nodeLike: boolean;
  readonly runtimeName: string;
  readonly nodeVersion?: string | undefined;
  readonly hasProcess: boolean;
  readonly hasFilesystemAssumption: boolean;
}

export interface NodeRuntimeBoundaryOptions {
  readonly feature?: string | undefined;
  readonly entrypoint?: string | undefined;
}

type RuntimeGlobal = typeof globalThis & {
  readonly process?: {
    readonly versions?: {
      readonly node?: string | undefined;
    };
    readonly release?: {
      readonly name?: string | undefined;
    };
  };
};

export function getNodeRuntimeBoundaryStatus(
  runtime: RuntimeGlobal = globalThis as RuntimeGlobal,
): NodeRuntimeBoundaryStatus {
  const processRef = runtime.process;
  const nodeVersion = processRef?.versions?.node;
  const runtimeName = processRef?.release?.name ?? (nodeVersion ? 'node' : 'unknown');
  // Bun also reports versions.node and release.name 'node', and counts as Node-like on
  // purpose: the daemon and terminal run on it. What this refuses is a browser, worker,
  // Expo or React Native global, which has no such process.
  const nodeLike = typeof nodeVersion === 'string' && nodeVersion.trim().length > 0 && runtimeName === 'node';
  return {
    nodeLike,
    runtimeName,
    ...(nodeVersion ? { nodeVersion } : {}),
    hasProcess: typeof processRef === 'object' && processRef !== null,
    // Every Node-like runtime here has a filesystem; the field is kept separate so a runtime without one can say so.
    hasFilesystemAssumption: nodeLike,
  };
}

export function isNodeLikeRuntime(runtime?: RuntimeGlobal): boolean {
  return getNodeRuntimeBoundaryStatus(runtime).nodeLike;
}

export function assertNodeLikeRuntime(options: NodeRuntimeBoundaryOptions = {}): void {
  const status = getNodeRuntimeBoundaryStatus();
  if (status.nodeLike) return;
  const feature = options.feature?.trim() || 'This GoodVibes platform capability';
  const entrypoint = options.entrypoint?.trim();
  throw new ConfigurationError(
    entrypoint
      ? `${feature} requires a Node-like runtime. Import ${entrypoint} only from daemon, TUI, or server-side code.`
      : `${feature} requires a Node-like runtime. Use a client-safe platform entrypoint for browser, worker, Expo, or React Native code.`,
  );
}
