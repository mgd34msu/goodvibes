import { SHARED_SETTING_ENUM_DESCRIPTIONS } from '@goodvibes-jev/engine/terminal-shell/renderer/settings-metadata';
import { SHARED_CATEGORY_INFO } from '@goodvibes-jev/engine/terminal-shell/renderer/settings-metadata';
import { buildMcpContext } from '@goodvibes-jev/engine/terminal-shell/renderer/mcp-trust-context';
/**
 * settings-modal-context.ts, the documentation the settings modal shows for
 * the selected row: category purposes, enum value meanings, and the facts and
 * explanations for settings, features, MCP servers and subscriptions. Pure
 * text builders; settings-modal.ts lays them out with the surface kit.
 */

import { GATE_PRESETS } from '@goodvibes-jev/engine/platform/platform/gate';
import '@goodvibes-jev/engine/platform/platform/runtime/operations';
import type { SettingsModal, SettingEntry, FlagEntry, SubscriptionEntry, SettingsCategory } from '../input/settings-modal.ts';
import { describeUiRouting, formatValue, getSettingLabel } from './settings-modal-helpers.ts';
import { isSecretConfigKey } from '../config/secret-config.ts';
import '../input/concealed-input.ts';
import { CVV_PROMPT_TRADEOFF_WARNING } from '@goodvibes-jev/engine/platform/platform/payments';
import { formatProviderAuthRouteId } from '../provider-auth-route-display.ts';

export const CATEGORY_INFO: Record<SettingsCategory, string> = {
  display: SHARED_CATEGORY_INFO['display'],
  ui: 'Controls where operational messages render and whether voice interaction is enabled. These settings change visibility, not provider behavior.',
  provider: SHARED_CATEGORY_INFO['provider'],
  judgment:
    'Jev judgment endpoint, credential source, model, and request timeout. Empty endpoint or model settings use the configured TypeSafe environment defaults.',
  subscriptions: SHARED_CATEGORY_INFO['subscriptions'],
  behavior: SHARED_CATEGORY_INFO['behavior'],
  profile:
    'What the platform knows about you: your name, how to reach you, where you live, where to ship things, how you like answers written, and the people and places you have mentioned. It is one Markdown file the daemon keeps, and you can open and edit it by hand at any time, your edits win. These settings decide whether it is kept at all, whether the Agent records what you tell it about yourself as you say it, whether it says in its reply what it recorded, whether the harmless part (your city, timezone, units, reply style) rides along on a turn so it stops guessing, and where the file lives. Facts learned from mail, web pages, documents, or messages from anyone else are refused outright and no setting here changes that.',
  storage:
    'Local storage posture, including secret storage policy and maximum artifact size for Agent Knowledge, artifacts, and document ingestion.',
  permissions: SHARED_CATEGORY_INFO['permissions'],
  diagnostics:
    'Post-edit diagnostics behavior: whether a successful file write/edit gets cheap, in-process syntax diagnostics appended to the tool result so the model sees a broken edit immediately. Syntax-level only, not type-checking.',
  helper: SHARED_CATEGORY_INFO['helper'],
  tts: SHARED_CATEGORY_INFO['tts'],
  voice:
    'Two independent voice capabilities. Free local voice engines (voice.local.*) as the peer beside the premium provider route above: every key ships empty and an unset engine reports an honest unconfigured status rather than an error; the managed setup downloads and verifies the engines, points these keys at them, and proves the result by speaking a phrase and reading it back. Wake-word detection (voice.wake.*, rendered as its own unit below): listening continuously for a spoken wake phrase and handing the utterance that follows to speech-to-text. Off by default, and delivery to THIS surface is off by default too (voice.wake.surfaces.agent), because two terminal surfaces both acting on one spoken utterance is a confusing default, but it is LIVE here when you turn both on: a recorder subprocess (voice.wake.captureCommand) feeds the pinned classifier through a WASM runtime, voice.wake.activationSound plays at a confirmed wake, a persistent listening row shows in the footer per voice.wake.indicator, and what you say next goes to speech-to-text and lands in the conversation input, or is sent straight away with voice.wake.autoSubmit. Both of the rows that used to refuse now run: voice.wake.noiseSuppression "speex" applies the SpeexDSP denoiser (carried in the package, nothing to install) between the microphone and everything downstream, and voice.wake.vadThreshold above 0 screens frames through a pinned speech gate so non-speech never reaches the classifier; that one needs the gate downloaded, and above 0 without it the detector refuses to start rather than claiming to screen frames it is not screening. Turning detection on fetches and verifies the models if they are missing, and says what it fetched; a detector that still cannot run says so rather than pretending to listen. Its published recall figures are measured on synthesised speech only, so no human recording of the phrase is behind them.',
  automation: SHARED_CATEGORY_INFO['automation'],
  checkin:
    'Proactive check-in: off by default. When enabled, on a cadence the Agent assembles a compact briefing of current state, asks the model to judge whether anything warrants contacting you, and delivers a message through the configured channel only when the judgment says yes. Every run, delivered, quiet, skipped for quiet hours, or errored, leaves a receipt (checkin.receipts.list) so this automatic behavior stays accountable even when it decides to say nothing.',
  occasions:
    'Dates in your life that need an action, a birthday, an anniversary, and dated ranges that do not, like a trip. You declare them as ordinary prose lines under "Important dates" and "Plans" in your own profile file, and nothing machine-written is ever put there. The daemon raises one on its own before it matters, remembers whether you said yes, no or later, and asks fresh next year because birthdays recur. A reminder names the occasion and the person and never the date: "in ten days" is the date with arithmetic applied, so how close it is arrives as a word. You choose at capture time whether an occasion is one to sort a gift for, one to just remember, or neither; that is never guessed, because a cheerful "you will probably want to sort something" against the wrong date would be genuinely bad. Nothing unresolved is dropped: silence only moves when it is next raised.',
  service: 'GoodVibes daemon service posture and restart/autostart preferences.',
  controlPlane: 'Control-plane endpoint, stream, remote access, and TLS settings used by daemon-backed operator routes.',
  httpListener: 'HTTP listener binding, trust proxy, and TLS settings for inbound companion/channel routes.',
  danger:
    'Toggles that expose this machine to inbound traffic. Shown rather than hidden so you can see what is on; changing one from the Agent needs your explicit confirmation first.',
  web: 'Web companion surface settings including host, port, public URL, and static asset path.',
  watchers: 'Polling watcher and heartbeat behavior for runtime recovery and periodic checks.',
  network: 'Outbound TLS and remote fetch network policy.',
  relay:
    "Outbound zero-knowledge relay reachability for the connected GoodVibes daemon: an end-to-end encrypted tunnel (ECDH P-256 -> HKDF -> AES-256-GCM) that terminates INSIDE the daemon, so the relay operator only ever sees ciphertext plus connection metadata (who paired with whom, byte counts, timing), never plaintext requests, responses, or the operator token. relay.enabled is the relay-connect feature's switch. These are the connected daemon's own settings (imported here, not live-shared): changing them in Agent does not itself start or stop the daemon's relay registration.",
  cluster:
    "Which of your machines reads each inbound surface, for operators running more than one goodvibes daemon on a network. Exactly one machine is elected per surface, one reads the work Slack account, one reads the mailbox, so a message is picked up once rather than answered twice by every copy of you. cluster.enabled is the switch and it is off by default. The group keys, rotation window, beacon and roster intervals decide which machines count as yours and how often they re-prove it. These are the connected daemon's own settings: the Agent composes no inbound consumer of its own and never takes part in an election, but it owns the daemon's configuration, so changes here reach the runtime that acts on them.",
  orchestration:
    'Visible agent orchestration limits: sub-agent recursion and its max depth. The active-agent ceiling itself lives under Fleet (fleet.maxSize).',
  fleet:
    'Maximum fleet size, the one ceiling on agents this runtime is responsible for: native spawned agents, ACP-hosted agents, and elastic fix-task agents all count against it. Renamed from orchestration.maxActiveAgents.',
  planner:
    'Planning-decomposition agent limits: decomposition strategy, max turns, token ceiling, and wall-clock timeout before falling back to the deterministic heuristic path.',
  daemon:
    'Whether this installation connects to a companion daemon, and its timezone. The daemon always runs as its own separate process; this surface never runs one internally.',
  runtime: 'Runtime service limits and event bus settings.',
  sandbox: 'Isolation settings for REPL, MCP, and VM-backed sessions.',
  batch: 'Batch queue backend, limits, and provider batching behavior.',
  cloudflare: 'Cloudflare worker, tunnel, queue, storage, and token-reference settings.',
  contract: 'Contract acceptance gates, evidence checks, correction limits, concurrency, isolation, and commit preferences.',
  telemetry: SHARED_CATEGORY_INFO['telemetry'],
  cache: SHARED_CATEGORY_INFO['cache'],
  mcp: SHARED_CATEGORY_INFO['mcp'],
  surfaces: 'Messaging and notification channel accounts such as Slack, Discord, ntfy, Telegram, chat bridges, and delivery providers.',
  conversationGate:
    'What a message arriving from a channel does. By default it gets a conversational answer, and work is proposed and waits for your agreement rather than starting on its own; you can instead confirm every run, or restore the old behavior where a message starts work immediately. Also how long a pending proposal stays answerable and how many can wait at once. Schedules, triggers, and on-exit chains were authorized when created and are never gated here.',
  hostedSessions:
    'Conversations whose loop runs inside the connected host rather than inside this process. Whether a message arriving on a channel is handed over to be hosted there (off by default, so a message is answered here and stops when this process stops); what happens to a hosted conversation when the last surface watching it leaves (it ends, which is what closing a client has always done, or it stays alive and reattachable); how many may run at once; how much of a transcript survives a restart; and how long an ended one is still listable with the reason it ended.',
  email:
    "The daemon's own mailbox connection, IMAP and SMTP hosts, ports and security, the mailbox and drafts folders, and the username. Password fields hold references into the secret store, never the values themselves.",
  calendar:
    'Calendar connections the daemon reads and writes: the Google or Microsoft OAuth client, or the private ICS feed address for read-only access. Secret fields hold references into the secret store, never the values themselves.',
  google:
    "The Google OAuth connection record: the Cloud project id, the consent screen's publishing status, and the refresh-token reference the mail and calendar services share.",
  release: 'Update-channel preference.',
  update:
    'Connected-host self-update posture: whether the daemon checks for, verifies, and swaps in new releases on its own, how often it checks, and where releases are resolved from. The daemon applies these itself; the Agent only edits the shared keys.',
  pricing:
    'Manual model prices (USD per 1M tokens, keyed provider:model). A manual price outranks registration, provider-served, and catalog prices in the one pricing resolver; unknown models stay honestly unpriced.',
  power:
    'Sleep ownership: the owner keep-awake toggle (independent of work state, survives surfaces closing, the always-visible status line note is the safety mechanism, not a timer), automatic inhibition while real work runs (on by default), and the hard cap in minutes on that automatic inhibitor so a wedged hold cannot pin the host awake forever.',
  tools: SHARED_CATEGORY_INFO['tools'],
  flags:
    'Every optional capability grouped by its settings domain: each feature is switched through a first-class domain settings key (shown per row), with its full description and related settings under the cursor.',
  atRest: 'Data-at-rest protection: whether stored content is redacted, and retention limits by age and total size.',
  learning:
    "Idle-time memory consolidation: dedupe merges, confidence decay of never-referenced records, and review proposals. On by default; runs on the platform's daemon-side scheduler (an idle trigger plus a slow schedule fallback), and every run with something to report leaves a visible notice.",
  agents:
    'Agent runtime tuning: the context-window fraction that triggers sub-agent conversation compaction, and the token budget, relevance floor, and code-chunk limit for per-turn passive knowledge/code injection.',
  notifications:
    'Adaptive notification-burst suppression: the observation window, trip threshold, and cooldown that collapse a rapid run of same-domain notifications to panel-only. Critical/milestone/alert notifications are always exempt.',
  policy:
    'Policy-as-code bundle loading: where the policy registry loads its initial bundle from at startup, and the file path when loading from disk. A loaded bundle is a candidate subject to the divergence gate before promotion.',
  fetch:
    'Fetch-tool response sanitization: the default sanitize mode, and default trusted/blocked host lists layered under any per-call overrides. The built-in SSRF-risk block applies independently.',
  security:
    'Credential rotation-audit defaults: how often tokens should rotate, how much lead time a warning gets, and whether overdue or over-scoped tokens are blocked from use rather than only reported.',
  integrations:
    'Integration delivery reliability: retry ceiling and exponential-backoff bounds for Slack/Discord/webhook delivery, dead-letter queue size, and whether dead-letter events log at error level.',
  device:
    'How a paired phone\'s camera, screen, location, clipboard, and device commands are reached. Every capture and effect asks the person first; "always allow" writes one durable grant for that capability on that phone, revocable in the grants surface. Also sets how long a picture the phone took is kept before it is deleted (24 hours by default), how often housekeeping sweeps, and how long a grant lasts before it expires.',
  memory:
    "This runtime's own memory-pressure defense: the RSS budget (0 = auto: min of 25% of system RAM and 4096 MB), the elevated/high/critical tier thresholds that shed caches and pause deferrable background jobs, the leak tripwire (sustained growth rate that triggers a graceful exit with a receipt), and the absolute hard-limit backstop as a percent of the kill ceiling. Live state under /health memory.",
  payments:
    "The payment capability's budgets, shipping preference, CVV handling, and the two decision windows: a veto window for in-budget purchases (silence proceeds) and an approval window for above-budget ones (silence denies). The daemon holds the card and executes every purchase; these settings configure it. Card number, expiry and CVV are never entered here, they live in the daemon secret store, write-only across every wire.",
};

export const ENUM_VALUE_DESCRIPTIONS: Record<string, Record<string, string>> = {
  'behavior.hitlMode': {
    quiet: SHARED_SETTING_ENUM_DESCRIPTIONS['behavior.hitlMode']['quiet'],
    balanced: SHARED_SETTING_ENUM_DESCRIPTIONS['behavior.hitlMode']['balanced'],
    operator: 'Surface more operational detail for users actively supervising agents, tools, connected-host posture, and automation.',
  },
  'behavior.guidanceMode': {
    off: SHARED_SETTING_ENUM_DESCRIPTIONS['behavior.guidanceMode']['off'],
    minimal: SHARED_SETTING_ENUM_DESCRIPTIONS['behavior.guidanceMode']['minimal'],
    guided: SHARED_SETTING_ENUM_DESCRIPTIONS['behavior.guidanceMode']['guided'],
  },
  'permissions.mode': Object.fromEntries(Object.values(GATE_PRESETS).map((preset) => [preset.mode, preset.summary])),
  'permissions.backgroundAgents': {
    inherit:
      'Background/subagent tool calls consult the same session permission mode as the foreground turn, Safe owner asks the owner about dangerous actions; Safe Jev resolves them autonomously; YOLO has no execution-safety denials.',
    'allow-all': 'Background/subagent tool calls are exempt from the session permission mode and auto-approve regardless of it.',
  },
  'diagnostics.postEdit': {
    on: 'After a successful file write/edit, append cheap, in-process syntax diagnostics (errors only) to the tool result. Syntax-level only, not type-checking.',
    off: 'Never append post-edit diagnostics to write/edit tool results.',
  },
  'storage.secretPolicy': {
    preferred_secure: SHARED_SETTING_ENUM_DESCRIPTIONS['storage.secretPolicy']['preferred_secure'],
    require_secure: SHARED_SETTING_ENUM_DESCRIPTIONS['storage.secretPolicy']['require_secure'],
    plaintext_allowed: SHARED_SETTING_ENUM_DESCRIPTIONS['storage.secretPolicy']['plaintext_allowed'],
  },
  'ui.systemMessages': {
    panel: 'Show system messages in the activity feed only.',
    conversation: SHARED_SETTING_ENUM_DESCRIPTIONS['ui.systemMessages']['conversation'],
    both: 'Show system messages in both the activity feed and the transcript.',
  },
  'ui.operationalMessages': {
    panel: 'Show operational messages in the activity feed only.',
    conversation: SHARED_SETTING_ENUM_DESCRIPTIONS['ui.operationalMessages']['conversation'],
    both: 'Show operational messages in both the activity feed and the transcript.',
  },
  'surfaces.telegram.mode': {
    webhook: 'Receive Telegram updates through externally hosted delivery.',
    polling: 'Poll Telegram for updates from the configured account.',
  },
  'surfaces.whatsapp.provider': {
    'meta-cloud': SHARED_SETTING_ENUM_DESCRIPTIONS['surfaces.whatsapp.provider']['meta-cloud'],
    bridge: 'Use a bridge endpoint URL/token flow instead of direct Meta Cloud API delivery.',
  },
};

export function formatDefaultForEntry(entry: SettingEntry): string {
  return formatDefaultValue(entry.setting.default);
}

function formatSubscriptionRoute(route: SubscriptionEntry['activeRoute'] | SubscriptionEntry['preferredRoute']): string {
  return route ? formatProviderAuthRouteId(route) : 'n/a';
}

function describeFeatureEnablement(entry: FlagEntry): string {
  const { key, kind, enabledValues } = entry.feature.enablement;
  if (kind === 'boolean') return `Switch: ${key} (true/false).`;
  if (kind === 'enum') return `Switch: ${key}, active while set to ${(enabledValues ?? []).join(' or ')}.`;
  return `Always available; its settings (${entry.feature.settings.join(', ')}) govern runtime activation directly.`;
}

function buildFlagContext(entry: FlagEntry | null): string[] {
  if (!entry) return ['Feature Controls', 'No feature control is selected.'];
  return [
    entry.feature.name,
    `ID: ${entry.feature.id}`,
    `Domain: ${entry.feature.domain}`,
    `State: ${entry.state}`,
    `Default: ${entry.feature.defaultEnabled ? 'enabled' : 'disabled'}`,
    `Current value: ${entry.feature.enablement.key} = ${entry.enablementValue}`,
    `Live toggleable: ${entry.feature.restartRequired ? 'no' : 'yes'}`,
    '',
    entry.feature.description,
    '',
    describeFeatureEnablement(entry),
    `Settings: ${entry.feature.settings.join(', ')}`,
    '',
    entry.feature.restartRequired
      ? 'Impact: the domain settings key is saved now and takes effect on the next Agent launch or owning-host reload.'
      : 'Impact: changes to the domain settings key apply immediately through the live settings bridge.',
  ];
}

/** Items in a category (the count beside it in the category list). */
export function categoryItemCount(modal: SettingsModal, category: SettingsCategory): number {
  if (category === 'flags') return modal.flagEntries.length;
  if (category === 'mcp') return modal.mcpEntries.length;
  if (category === 'subscriptions') return modal.subscriptionEntries.length;
  return modal.groups.get(category)?.length ?? 0;
}

/**
 * The documentation lines for the current selection (its name first), then
 * the category's purpose. While searching, the selected result is explained.
 */
export function settingContextLines(modal: SettingsModal): string[] {
  const category = modal.currentCategory;
  const lines: string[] = [];
  if (modal.searchFocused) {
    const selected = modal.getSelected();
    if (selected) lines.push(...buildSettingContext(modal, selected));
    else lines.push('Search', 'No setting matches the search.');
    return lines;
  }
  if (category === 'flags') lines.push(...buildFlagContext(modal.getSelectedFlag()));
  else if (category === 'mcp') lines.push(...buildMcpContext(modal, modal.getSelectedMcp()));
  else if (category === 'subscriptions') lines.push(...buildSubscriptionContext(modal, modal.getSelectedSubscription()));
  else {
    const selected = modal.getSelected();
    if (selected) lines.push(...buildSettingContext(modal, selected));
    else lines.push(category, 'No setting is selected in this category.');
  }
  lines.push('', `Category purpose: ${CATEGORY_INFO[category]}`);
  return lines;
}

import {
  createSettingContext,
  createSubscriptionContext,
  formatDefaultValue,
} from '@goodvibes-jev/engine/terminal-shell/renderer/settings-context';
export const { currentSettingValue, buildSettingContext } = createSettingContext<SettingsModal, SettingEntry>({
  isSecretKey: isSecretConfigKey,
  cursor: '▏',
  formatValue,
  label: getSettingLabel,
  source: (entry) => entry.effectiveSource ?? 'default',
  detail(entry) {
    const lines: string[] = []; // The platform's own wording, not authored here, and never shown against 'stored'.
    if (entry.setting.key === 'payments.cvvHandling' && entry.currentValue === 'prompt') {
      lines.push('', CVV_PROMPT_TRADEOFF_WARNING);
    }

    if (entry.metadataUnavailable) lines.push(`Editing unavailable: ${entry.metadataUnavailable}`);
    else if (entry.locked) lines.push(`Locked: ${entry.lockReason ?? 'This setting is locked by a higher-priority layer.'}`);
    if (entry.conflict) lines.push(`Conflict: inspect with /settings and resolve host-owned sync state in the owning host.`);

    if (entry.setting.key === 'permissions.mode') {
      lines.push('', 'Legacy behavior.autoApprove selects YOLO. Choosing an execution mode replaces that override.');
    }

    return lines;
  },
  enumDescriptions: ENUM_VALUE_DESCRIPTIONS,
  routingKeys: ['ui.systemMessages', 'ui.operationalMessages'],
  describeUiRouting,
  customEditing: (entry) =>
    entry.setting.key === 'display.theme'
      ? 'Editing: Enter opens the theme picker with live preview. Enter saves the selected theme; Esc restores the previous theme.'
      : undefined,
});
const buildSubscriptionContext = createSubscriptionContext<SettingsModal>({
  confirmLogout: (provider) => `Press Enter again to sign out ${provider}. Move selection or close config to cancel.`,
  beginLogout: 'Press Enter to review sign-out for this provider session.',
  login: (provider) => `Open Agent Workspace -> Start and choose Sign in to a provider for ${provider}.`,
  route: formatSubscriptionRoute,
});
