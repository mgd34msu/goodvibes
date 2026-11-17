/**
 * How a system notice is presented: its severity, its Activity category and
 * its transcript category. The writer of a notice states these (B8 `addNotice`
 * levels, the runtime event a line restates, the leading tag table), so no
 * model reads a notice; these are the plain types those facts are stored in.
 */
export type SystemMessageSeverity = 'error' | 'warning' | 'info';
export type SystemMessageActivity = 'status' | 'tool' | 'agent' | 'schedule' | 'delivery' | 'security' | 'system';
export type SystemMessageEvent =
  | 'approval_request'
  | 'approval_resolution'
  | 'task_transition'
  | 'remote_status'
  | 'policy_warning'
  | 'contract_state'
  | 'session_restore'
  | 'diagnostic_notice'
  | 'system_notice';
export interface SystemMessagePresentation {
  readonly provenance?: 'classic';
  readonly activity?: SystemMessageActivity;
  readonly severity?: SystemMessageSeverity;
  readonly event?: SystemMessageEvent;
}
