/** How stdio MCP servers start: as host processes, or each inside its own bubblewrap boundary. */
export type SandboxMcpIsolationMode = 'disabled' | 'contained';
/** What a sandbox session runs its processes through. */
export type SandboxResolvedBackend = 'bubblewrap' | 'host';

export interface SandboxConfigSnapshot {
  readonly mcpIsolation: SandboxMcpIsolationMode;
}

export interface SandboxHostStatus {
  readonly platform: NodeJS.Platform;
  readonly runningInWsl: boolean;
  readonly windows: boolean;
  /** Whether this host can run a process inside a boundary (bubblewrap works here). */
  readonly secureSandboxReady: boolean;
  readonly recommendedBackend: SandboxResolvedBackend;
  readonly warnings: readonly string[];
}

export interface SandboxProfile {
  readonly id: 'command' | 'mcp-server';
  readonly label: string;
  readonly kind: SandboxSessionKind;
  /** Whether processes in the boundary share the host network. */
  readonly network: 'disabled' | 'enabled';
  readonly notes: readonly string[];
}

export interface SandboxPreset {
  readonly id: 'contained' | 'host-mcp';
  readonly label: string;
  readonly summary: string;
  readonly config: SandboxConfigSnapshot;
  readonly notes: readonly string[];
}

export interface SandboxReview {
  readonly config: SandboxConfigSnapshot;
  readonly host: SandboxHostStatus;
  readonly profiles: readonly SandboxProfile[];
  readonly backendProbe?: SandboxBackendProbe | undefined;
}

export interface SandboxProbe {
  readonly version: 1;
  readonly checkedAt: number;
  readonly host: string;
  readonly currentBackend: string;
  readonly mcpIsolation: string;
  readonly secureSandboxReady: boolean;
  readonly recommendedCommand: string;
}

export interface SandboxBundle {
  readonly version: 1;
  readonly exportedAt: number;
  readonly review: {
    readonly reviewText: string;
    readonly recommendationText: string;
    readonly profilesText: string;
  };
}

export type SandboxSessionKind = 'command' | 'mcp';
export type SandboxSessionState = 'running' | 'stopped' | 'planned' | 'failed';

export interface SandboxBackendAvailability {
  readonly id: SandboxResolvedBackend;
  readonly available: boolean;
  readonly detail: string;
}

export interface SandboxBackendProbe {
  readonly resolvedBackend: SandboxResolvedBackend;
  readonly backends: readonly SandboxBackendAvailability[];
  readonly warnings: readonly string[];
}

/**
 * How a session's processes start. With `bubblewrap` each process runs in its
 * own boundary: the workspace (and `writableExtras`) writable, system files
 * read-only, $HOME and /tmp private, its own process namespace, and the host
 * network only when `network` is `enabled`. `host` runs the process directly.
 */
export interface SandboxLaunchPlan {
  readonly backend: SandboxResolvedBackend;
  readonly bwrapPath?: string | undefined;
  readonly workspaceRoot: string;
  readonly writableExtras: readonly string[];
  readonly network: 'disabled' | 'enabled';
  readonly summary: string;
}

export interface SandboxSession {
  readonly id: string;
  readonly profileId: SandboxProfile['id'];
  readonly kind: SandboxSessionKind;
  readonly label: string;
  readonly startedAt: number;
  readonly state: SandboxSessionState;
  readonly backend: SandboxResolvedBackend;
  readonly launchPlan?: SandboxLaunchPlan | undefined;
  readonly startupStatus?: 'verified' | 'planned' | 'failed' | undefined;
  readonly startupDetail?: string | undefined;
  readonly lastRunAt?: number | undefined;
  readonly lastCommandSummary?: string | undefined;
  readonly lastExitStatus?: number | null | undefined;
  readonly lastStdoutPreview?: string | undefined;
  readonly lastStderrPreview?: string | undefined;
  readonly executionCount?: number | undefined;
  readonly notes: readonly string[];
}

export interface SandboxSessionArtifact {
  readonly version: 1;
  readonly exportedAt: number;
  readonly session: SandboxSession;
  readonly reviewText: string;
}

export interface ProfileBundleEntry {
  readonly name: string;
  readonly timestamp: number;
  readonly data: import('../../profiles/manager.js').ProfileData;
}

export interface ProfileSyncBundle {
  readonly version: 1;
  readonly exportedAt: number;
  readonly activeProfile?: string | undefined;
  readonly profiles: readonly ProfileBundleEntry[];
}

export interface ManagedSettingsBundle {
  readonly version: 1;
  readonly exportedAt: number;
  readonly profileName: string;
  readonly settings: Record<string, unknown>;
}
