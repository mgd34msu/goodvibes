import type { TriggersConfig } from './schema-domain-triggers.js';
/**
 * Daemon-side service config interfaces: notification fan-out, speech output,
 * the automation scheduler, watchers, the OS service integration, and runtime
 * limits. Split out of schema-types.ts so that file stays under its
 * grandfathered line ceiling; re-exported from schema-types.ts so import sites
 * are unchanged.
 */
export interface NotificationsConfig {
  webhookUrls: string[];
  /** Repeats past burstThreshold in one collapse window are counted into one history entry. Default true. */
  adaptiveSuppression: boolean;
  /** Notifications with the same domain, level and title recorded as their own entries per collapse window. */
  burstThreshold: number;
  /** Device-push fan-out for pending approvals. ON by default; a toggle to silence, never a working prerequisite. */
  pushApproval: boolean;
  /** Device-push fan-out for fleet nodes blocked on the operator. ON by default. */
  pushNeedsInput: boolean;
  /** Device-push fan-out for finished tracked runs (task/turn completion). ON by default. */
  pushCompletion: boolean;
  /** Grace (ms) a block waits for a human before a device push escalates past an attached surface. */
  blockedEscalationGraceMs: number;
  /** Interval (ms) between bounded follow-up reminders after the first blocked-too-long escalation. */
  blockedEscalationFollowUpMs: number;
  /** Upper bound on follow-up reminders after the first escalation (0 = escalate once). */
  blockedEscalationMaxFollowUps: number;
}

export interface TtsConfig {
  provider: string;
  voice: string;
  llmProvider: string;
  llmModel: string;
  /** Playback speed multiplier (0.25–4.0); 1.0 = normal speed. */
  speed: number;
}

export interface AutomationConfig {
  enabled: boolean;
  maxConcurrentRuns: number;
  runHistoryLimit: number;
  defaultTimeoutMs: number;
  catchUpWindowMinutes: number;
  failureCooldownMs: number;
  deleteAfterRun: boolean;
}

export interface WatchersConfig {
  enabled: boolean;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  recoveryWindowMinutes: number;
  /** Cadence (ms) for the daemon's recurring CI-watch poll (floor 15s at the poller). */
  ciPollIntervalMs: number;
  /** Trigger supervision (schema-domain-triggers.ts). */
  triggers: TriggersConfig;
}

export interface ServiceConfig {
  enabled: boolean;
  autostart: boolean;
  restartOnFailure: boolean;
  platform: 'auto' | 'systemd' | 'launchd' | 'windows' | 'manual';
  serviceName: string;
  logPath: string;
}

export interface RuntimeConfig {
  companionChat: {
    /** Days after a companion chat closes before its files are deleted; 0 keeps them forever. */
    closedRetentionDays: number;
  };
  companionChatLimiter: {
    perSessionLimit: number;
  };
  eventBus: {
    maxListeners: number;
  };
  /** Most tool calls of one model response run at the same time. Default 8. */
  maxParallelToolCalls: number;
  /** Unified RuntimeTask tracking across subsystems (restart to apply). Default true. */
  unifiedTasks: boolean;
  /** Structured plugin init/teardown lifecycle with health integration (restart to apply). Default true. */
  pluginLifecycle: boolean;
  /** Structured MCP server connect/disconnect lifecycle with health integration (restart to apply). Default true. */
  mcpLifecycle: boolean;
  /**
   * Default per-phase tool-execution budget limits. `enforced` turns hard
   * budget enforcement on; a limit value of 0 means "unlimited" for that
   * dimension; per-call ToolRuntimeContext.budget still overrides.
   */
  toolBudget: {
    enforced: boolean;
    maxMs: number;
    maxTokens: number;
    maxCostUsd: number;
  };
}

/**
 * The daemon process's own configuration, whether it runs, how it is hosted,
 * and where on earth it thinks it is.
 *
 * `timezone` is the platform's only notion of the daemon's location. It is
 * general rather than owned by any one feature: anything that resets on a
 * calendar day reads it, starting with the payment capability's daily budgets.
 * Empty means UTC. See docs/payments.md §4.
 */
export interface DaemonProcessConfig {
  enabled: boolean;         // default: true. ADOPT a session daemon of this surface's own (loopback only)
  timezone: string;         // default: ''. IANA name; empty means UTC
  /**
   * The daemon this surface is connected to. `enabled`: whether this surface
   * may DIAL it, a decision apart from adopting a daemon of its own (`enabled`
   * above), so turning adoption off does not stop inbound-message delivery,
   * rewind registration, the approvals stream or daemon-routed turns.
   * `url`: where this terminal dials its daemon when it was pointed at one
   * (setup's "connect to an existing daemon"). Empty means the daemon on this
   * machine, derived from the control-plane bind settings, which describe only
   * how a local daemon listens.
   */
  connectedHost: { enabled: boolean; url: string };  // default: enabled true, url ''
}
