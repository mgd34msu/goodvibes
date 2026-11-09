import { createSettingsValueHelpers } from '@goodvibes-jev/engine/terminal-shell/renderer/settings-value-helpers';
import { SHARED_CATEGORY_INFO } from '@goodvibes-jev/engine/terminal-shell/renderer/settings-metadata';
import { SHARED_SETTING_LABELS } from '@goodvibes-jev/engine/terminal-shell/renderer/settings-metadata';
import { SHARED_CATEGORY_LABELS } from '@goodvibes-jev/engine/terminal-shell/renderer/settings-metadata';
export { inferSubscriptionRouteReason } from '@goodvibes-jev/engine/terminal-shell/settings-subscriptions';
/**
 * Pure formatting, label, and color helpers for renderSettingsModal.
 * Extracted from settings-modal.ts to keep the renderer under the 800-line
 * architecture cap. No layout logic lives here.
 */

import type { SettingEntry, SettingsCategory } from '../input/settings-modal-types.ts';
import { SETTINGS_CATEGORIES } from '../input/settings-modal-types.ts';
import { isSecretConfigKey, isSecretReferenceValue } from '../config/secret-config.ts';
import './theme.ts';

export const CATEGORY_INFO: Record<SettingsCategory, string> = {
  display: SHARED_CATEGORY_INFO['display'],
  ui: 'Controls where operational messages render and whether voice surfaces are enabled. These settings change visibility, not provider behavior.',
  provider: SHARED_CATEGORY_INFO['provider'],
  pricing:
    'Manual model prices (USD per 1M tokens, keyed provider:model). Your price wins over provider-served and catalog prices in every cost display, immediately.',
  update:
    'Self-update posture: whether the daemon checks hourly and updates at an idle moment, the release source it checks, and the check cadence. Clients update at launch; every swap keeps the previous binary for one-command rollback.',
  subscriptions: SHARED_CATEGORY_INFO['subscriptions'],
  behavior: SHARED_CATEGORY_INFO['behavior'],
  storage: 'Local storage posture, including secret storage policy and maximum artifact size for knowledge/home graph/document ingestion.',
  atRest:
    'Data-at-rest policy for the on-disk transcript journal and execution ledger: whether secret/credential patterns are redacted at write time, and the age/size caps that trigger pruning.',
  permissions: SHARED_CATEGORY_INFO['permissions'],
  orchestration: 'Agent orchestration limits and recursion controls.',
  contract:
    'Contract execution: commit policy, quality-gate timeout, acceptance stakes, correction limits, concurrency, isolation, and transport recovery bounds.',
  judgment:
    'Judgment service endpoint, API key source, model version, and per-attempt timeout. Empty endpoint and model settings use the platform environment fallbacks; key source selects where the key is read, never the key itself.',
  planner:
    "How /workstream decomposes a goal into work items: agent-driven decomposition (with heuristic fallback) or the forced heuristic path, plus the planning agent's turn, token, and wall-clock bounds.",
  wrfc: 'Work-review-fix-cycle thresholds, retry limits, and automatic commit behavior.',
  helper: SHARED_CATEGORY_INFO['helper'],
  tts: SHARED_CATEGORY_INFO['tts'],
  voice:
    'Two independent voice capabilities. Local engines (voice.local.*): the STT and TTS engine, binary, and model-path for whisper.cpp/faster-whisper and Piper/Kokoro; all empty by default, configurable-not-configured, nothing auto-downloads, and an unconfigured machine reports honestly (never an error); once set, "Local engines" appears in the TTS provider picker beside elevenlabs, with no billing dimension. Wake-word detection (voice.wake.*, rendered as its own unit below): listening continuously for a spoken wake phrase and handing the utterance that follows to speech-to-text; off by default, because holding a microphone open is meant to be an explicit act. It is live on this terminal: enabling it starts a recorder subprocess (voice.wake.captureCommand), scores every frame with the pinned classifier through a WASM runtime, plays voice.wake.activationSound at a confirmed wake, shows a persistent footer row per voice.wake.indicator, and sends what follows to the same speech-to-text call: into the composer, or submitted outright when voice.wake.autoSubmit is on. The same capture path backs push-to-talk voice input (Alt+V by default), which always lands in the composer. voice.wake.noiseSuppression: speex runs here, the filter travels with the platform, so there is nothing to install for it, and voice.wake.vadThreshold above 0 screens frames with the pinned speech gate once provisioning has fetched it, refusing to start before that rather than scoring frames it claims to be screening. The model is already on this machine: installing goodvibes downloads and checksum-verifies it, and a running daemon retries at boot if the install could not reach the network, so switching this on normally needs no setup step. Switching it on never downloads anything itself; a host whose artifacts are missing or fail verification says which and names /voice wake setup rather than pretending to listen. Its published recall figures are measured on synthesised speech only, so no human recording of the phrase is behind them.',
  service: 'Background service posture: enabled state, autostart, restart behavior, service name, platform, and logs.',
  daemon:
    'Local session daemon. It hosts the shared session broker and companion chat so a session started here is visible and steerable from other surfaces. On by default, bound to loopback (127.0.0.1) only.',
  controlPlane: 'Daemon control-plane settings for local admin/API access.',
  httpListener: 'HTTP listener settings for webhook and integration ingress.',
  web: 'Browser surface settings for the local or network web UI.',
  batch: 'Batch execution settings, including local vs Cloudflare queue behavior.',
  automation: SHARED_CATEGORY_INFO['automation'],
  checkin:
    'Proactive check-in: on a cadence, a briefing is judged and you are contacted only when something warrants it. Off by default; every run, scheduled or manual, leaves a receipt (see /checkin) recording whether it stayed quiet, delivered a message, or was skipped.',
  occasions:
    'Proactive occasions and plans: dated, usually-recurring things that need an action (birthdays, anniversaries) and dated ranges that need only to be known about (a vacation). On by default. Lead time before a date, active hours nudges are allowed to arrive in, the nudge channel (empty makes it pull-only through /occasions), cadence while a window is open and the daily final stretch before it closes, whether an away plan moves a nudge earlier, whether a confirmed occasion mirrors to the calendar and whether a mirrored one suppresses its own nudge, how many questions the gift interview asks, how many years of gift history it keeps, and how often the sweep pass runs. The nudge itself never names the date; only how soon.',
  hostedSessions:
    "Sessions whose conversation loop runs INSIDE the daemon instead of this terminal, so the work does not end when the window that started it closes. What happens when the last client leaves is the detach policy: the shipped default is `kill`, exactly what closing a client has always done, and `survive` is the opt-in that leaves the session idle and reattachable. A session created with /hosted new --survive or --kill overrides the setting for itself. The remaining rows bound the capability: how many hosted sessions may run at once, how many messages one keeps, and how long a terminated session's record (with the reason it ended) is retained before it is retired.",
  watchers:
    "File/process watcher heartbeat, polling, and recovery-window behavior, plus the trigger family (watchers.triggers.*, rendered as its own unit): stream watchers that regex-filter and batch a long-lived command's output, model-free condition checks running a probe/extract/rule pipeline with no LLM in the loop, and one-shot on-exit triggers that fire exactly one payload when a launched command terminates. The trigger family is off by default, a trigger supervises real processes with nobody watching, and its rows tune the backoff ladder, the strike breaker, retention bounds, batching, and process caps.",
  runtime: 'Runtime guardrails such as companion chat limiter and event bus listener caps.',
  telemetry: SHARED_CATEGORY_INFO['telemetry'],
  cache: SHARED_CATEGORY_INFO['cache'],
  diagnostics:
    'Post-edit diagnostics: whether the shell runs language diagnostics on a file after the model edits or writes it, surfacing new problems inline.',
  mcp: SHARED_CATEGORY_INFO['mcp'],
  sandbox:
    'Isolation strategy for REPL, MCP, Windows, and QEMU-backed execution. Use these settings to separate risky tools from the host shell.',
  surfaces:
    'External app surfaces such as Slack, Discord, ntfy, Home Assistant, Telegram, webhooks, chat bridges, and messaging providers.',
  device:
    'Posture for using a PAIRED phone as a tool: its cameras, its screen, its location, its clipboard, and a small set of device effects. Every row here changes behaviour, and every change applies to the next request without a restart. device.capabilities.mode is the master switch: off stops every capability request reaching any paired device (nothing is dispatched and nobody is asked), ask-every-time asks on every single request and never consults or offers a durable grant, and honor-grants (stock) asks the first time and every time after unless you chose "always allow" for that one capability on that one phone. allowAlwaysOffer decides which capabilities may offer that durable grant at all: every-capability (stock), standard-only (the elevated ones: front camera, screen capture, precise location, clipboard read; keep asking and an "always" answer is honoured for that one request only), or never. requestTimeoutSeconds is the deadline on three things at once: how long the phone has to answer, the deadline written into the request the phone receives, and how long the confirmation prompt itself stays open. device.location.precision gates the street-level fix (coarse-only refuses it and still serves approximate; ask-precise serves it but never remembers it), and device.clipboard.readMode gates reading the clipboard the same way; putting text ON the clipboard is a different capability and is unaffected. Captures from the camera and the screen are kept for capture.retentionHours and capped at capture.maxArtifacts, whichever bites first; housekeeping runs at every start and then every capture.sweepIntervalMinutes, deleting expired grants and captures and recording what it removed and why. A grant lasts grants.expiryDays and is never honoured past it, one phone holds at most grants.maxPerNode grants (the oldest are reaped past the cap), and the ledger of grants given, used, revoked and expired is kept for grants.auditRetentionDays. device.nodes.maxPaired is enforced at the moment a device pairs: at the cap a NEW device is refused with a message naming the setting, the cap and how many are already paired, while a phone that is already in the list simply supersedes its own record and keeps working. Lowering the cap below the number already paired unpairs no one; existing devices keep working and only the next new pairing is refused; a device moving off the legacy shared token to its own is exempt so it cannot be stranded. A nonsensical value anywhere here (zero, negative, not a number, an enum value that is not on the list) is read as the stock value rather than passed through, so a broken setting can neither lock you out of your own daemon nor widen the posture.',
  conversationGate:
    'What a message arriving from one of those channels does. By default it gets a conversational answer, and work is proposed and waits for your agreement rather than starting on its own; you can instead confirm every run, or restore the old behavior where a message starts work immediately. Also how long a pending proposal stays answerable and how many can wait at once. This governs messages from channels only; what you type here always runs, and schedules and triggers were authorized when created.',
  cloudflare:
    'Optional Cloudflare control plane, batch queue, Worker, Tunnel, Access, DNS, KV, Durable Objects, Secrets Store, and R2 settings.',
  release: 'Release-channel preference.',
  power:
    'Host sleep ownership. Keep-awake holds the host awake (the always-visible "sleep disabled" chip is the safety mechanism; no timer, no AC-only option); automatic inhibition keeps the host awake while real work runs, with an honest hard cap on that work hold.',
  memory:
    'Memory provenance surfacing. Whether turns that drew on your standing memories show a small "used N memories" chip with a drill-in listing them. Off by default: when off, nothing is rendered and no context is added.',
  danger: 'High-impact switches for daemon and HTTP listener behavior. These are operational overrides, not normal preferences.',
  tools: SHARED_CATEGORY_INFO['tools'],
  network: 'Combined network view for daemon control-plane, HTTP listener, browser web surface, and general outbound network settings.',
  fetch:
    'Fetch response sanitization and host trust tiers for the fetch tool: sanitize mode plus default trusted/blocked host lists. Gated by the Fetch Response Sanitization feature.',
  agents:
    'Sub-agent context-window awareness and per-turn passive knowledge/code injection: token budget, relevance floor, code-chunk limit, and the compaction threshold. Gated by the agent context/injection features.',
  security:
    'API token scope and rotation auditing: rotation cadence, warning lead time, and whether overdue/over-scoped tokens are blocked or only reported. Gated by the Token Scope and Rotation Audit feature.',
  integrations:
    'Integration delivery reliability (Slack/Discord/webhook): retry counts, backoff bounds, dead-letter queue size, and SLO enforcement. Gated by the Integration Delivery SLO feature.',
  connections:
    'Whether mail and calendar are actually usable right now. Each row is answered by asking the daemon that owns the connection, not by reading config here, so a row says ready only when a real request succeeded.',
  policy:
    'Policy-as-code bundle loading: where the startup policy bundle is loaded from and its file path. Gated by the Policy-as-Code feature.',
  notifications:
    'Notification router burst-suppression tuning: burst window, threshold, and cooldown. Gated by the Adaptive Notification Suppression feature.',
  relay:
    'Outbound zero-knowledge relay reachability, for reaching this daemon from outside the LAN without opening an inbound port. Off by default: relay.enabled is the switch. The relay operator sees only ciphertext and connection metadata; self-host your own relay for full control.',
  learning:
    'Idle-time memory consolidation: merging duplicate standing memory records and decaying/archiving stale ones. Off by default; nothing runs until enabled.',
  payments:
    'Payment card on file for daemon-initiated purchases: card number, expiry, CVV, cardholder name, billing and shipping address, and whether the CVV is stored or requested at purchase time. Card fields are entered through /payments card (concealed input) and are secret-tier; never rendered in plaintext.',
  email:
    "The daemon's own mailbox connection; IMAP and SMTP hosts, ports and security, the mailbox and drafts folders, and the username. Password fields hold secret-store references, never values; /google connects a Gmail-backed setup in one action.",
  calendar:
    'Calendar connections the daemon reads and writes: the Google or Microsoft OAuth client for CalDAV-free access, or a read-only ICS URL. Secret fields hold secret-store references, never values.',
  google:
    'The Google OAuth connection record: project id, publishing status, and the refresh-token reference the mail and calendar services share. Established by /google in one action; a dead grant is diagnosed in plain words there.',
  profile:
    "What the platform knows about you: your name, how to reach you, where you are, how you like answers written, the people and places you mention, kept as one Markdown file at daemon scope that you can open and edit by hand at any time; your edits win and are never rewritten. These rows decide whether it is loaded at all, whether the assistant records facts it learns from things you say directly to it, whether it tells you in one line each time it does, whether the harmless part (how you are addressed, your city, your timezone, your formatting preferences, your style) is put in the model's context so it stops guessing, whether using a private detail such as your address is announced in the reply, whether settings left unset read their value from the profile, and where the file lives. Everything private: your name, contact details, home address, billing and shipping details, quiet hours, and the People, Places, Work and Notes sections, is never put in context in bulk and is reachable only by a named lookup that is disclosed when it happens. Run /profile to read the whole thing, /profile where <field> to see the surface, date and your exact words behind any recorded line, and /profile forget <field> to delete one.",
};

export const CATEGORY_LABELS: Record<(typeof SETTINGS_CATEGORIES)[number], string> = {
  display: SHARED_CATEGORY_LABELS['display'],
  ui: SHARED_CATEGORY_LABELS['ui'],
  provider: SHARED_CATEGORY_LABELS['provider'],
  pricing: 'Pricing',
  update: 'Updates',
  subscriptions: SHARED_CATEGORY_LABELS['subscriptions'],
  behavior: SHARED_CATEGORY_LABELS['behavior'],
  storage: SHARED_CATEGORY_LABELS['storage'],
  atRest: 'Data at Rest',
  permissions: SHARED_CATEGORY_LABELS['permissions'],
  orchestration: SHARED_CATEGORY_LABELS['orchestration'],
  planner: SHARED_CATEGORY_LABELS['planner'],
  contract: SHARED_CATEGORY_LABELS['contract'],
  judgment: SHARED_CATEGORY_LABELS['judgment'],
  wrfc: 'WRFC',
  helper: SHARED_CATEGORY_LABELS['helper'],
  tts: SHARED_CATEGORY_LABELS['tts'],
  voice: 'Voice (local engines)',
  service: SHARED_CATEGORY_LABELS['service'],
  daemon: SHARED_CATEGORY_LABELS['daemon'],
  controlPlane: SHARED_CATEGORY_LABELS['controlPlane'],
  httpListener: SHARED_CATEGORY_LABELS['httpListener'],
  web: SHARED_CATEGORY_LABELS['web'],
  batch: SHARED_CATEGORY_LABELS['batch'],
  automation: SHARED_CATEGORY_LABELS['automation'],
  checkin: SHARED_CATEGORY_LABELS['checkin'],
  occasions: 'Occasions & Plans',
  hostedSessions: 'Hosted Sessions',
  watchers: SHARED_CATEGORY_LABELS['watchers'],
  runtime: SHARED_CATEGORY_LABELS['runtime'],
  telemetry: SHARED_CATEGORY_LABELS['telemetry'],
  cache: SHARED_CATEGORY_LABELS['cache'],
  diagnostics: SHARED_CATEGORY_LABELS['diagnostics'],
  mcp: SHARED_CATEGORY_LABELS['mcp'],
  sandbox: SHARED_CATEGORY_LABELS['sandbox'],
  surfaces: 'Surfaces',
  device: 'Paired Devices',
  conversationGate: SHARED_CATEGORY_LABELS['conversationGate'],
  cloudflare: SHARED_CATEGORY_LABELS['cloudflare'],
  release: 'Release',
  power: 'Power',
  memory: 'Memory',
  email: SHARED_CATEGORY_LABELS['email'],
  calendar: SHARED_CATEGORY_LABELS['calendar'],
  google: SHARED_CATEGORY_LABELS['google'],
  danger: 'Danger',
  tools: SHARED_CATEGORY_LABELS['tools'],
  network: SHARED_CATEGORY_LABELS['network'],
  relay: SHARED_CATEGORY_LABELS['relay'],
  learning: 'Learning',
  fetch: SHARED_CATEGORY_LABELS['fetch'],
  agents: 'Agents & Context',
  security: 'Token Security',
  integrations: 'Integration Delivery',
  connections: 'Connections',
  policy: 'Policy-as-Code',
  notifications: SHARED_CATEGORY_LABELS['notifications'],
  payments: SHARED_CATEGORY_LABELS['payments'],
  profile: 'Owner Profile',
};

const SETTING_LABELS: Partial<Record<string, string>> = {
  'ui.systemMessages': SHARED_SETTING_LABELS['ui.systemMessages'],
  'ui.operationalMessages': SHARED_SETTING_LABELS['ui.operationalMessages'],
  'ui.wrfcMessages': 'WRFC Message Target',
  'ui.voiceEnabled': 'Always Speak',
  'behavior.autoCompactThreshold': SHARED_SETTING_LABELS['behavior.autoCompactThreshold'],
  'behavior.staleContextWarnings': SHARED_SETTING_LABELS['behavior.staleContextWarnings'],
  // Blocked-too-long escalation: a fleet node waiting on a human gets a device
  // push once the grace elapses (regardless of an attached surface), then bounded
  // reminders. Real numeric option shapes come from the platform schema's ranges.
  'notifications.blockedEscalationGraceMs': 'Blocked-Too-Long Grace (ms)',
  'notifications.blockedEscalationFollowUpMs': 'Blocked Reminder Interval (ms)',
  'notifications.blockedEscalationMaxFollowUps': 'Blocked Reminder Limit',
  'behavior.returnContextMode': SHARED_SETTING_LABELS['behavior.returnContextMode'],
  'behavior.guidanceMode': SHARED_SETTING_LABELS['behavior.guidanceMode'],
  'storage.secretPolicy': SHARED_SETTING_LABELS['storage.secretPolicy'],
  'permissions.mode': 'Permission Mode',
  'permissions.backgroundAgents': 'Background Agents',
  'diagnostics.postEdit': 'Post-Edit Diagnostics',
  'sandbox.vmBackend': 'Sandbox Backend',
  'sandbox.qemuBinary': 'QEMU Binary',
  'sandbox.qemuImagePath': 'QEMU Image',
  'sandbox.qemuExecWrapper': 'QEMU Wrapper',
  'sandbox.replJavaScriptCommand': 'REPL JS Command',
  'tools.llmProvider': SHARED_SETTING_LABELS['tools.llmProvider'],
  'tools.llmModel': SHARED_SETTING_LABELS['tools.llmModel'],
  'tools.autoHeal': SHARED_SETTING_LABELS['tools.autoHeal'],
  'tools.defaultTokenBudget': SHARED_SETTING_LABELS['tools.defaultTokenBudget'],
  'tools.hooksFile': SHARED_SETTING_LABELS['tools.hooksFile'],
  'helper.enabled': SHARED_SETTING_LABELS['helper.enabled'],
  'helper.globalProvider': SHARED_SETTING_LABELS['helper.globalProvider'],
  'helper.globalModel': SHARED_SETTING_LABELS['helper.globalModel'],
  // Control Plane
  'controlPlane.enabled': 'CP Enabled',
  'controlPlane.hostMode': 'CP Host Mode',
  'controlPlane.host': 'CP Host',
  'controlPlane.port': 'CP Port',
  'controlPlane.publicBaseUrl': 'CP Public Base URL',
  'controlPlane.streamMode': 'CP Stream Mode',
  'controlPlane.allowRemote': 'CP Allow Remote',
  'controlPlane.trustProxy': 'CP Trust Proxy',
  'controlPlane.tls.mode': 'CP TLS Mode',
  'controlPlane.tls.certFile': 'CP TLS Cert',
  'controlPlane.tls.keyFile': 'CP TLS Key',
  // HTTP Listener
  'httpListener.hostMode': 'HTTP Host Mode',
  'httpListener.host': 'HTTP Host',
  'httpListener.port': 'HTTP Port',
  'httpListener.trustProxy': 'HTTP Trust Proxy',
  'httpListener.tls.mode': 'HTTP TLS Mode',
  'httpListener.tls.certFile': 'HTTP TLS Cert',
  // Web Server
  'web.enabled': 'Web Enabled',
  'web.hostMode': 'Web Host Mode',
  'web.host': 'Web Host',
  'web.port': 'Web Port',
  'web.publicBaseUrl': 'Web Public Base URL',
  'web.staticAssetsDir': 'Web Static Assets Dir',
  'surfaces.ntfy.enabled': SHARED_SETTING_LABELS['surfaces.ntfy.enabled'],
  'surfaces.ntfy.baseUrl': SHARED_SETTING_LABELS['surfaces.ntfy.baseUrl'],
  'surfaces.ntfy.topic': SHARED_SETTING_LABELS['surfaces.ntfy.topic'],
  'surfaces.ntfy.chatTopic': SHARED_SETTING_LABELS['surfaces.ntfy.chatTopic'],
  'surfaces.ntfy.agentTopic': SHARED_SETTING_LABELS['surfaces.ntfy.agentTopic'],
  'surfaces.ntfy.remoteTopic': 'ntfy Daemon-Only Remote Topic',
  'surfaces.ntfy.token': SHARED_SETTING_LABELS['surfaces.ntfy.token'],
  'surfaces.ntfy.defaultPriority': SHARED_SETTING_LABELS['surfaces.ntfy.defaultPriority'],
  'surfaces.homeassistant.enabled': 'Home Assistant Enabled',
  'surfaces.homeassistant.instanceUrl': 'Home Assistant URL',
  'surfaces.homeassistant.accessToken': 'Home Assistant Access Token',
  'surfaces.homeassistant.webhookSecret': 'Home Assistant Webhook Secret',
  'surfaces.homeassistant.defaultConversationId': 'Home Assistant Conversation ID',
  'surfaces.homeassistant.remoteSessionTtlMs': 'Home Assistant Remote Session TTL',
  'surfaces.homeassistant.deviceId': 'Home Assistant Device ID',
  'surfaces.homeassistant.deviceName': 'Home Assistant Device Name',
  'surfaces.homeassistant.eventType': 'Home Assistant Event Type',
};

export const { formatValue, valueColor, getSettingLabel, describeUiRouting } = createSettingsValueHelpers<SettingEntry>({
  richValues: true,
  featureLabels: true,
  isSecretKey: isSecretConfigKey,
  isSecretReference: isSecretReferenceValue,
  labels: SETTING_LABELS,
  panelDescription: 'render inline in conversation (older setting value)',
  bothDescription: 'render inline in conversation',
});
