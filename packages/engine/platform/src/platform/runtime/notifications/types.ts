/**
 * Notification system types. Every routed notification is kept in the
 * notification history; the routing decision chooses only how loudly it is
 * shown: on screen now (a toast), or in the history alone.
 */

/** Severity level of a notification. Controls routing priority. */
export type NotificationLevel = 'critical' | 'warning' | 'info' | 'debug';

/**
 * How loudly a routed notification is shown. Both are kept in the history.
 * - `toast`  , also shown on screen now
 * - `history`, kept in the history only (read later with /notifications)
 */
export type NotificationPresence = 'toast' | 'history';

/**
 * Per-domain verbosity setting.
 * - `minimal`, only critical notifications toast
 * - `normal` , warnings and critical notifications toast
 * - `verbose`, info notifications also toast
 */
export type DomainVerbosity = 'minimal' | 'normal' | 'verbose';

/**
 * Typed reason codes for routing decisions.
 *
 * These codes appear in RoutingDecision.reasonCode and provide a machine-
 * readable explanation of why a notification was suppressed or redirected.
 *
 * - `allowed`               , notification was not suppressed (delivered normally)
 * - `quiet_while_typing`    , suppressed because the user is actively typing
 * - `batch_window_collapsed`, one more of the same notification inside its collapse window, past the number shown
 * - `domain_verbosity_low`  , domain verbosity set below the notification level
 */
export type RoutingReasonCode =
  | 'allowed'
  | 'quiet_while_typing'
  | 'batch_window_collapsed'
  | 'domain_verbosity_low';

/**
 * Semantic tag classifying a notification's operational role.
 *
 * Used by the collapse policy to distinguish high-signal
 * events from operational churn:
 * - `operational`, routine progress / heartbeat events (most suppressible)
 * - `milestone`  , meaningful completion or state-change events
 * - `alert`      , user-attention-required events (least suppressible)
 */
export type NotificationTag = 'operational' | 'milestone' | 'alert';

/** An action that can be triggered when the user interacts with a notification. */
export interface NotificationAction {
  /** Human-readable label (e.g. "Jump to panel"). */
  label: string;
  /** The type of action to perform. */
  type: 'jump_to_panel' | 'dismiss' | 'custom';
  /** Panel ID to focus when type is `jump_to_panel`. */
  panelId?: string | undefined;
  /** Arbitrary payload for `custom` action types. */
  payload?: Record<string, unknown> | undefined;
}

/** A single notification to be routed and potentially displayed. */
export interface Notification {
  /** Unique identifier for this notification. */
  id: string;
  /**
   * Domain that produced this notification (e.g. 'tools', 'agents',
   * 'session', 'git'). Used for per-domain verbosity and routing policy.
   */
  domain: string;
  /** Severity level, determines base routing target. */
  level: NotificationLevel;
  /** Short human-readable title. */
  title: string;
  /** Optional extended body text. */
  body?: string | undefined;
  /** Unix timestamp in milliseconds when the notification was created. */
  timestamp: number;
  /** The view this notification is about, opened from its history entry. */
  panelId?: string | undefined;
  /** Optional action (e.g. jump to panel) presented alongside the notification. */
  action?: NotificationAction | undefined;
  /**
   * Optional semantic tag classifying the notification's operational role.
   * When absent, the notification is treated as `operational` by default.
   */
  tag?: NotificationTag | undefined;
}

/**
 * The result of routing a single notification: how loudly it is shown, and
 * the collapse group it belongs to.
 */
export interface RoutingDecision {
  /** Whether it is shown on screen now or only kept in the history. */
  presence: NotificationPresence;
  /**
   * The collapse group: every notification with the same domain, level and
   * title inside one collapse window. Consumers keep one entry per group with
   * a running count. Absent for a notification that never collapses
   * (critical, milestone, alert).
   */
  batchKey?: string | undefined;
  /**
   * When set, this notification was held off the screen (it is still kept in
   * the history). The string names the reason (e.g. 'quiet_while_typing').
   */
  suppressed?: string | undefined;
  /**
   * Structured reason code for this routing decision.
   * Always present; reflects the final policy that determined the outcome.
   */
  reasonCode: RoutingReasonCode;
}

/** A notification paired with its routing decision. */
export interface RoutedNotification {
  /** The original notification. */
  notification: Notification;
  /** The routing decision applied to it. */
  decision: RoutingDecision;
}

/** Per-domain routing configuration. */
export interface DomainConfig {
  /** Verbosity level controlling how aggressively noise is suppressed. */
  verbosity: DomainVerbosity;
}
