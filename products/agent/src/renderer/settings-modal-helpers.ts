import { createSettingsValueHelpers } from '@goodvibes-jev/engine/terminal-shell/renderer/settings-value-helpers';
export {
  flagStateColor,
  mcpTrustColor,
  subscriptionStateColor,
} from '@goodvibes-jev/engine/terminal-shell/renderer/settings-value-helpers';
import { SHARED_SETTING_LABELS } from '@goodvibes-jev/engine/terminal-shell/renderer/settings-metadata';
import { SHARED_CATEGORY_LABELS } from '@goodvibes-jev/engine/terminal-shell/renderer/settings-metadata';
export { inferSubscriptionRouteReason } from '@goodvibes-jev/engine/terminal-shell/settings-subscriptions';
/**
 * Pure formatting, label, and color helpers for renderSettingsModal.
 * Extracted from settings-modal.ts to keep the renderer under the 800-line
 * architecture cap. No layout logic lives here.
 */

import type { SettingEntry } from '../input/settings-modal.ts';
import type { SETTINGS_CATEGORIES } from '../input/settings-modal.ts';
import { isSecretConfigKey, isSecretReferenceValue } from '../config/secret-config.ts';
import './theme.ts';

// Row colours come from the active theme: the accent marks modified or active
// values, status tokens mark risk, and neutral values read muted.

export const CATEGORY_LABELS: Record<(typeof SETTINGS_CATEGORIES)[number], string> = {
  display: SHARED_CATEGORY_LABELS['display'],
  ui: SHARED_CATEGORY_LABELS['ui'],
  provider: SHARED_CATEGORY_LABELS['provider'],
  judgment: SHARED_CATEGORY_LABELS['judgment'],
  subscriptions: SHARED_CATEGORY_LABELS['subscriptions'],
  behavior: SHARED_CATEGORY_LABELS['behavior'],
  profile: 'Your Profile',
  occasions: 'Dates and Plans',
  storage: SHARED_CATEGORY_LABELS['storage'],
  permissions: SHARED_CATEGORY_LABELS['permissions'],
  diagnostics: SHARED_CATEGORY_LABELS['diagnostics'],
  helper: SHARED_CATEGORY_LABELS['helper'],
  tts: SHARED_CATEGORY_LABELS['tts'],
  voice: 'Local Voice',
  automation: SHARED_CATEGORY_LABELS['automation'],
  checkin: SHARED_CATEGORY_LABELS['checkin'],
  service: SHARED_CATEGORY_LABELS['service'],
  controlPlane: SHARED_CATEGORY_LABELS['controlPlane'],
  httpListener: SHARED_CATEGORY_LABELS['httpListener'],
  danger: 'Danger Zone',
  web: SHARED_CATEGORY_LABELS['web'],
  watchers: SHARED_CATEGORY_LABELS['watchers'],
  network: SHARED_CATEGORY_LABELS['network'],
  relay: SHARED_CATEGORY_LABELS['relay'],
  cluster: 'Cluster',
  orchestration: SHARED_CATEGORY_LABELS['orchestration'],
  fleet: 'Fleet',
  planner: SHARED_CATEGORY_LABELS['planner'],
  daemon: SHARED_CATEGORY_LABELS['daemon'],
  runtime: SHARED_CATEGORY_LABELS['runtime'],
  sandbox: SHARED_CATEGORY_LABELS['sandbox'],
  batch: SHARED_CATEGORY_LABELS['batch'],
  cloudflare: SHARED_CATEGORY_LABELS['cloudflare'],
  contract: SHARED_CATEGORY_LABELS['contract'],
  telemetry: SHARED_CATEGORY_LABELS['telemetry'],
  cache: SHARED_CATEGORY_LABELS['cache'],
  mcp: SHARED_CATEGORY_LABELS['mcp'],
  surfaces: 'Channels',
  conversationGate: SHARED_CATEGORY_LABELS['conversationGate'],
  hostedSessions: 'Daemon-Hosted Conversations',
  release: 'Update Channel',
  tools: SHARED_CATEGORY_LABELS['tools'],
  flags: 'Feature Controls',
  atRest: 'At-Rest Protection',
  learning: 'Memory Consolidation',
  agents: 'Agent Runtime',
  notifications: SHARED_CATEGORY_LABELS['notifications'],
  policy: 'Policy Bundles',
  fetch: SHARED_CATEGORY_LABELS['fetch'],
  security: 'Token Rotation',
  integrations: 'Delivery Reliability',
  update: 'Daemon Updates',
  pricing: 'Model Pricing',
  power: 'Sleep and Power',
  device: 'Paired Phone Capabilities',
  memory: 'Memory Governance',
  payments: SHARED_CATEGORY_LABELS['payments'],
  email: SHARED_CATEGORY_LABELS['email'],
  calendar: SHARED_CATEGORY_LABELS['calendar'],
  google: SHARED_CATEGORY_LABELS['google'],
};

export const SETTING_LABELS: Partial<Record<string, string>> = {
  'ui.systemMessages': SHARED_SETTING_LABELS['ui.systemMessages'],
  'ui.operationalMessages': SHARED_SETTING_LABELS['ui.operationalMessages'],
  'ui.voiceEnabled': 'Voice Interaction',
  'behavior.autoCompactThreshold': SHARED_SETTING_LABELS['behavior.autoCompactThreshold'],
  'behavior.staleContextWarnings': SHARED_SETTING_LABELS['behavior.staleContextWarnings'],
  'behavior.returnContextMode': SHARED_SETTING_LABELS['behavior.returnContextMode'],
  'behavior.guidanceMode': SHARED_SETTING_LABELS['behavior.guidanceMode'],
  'storage.secretPolicy': SHARED_SETTING_LABELS['storage.secretPolicy'],
  'tools.llmProvider': SHARED_SETTING_LABELS['tools.llmProvider'],
  'tools.llmModel': SHARED_SETTING_LABELS['tools.llmModel'],
  'tools.autoHeal': SHARED_SETTING_LABELS['tools.autoHeal'],
  'tools.defaultTokenBudget': SHARED_SETTING_LABELS['tools.defaultTokenBudget'],
  'tools.hooksFile': SHARED_SETTING_LABELS['tools.hooksFile'],
  'helper.enabled': SHARED_SETTING_LABELS['helper.enabled'],
  'helper.globalProvider': SHARED_SETTING_LABELS['helper.globalProvider'],
  'helper.globalModel': SHARED_SETTING_LABELS['helper.globalModel'],
  'surfaces.ntfy.enabled': SHARED_SETTING_LABELS['surfaces.ntfy.enabled'],
  'surfaces.ntfy.baseUrl': SHARED_SETTING_LABELS['surfaces.ntfy.baseUrl'],
  'surfaces.ntfy.topic': SHARED_SETTING_LABELS['surfaces.ntfy.topic'],
  'surfaces.ntfy.chatTopic': SHARED_SETTING_LABELS['surfaces.ntfy.chatTopic'],
  'surfaces.ntfy.agentTopic': SHARED_SETTING_LABELS['surfaces.ntfy.agentTopic'],
  'surfaces.ntfy.remoteTopic': 'ntfy Runtime-Only Remote Topic',
  'surfaces.ntfy.token': SHARED_SETTING_LABELS['surfaces.ntfy.token'],
  'surfaces.ntfy.defaultPriority': SHARED_SETTING_LABELS['surfaces.ntfy.defaultPriority'],
  // Trigger family (stream watchers, condition checks, on-exit process
  // triggers). These live under the existing Watchers category because their
  // keys are `watchers.triggers.*` and the category is the key's first
  // segment; without labels the rows would render as raw sub-paths like
  // "triggers.backoffLadderMs", which reads as noise next to the plain
  // watchers keys they sit beside.
  'watchers.triggers.enabled': 'Triggers Enabled',
  'watchers.triggers.backoffLadderMs': 'Trigger Retry Ladder',
  'watchers.triggers.breakerStrikes': 'Trigger Breaker Strikes',
  'watchers.triggers.defaultCheckIntervalMs': 'Trigger Check Interval',
  'watchers.triggers.probeTimeoutMs': 'Trigger Probe Timeout',
  'watchers.triggers.maxConcurrentChecks': 'Trigger Check Concurrency',
  'watchers.triggers.observationRingSize': 'Trigger Observation History',
  'watchers.triggers.runHistoryLimit': 'Trigger Run History Limit',
  'watchers.triggers.runHistoryTtlHours': 'Trigger Run History TTL',
  'watchers.triggers.eventLogLimit': 'Trigger Event Log Limit',
  'watchers.triggers.eventLogTtlHours': 'Trigger Event Log TTL',
  'watchers.triggers.sweepIntervalMs': 'Trigger Housekeeping Sweep',
  'watchers.triggers.streamQueueLimit': 'Stream Watcher Queue Limit',
  'watchers.triggers.streamBatchLines': 'Stream Watcher Batch Size',
  'watchers.triggers.streamBatchIntervalMs': 'Stream Watcher Batch Interval',
  'watchers.triggers.onExitMaxDurationMs': 'On-Exit Max Duration',
  'watchers.triggers.onExitStdin': 'On-Exit Standard Input',
  'watchers.triggers.outputTailBytes': 'On-Exit Output Tail',
  'payments.enabled': 'Payments Enabled',
  'payments.defaultCardId': 'Default Card ID',
  'payments.currency': 'Currency',
  'payments.cvvHandling': 'CVV Handling',
  'payments.budget.dailyItem': 'Daily Item Budget',
  'payments.budget.dailyOverage': 'Daily Overage Allowance',
  'payments.budget.perPurchaseCeilingEnabled': 'Per-Purchase Ceiling Enabled',
  'payments.budget.perPurchaseCeiling': 'Per-Purchase Ceiling',
  'payments.budget.overageToleranceEnabled': 'Overage Tolerance Enabled',
  'payments.budget.overageToleranceDailyAllowance': 'Overage Tolerance Daily Allowance',
  'payments.shipping.preferredTier': 'Preferred Shipping Tier',
  'payments.windows.vetoMinutes': 'Veto Window (Minutes)',
  'payments.windows.approvalMinutes': 'Approval Window (Minutes)',
  'payments.notifyChannels': 'Notify Channels',
};

export const { formatValue, valueColor, getSettingLabel, describeUiRouting } = createSettingsValueHelpers<SettingEntry>({
  richValues: false,
  featureLabels: false,
  isSecretKey: isSecretConfigKey,
  isSecretReference: isSecretReferenceValue,
  labels: SETTING_LABELS,
  panelDescription: 'render in the activity feed only',
  bothDescription: 'render in both conversation and the activity feed',
});
