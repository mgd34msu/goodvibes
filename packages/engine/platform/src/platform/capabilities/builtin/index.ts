/**
 * The capabilities that have moved beside their handlers, with the command
 * each still answers to as a slash command. Home `daemon` ones run in the
 * daemon (routes/capabilities.ts); home `session` ones in the program
 * holding the conversation.
 */
import { entryOfDefinition, type CapabilityEntry } from '../catalog.js';
import type { CapabilityDefinition } from '../types.js';
import { assertWorkFoldersDeclared, workFolderInputsOf } from '../work-folders.js';
import { assertCapabilityAddressesDeclared } from '../../control-plane/record-addresses.js';
import { CONVERSATION_CLEAR, CONVERSATION_COMPACT, CONVERSATION_UNDO } from './conversation.js';
import { CONVERSATION_CONTROLS } from './conversation-controls.js';
import { CODE_DAEMON_CAPABILITIES, CODE_SESSION_CAPABILITIES, codeCommandOf } from './code.js';
import {
  HOOKS_CHAIN, HOOKS_CONTRACTS, HOOKS_DISABLE, HOOKS_ENABLE, HOOKS_EXPORT, HOOKS_IMPORT, HOOKS_INSPECT, HOOKS_RELOAD, HOOKS_REMOVE,
  HOOKS_SCAFFOLD, HOOKS_SIMULATE, HOOKS_TRACE, type HooksCapabilityServices,
} from './hooks.js';
import { KEYS_BIND, KEYS_RESET, KEYS_RESET_ALL } from './keys.js';
import { MEMORY_DAEMON_CAPABILITIES, type MemoryCapabilityServices } from './memory.js';
import { MEMORY_SESSION_CAPABILITIES } from './memory-session.js';
import { KNOWLEDGE_CAPABILITIES, type KnowledgeCapabilityServices } from './knowledge.js';
import { PROFILE_CAPABILITIES } from './profile.js';
import { TEMPLATE_DAEMON_CAPABILITIES, TEMPLATE_SESSION_CAPABILITIES, type TemplateCapabilityServices } from './templates.js';
import { DEEPLINK_INSPECT, DEEPLINK_OPEN } from './deeplink.js';
import { SECRETS_SET, type SecretsCapabilityServices } from './secrets.js';
import type { AgentStoresCapabilityServices } from './agent-stores.js';
import { NOTES_CAPABILITIES } from './notes.js';
import { PERSONAS_CAPABILITIES } from './personas.js';
import { ROUTINES_CAPABILITIES, ROUTINES_START } from './routines.js';
import { PINNED_CAPABILITIES } from './pinned-lines.js';
import { ARTIFACTS_CAPABILITIES } from './artifacts.js';
import { DOCUMENTS_CAPABILITIES } from './documents.js';
import { AGENT_HOMES_CAPABILITIES } from './agent-homes.js';
import { DEVICES_CAPABILITIES, DEVICES_MIGRATE_SHARED } from './devices.js';
import { CALLER_PROJECTS_CAPABILITIES, type CallerProjectsCapabilityServices } from './devices-projects.js';
import { CALLER_SHARED_CAPABILITIES, type CallerSharedCapabilityServices } from './devices-shared.js';
import { NETWORK_SIGN_IN_ACCOUNT } from './network-account.js';
import { DEVICES_SESSION_CAPABILITIES } from './devices-session.js';
import { CLUSTER_CAPABILITIES, type ClusterCapabilityServices } from './cluster.js';
import { NETWORK_SCAN_CAPABILITIES, type NetworkScanCapabilityServices } from './network-scan.js';
import { SETTINGS_SYNC_CAPABILITIES, type SettingsSyncCapabilityServices } from './settings-sync.js';
import { CLOUDFLARE_CAPABILITIES } from './cloudflare.js';
import {
  HOSTED_ATTACH, HOSTED_END, HOSTED_LEAVE, HOSTED_LIST, HOSTED_NEW, HOSTED_SEND, HOSTED_STATUS, SESSION_BRANCHES, SESSION_CURRENT, SESSION_DELETE, SESSION_FORK, SESSION_INFO, SESSION_LIST, SESSION_MERGE_BRANCH,
  SESSION_RENAME, SESSION_RESUME, SESSION_SAVE_SAVED, SESSION_SEARCH, SESSION_SWITCH_BRANCH, SESSION_UPLOAD,
  SESSION_BOOKMARKS, SESSION_COMPOSER, SESSION_EVENTS, SESSION_FIND, SESSION_GROUPS, SESSION_HOTSPOTS, SESSION_NEXT, SESSION_PREV, SESSION_RESTORED,
  SESSION_GRAPH, SESSION_LINK_TASK, SESSION_HAND_OFF, SESSION_ACCEPT, SESSION_WITHDRAW, SESSION_CANCEL,
} from './sessions.js';

import { CALENDAR_HANDLER_CAPABILITIES, CHANNELS_HANDLER_CAPABILITIES, MAIL_CAPABILITIES, MESSAGES_METHOD_CAPABILITIES, type MessagesCapabilityServices } from './messages.js';
import { methodCapabilityEntry, type MethodCapabilityDefinition } from './method-capability.js';
import { AUTOMATION_METHOD_CAPABILITIES } from './automation.js';
import {
  LOCAL_AUTH_REMOVE_FIRST_RUN_FILE, POWER_OFF, POWER_ON, POWER_STATUS, UPDATE_DAEMON, VOICE_SETUP, VOICE_STATUS,
} from './system.js';
// System, Workspaces (workspaces.ts): the folders registered as workspaces, each a daemon method run as the caller.
import { WORKSPACES_CAPABILITIES } from './workspaces.js';
import { CHATS_CAPABILITIES } from './chats.js';
import {
  SYSTEM_QUIT, SYSTEM_STATUS, VERBOSITY_SET, VERBOSITY_SET_DOMAIN, VERBOSITY_SHOW, VOICE_OFF, VOICE_ON, VOICE_REVIEW, VOICE_SPEAK, VOICE_WAKE_AGAIN,
} from './system-session.js';
import { SYSTEM_PROGRAM_CAPABILITIES } from './system-program.js';
import { SYSTEM_SETTINGS_CAPABILITIES } from './system-settings.js';
import { SYSTEM_UPDATE_CAPABILITIES, type SystemUpdatesCapabilityServices } from './system-updates.js';
import { SYSTEM_SETUP_CAPABILITIES } from './system-setup.js';
import { SYSTEM_BUNDLE_CAPABILITIES, type SystemBundleCapabilityServices } from './system-bundles.js';
import { REMOTE_CAPABILITIES_ALL, type RemoteCapabilityServices } from './remote.js';
import { REPLAY_CAPABILITIES } from './replay.js';
import {
  AGENTS_ARCHETYPE, AGENTS_ARCHETYPES, AGENTS_HOST, AGENTS_HOSTABLE, AGENTS_RECIPE, AGENTS_START, AGENTS_START_ARCHETYPE, AGENTS_STOP_BRANCH,
  AGENTS_STOP, AGENTS_STOP_GROUP, AGENTS_TEAM, WORK_BRIEF,
} from './agents.js';
import { MEDIA_COLLECT, type MediaCollectServices } from './media-collect.js';
// Work and agents: task suites (eval.ts), web research (research.ts) and handing coding work on (handed-off.ts).
import { EVAL_CAPABILITIES } from './eval.js';
import { RESEARCH_DAEMON_CAPABILITIES, RESEARCH_SESSION_CAPABILITIES } from './research.js';
import { HANDED_OFF_CAPABILITIES } from './handed-off.js';

/** Your agents' session capabilities (builtin/agents.ts), in their command's order. */
const AGENTS_SESSION_CAPABILITIES = [AGENTS_TEAM, AGENTS_START, AGENTS_RECIPE, AGENTS_ARCHETYPES, AGENTS_ARCHETYPE, AGENTS_START_ARCHETYPE, AGENTS_STOP, AGENTS_STOP_GROUP, AGENTS_STOP_BRANCH];
import { WORK_DELEGATE, WORK_METHOD_CAPABILITIES, type WorkCauseCapabilityServices, type WorkProposalCapabilityServices } from './work.js';
import { CHECKLIST_CAPABILITIES } from './checklist.js';
import { TASKS_CAPABILITIES, WORK_DAEMON_TASK_ADD } from './tasks.js';
import { WORK_INTAKE_CAPABILITIES } from './work-intake.js';
import {
  APPROVAL_KINDS_CAPABILITY, DECISIONS_ALWAYS, DECISIONS_ASK, DECISIONS_KEEP, DECISIONS_LIST, DECISIONS_NEVER, GOOGLE_WAITING,
  HELD_APPROVE, HELD_DISMISS, HELD_LIST, QUESTIONS_ALL, QUESTIONS_ANSWER, QUESTIONS_LIST, QUESTIONS_SHOW, QUESTIONS_WITHDRAW,
  type WaitingCapabilityServices,
} from './waiting.js';
// Waiting for you, Purchases: the purchases that wait on you (purchases.ts).
import { PURCHASES_CAPABILITIES } from './purchases.js';
import {
  TELEGRAM_APPROVE, TELEGRAM_CANCEL, TELEGRAM_CONFIGURE, TELEGRAM_DENY, TELEGRAM_LIST, TELEGRAM_READ, TELEGRAM_RELEASE, TELEGRAM_REVOKE, TELEGRAM_STATUS,
} from './telegram.js';
import { MONEY_CAPABILITIES } from './money.js';
import { TOOL_REGISTRY_CAPABILITIES, WEB_SEARCH, type WebSearchCapabilityServices } from './tools.js';
import { MCP_DAEMON_CAPABILITIES, MCP_SESSION_CAPABILITIES, type McpCapabilityServices } from './mcp.js';
import { PLUGIN_DAEMON_CAPABILITIES, PLUGIN_SESSION_CAPABILITIES, type PluginsCapabilityServices } from './plugins.js';
import { MARKETPLACE_CAPABILITIES, MARKETPLACE_RECOMMEND, type MarketplaceCapabilityServices } from './marketplace.js';
import { DEEPLINK_EXPORT, HOSTED_STOP_TOOL, MEDIA_MAKE, TOOLS_HELPERS } from './tools-extras.js';
import {
  SECRETS_DELETE, SECRETS_GET, SECRETS_LINK, SECRETS_LIST, SECRETS_PROVIDERS, SECRETS_STORAGE, SECRETS_TEST, SECRETS_TRUST, SECRETS_USE,
} from './secrets.js';
import { PERMISSIONS_ADD, PERMISSIONS_MODE, PERMISSIONS_NEVER, PERMISSIONS_PLACE, PERMISSIONS_SHOW, type PermissionRulesCapabilityServices } from './permissions.js';
import { PLAN_OFF, PLAN_ON, PLAN_STATUS } from './plan.js';
import {
  SECURITY_FOLDER, SECURITY_READ_SANDBOX, SECURITY_RESTRICT_FOLDER, SECURITY_RUN_IN_SANDBOX, SECURITY_SANDBOX_PRESETS, SECURITY_SANDBOX_SESSION,
  SECURITY_SANDBOX_SESSIONS, SECURITY_SAVE_SANDBOX, SECURITY_START_SANDBOX, SECURITY_STOP_SANDBOX, SECURITY_TOKENS, SECURITY_TRUST_FOLDER,
  type SecurityCapabilityServices,
} from './security.js';
import {
  SECURITY_REVIEW_DAEMON_CAPABILITIES, SECURITY_REVIEW_SESSION_CAPABILITIES, type SecurityReviewCapabilityServices,
} from './security-review.js';
import { SAFETY_METHOD_CAPABILITIES } from './safety-methods.js';
import { MY_SKILLS_CAPABILITIES, SKILL_PACK_CAPABILITIES, type SkillsCapabilityServices } from './skills.js';
import { MANAGED_CAPABILITIES, PRESETS_CAPABILITIES, type ProgramSettingsCapabilityServices } from './program-settings.js';
export * from './skills.js';
export * from './program-settings.js';
import { MODELS_CAPABILITIES, MODELS_METHOD_CAPABILITIES, type ModelsCapabilityServices } from './models.js';
import { SERVICES_CAPABILITIES, type ServicesCapabilityServices } from './services.js';
import { COMPARE_CAPABILITIES, type ModelComparisonCapabilityServices } from './compare.js';
import { ACCOUNTS_SIGN_IN, ACCOUNTS_SIGN_OUT } from './service-sessions.js';

export * from './conversation.js';
export * from './conversation-controls.js';
export * from './code.js';
export * from './messages.js';
export * from './notify.js';
export * from './channel-reads.js';
import { CHANNEL_READ_CAPABILITIES } from './channel-reads.js';
import { NOTIFY_CAPABILITIES, NOTIFY_FAILED, type NotifyCapabilityServices } from './notify.js';
// Mail, calendar and channels (builtin/channel-send.ts): a send to a channel, what was sent, Telegram's reading position.
export * from './channel-send.js';
import { CHANNEL_SEND_CAPABILITIES, type ChannelSendCapabilityServices } from './channel-send.js';
// Mail, calendar and channels (builtin/calendar.ts): the calendar on this computer, its feeds and the calendar accounts.
export * from './calendar.js';
import { CALENDAR_HERE_CAPABILITIES, type CalendarHereCapabilityServices } from './calendar.js';
export * from './google.js';
import { GOOGLE_CAPABILITIES, type GoogleCapabilityServices } from './google.js';
export * from './method-capability.js';
export * from './automation.js';
export * from './sessions.js';
export * from './hooks.js';
export * from './keys.js';
export * from './memory.js';
export * from './memory-session.js';
export * from './knowledge.js';
export * from './profile.js';
export * from './templates.js';
export * from './deeplink.js';
export * from './secrets.js';
export * from './agent-stores.js';
export * from './notes.js';
export * from './personas.js';
export * from './routines.js';
export * from './pinned-lines.js';
export * from './artifacts.js';
export * from './documents.js';
export * from './agent-homes.js';
export * from './devices.js';
export * from './devices-session.js';
export * from './network-scan.js';
export * from './settings-sync.js';
export * from './cluster.js';
export * from './cloudflare.js';
export * from './system.js';
export * from './workspaces.js';
export * from './system-session.js';
export * from './system-program.js';
export * from './system-settings.js';
export * from './system-updates.js';
export * from './system-setup.js';
export * from './system-bundles.js';
export * from './remote.js';
export * from './replay.js';
export * from './agents.js';
export * from './media-collect.js';
export * from './eval.js';
export * from './research.js';
export * from './handed-off.js';
export * from './work.js';
export * from './checklist.js';
export * from './tasks.js';
export * from './work-intake.js';
export * from './waiting.js';
export * from './purchases.js';
export * from './telegram.js';
export * from './money.js';
export * from './tools.js';
export * from './mcp.js';
export * from './plugins.js';
export * from './marketplace.js';
export * from './tools-extras.js';
export * from './permissions.js';
export * from './plan.js';
export * from './security.js';
// Permissions and safety (security-review.ts): the policy bundles, what is trusted, the sandbox setting, and this program's reviews.
export * from './security-review.js';
export * from './safety-methods.js';
export * from './models.js';
export * from './services.js';
export * from './service-sessions.js';
export * from './compare.js';
// This conversation: a model's context window size, the daemon's (context-windows.ts).
export * from './context-windows.js';
import { CONTEXT_WINDOW_CAPABILITIES } from './context-windows.js';

/** What the daemon hands the capabilities that run there. */
export type DaemonCapabilityServices = HooksCapabilityServices & SecretsCapabilityServices & MemoryCapabilityServices
  // Memory and knowledge (builtin/knowledge.ts, templates.ts): the one knowledge store, and the template files.
  & KnowledgeCapabilityServices & TemplateCapabilityServices
  & AgentStoresCapabilityServices
  // Work and agents (builtin/media-collect.ts): a collected file read back from the daemon's artifacts.
  & MediaCollectServices
  & MessagesCapabilityServices
  // Mail, calendar and channels (builtin/notify.ts): the daemon's webhook addresses, its secret store and notifier.
  & NotifyCapabilityServices
  // Mail, calendar and channels (builtin/channel-send.ts): the daemon's channel router and the sends it keeps.
  & ChannelSendCapabilityServices
  // Mail, calendar and channels (builtin/calendar.ts): the calendar on this computer and the calendar accounts.
  & CalendarHereCapabilityServices
  // Mail, calendar and channels (builtin/google.ts): the daemon's one Google connection and its work.
  & GoogleCapabilityServices
  & RemoteCapabilityServices
  & ClusterCapabilityServices
  // Devices and network (builtin/network-scan.ts): the one network-scan decision and the daemon's scan.
  & NetworkScanCapabilityServices
  // Devices and network (builtin/settings-sync.ts): the daemon's own settings, beside the asking program's.
  & SettingsSyncCapabilityServices
  // Devices and network, Permissions and safety (builtin/devices-projects.ts): the projects each device or member may work in.
  & CallerProjectsCapabilityServices
  // Devices and network (builtin/devices-shared.ts): what of the owner's shared things each caller may reach.
  & CallerSharedCapabilityServices
  // Waiting for you (builtin/waiting.ts): the daemon's one owner inbox.
  & WaitingCapabilityServices
  // Permissions and safety (builtin/permissions.ts, security.ts): the one rule store, the token audit, folder trust.
  & PermissionRulesCapabilityServices & SecurityCapabilityServices
  // Permissions and safety (builtin/security-review.ts): the one policy record, the trust summary, the sandbox setting.
  & SecurityReviewCapabilityServices
  // Tools and extensions (builtin/tools.ts): the daemon's web search service.
  & WebSearchCapabilityServices
  // Tools and extensions (builtin/mcp.ts): the MCP config files of the caller's project.
  & McpCapabilityServices
  // Tools and extensions (builtin/plugins.ts): the plugins of the caller's project and the one plugin state.
  & PluginsCapabilityServices
  // Tools and extensions (builtin/marketplace.ts): the local curated catalog and what is installed from it.
  & MarketplaceCapabilityServices
  // Tools and extensions (builtin/skills.ts, program-settings.ts): the one skill store; the asking program's managed settings and presets.
  & SkillsCapabilityServices & ProgramSettingsCapabilityServices
  // Models and providers (builtin/models.ts, services.ts): the daemon's provider stack, sign-ins and services file.
  & ModelsCapabilityServices & ServicesCapabilityServices
  // System (builtin/system-updates.ts): the daemon's settings and sign-ins an update review names.
  & SystemUpdatesCapabilityServices
  // System (builtin/system-setup.ts): the home folder the setup record is under.
  & { readonly setupHome?: (() => string) | undefined }
  // System (builtin/system-bundles.ts): the daemon's providers, a program's secret store and setup, for support bundles and moving a setup.
  & Pick<SystemBundleCapabilityServices, 'supportBundles'>
  // Models and providers (builtin/compare.ts): the daemon's comparison runner.
  & ModelComparisonCapabilityServices
  // Work (builtin/work.ts): the daemon's plans before they run, where a proposed piece of work waits, and who caused
  // each piece of work to run (kept on its record).
  & WorkProposalCapabilityServices & WorkCauseCapabilityServices;

interface Moved<Services> {
  readonly definition: CapabilityDefinition<Services>;
  readonly command: { readonly name: string; readonly title: string };
}

const HOOKS = { name: 'hooks', title: 'Hooks' };
const SECRETS = { name: 'secrets', title: 'Secrets' };
const MEMORY = { name: 'memory', title: 'Memory' };
const KEYS = { name: 'keys', title: 'Keys' };

export const DAEMON_CAPABILITIES: readonly Moved<DaemonCapabilityServices>[] = [
  { definition: HOOKS_CONTRACTS, command: HOOKS },
  { definition: HOOKS_ENABLE, command: HOOKS },
  { definition: HOOKS_DISABLE, command: HOOKS },
  // Tools and extensions (builtin/hooks.ts): the rest of managing the hooks file, and the hook trace.
  ...[HOOKS_SCAFFOLD, HOOKS_CHAIN, HOOKS_REMOVE, HOOKS_SIMULATE, HOOKS_EXPORT, HOOKS_INSPECT, HOOKS_IMPORT, HOOKS_TRACE]
    .map((definition) => ({ definition, command: HOOKS })),
  // Tools and extensions (builtin/skills.ts): the one skill store, and the local curated catalog; no slash command carries them.
  ...MY_SKILLS_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'my-skills', title: 'Skills' } })),
  ...SKILL_PACK_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'skills', title: 'Skill packs' } })),
  // Tools and extensions (builtin/program-settings.ts): the asking program's managed settings and presets; no slash command carries them.
  ...MANAGED_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'managed', title: 'Managed settings' } })),
  ...PRESETS_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'presets', title: 'Presets' } })),
  { definition: SECRETS_SET, command: SECRETS },
  // Memory and knowledge (builtin/memory.ts, knowledge.ts, profile.ts, templates.ts): memory, the one knowledge store,
  // what is known about you, and the template files; no slash command carries them but /memory, which opens their place.
  ...MEMORY_DAEMON_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: MEMORY })),
  ...KNOWLEDGE_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'knowledge', title: 'Knowledge' } })),
  ...PROFILE_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'about-me', title: 'About you' } })),
  ...TEMPLATE_DAEMON_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'template', title: 'Prompt templates' } })),
  // Mail (builtin/messages.ts): the daemon's one mailbox, its settings and its password; no slash command carries them.
  ...MAIL_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'mail', title: 'Mail' } })),
  ...CALENDAR_HANDLER_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'calendar', title: 'Calendar' } })),
  // The calendar on this computer, its feeds and the calendar accounts (builtin/calendar.ts).
  ...CALENDAR_HERE_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'calendar', title: 'Calendar' } })),
  ...CHANNELS_HANDLER_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'channels', title: 'Channels' } })),
  // A send to a channel, what was sent, Telegram's reading position (builtin/channel-send.ts).
  ...CHANNEL_SEND_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'channels', title: 'Channels' } })),
  // Webhook notifications (builtin/notify.ts): the daemon's one list of addresses, a test, a send, a resend.
  ...NOTIFY_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'notify', title: 'Webhook notifications' } })),
  // System (builtin/system.ts): sleep, the daemon's updates, the voice runtime, the first-run sign-in file; each a daemon method run as the caller.
  ...[POWER_STATUS, POWER_ON, POWER_OFF].map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'power', title: 'Sleep' } })),
  { definition: UPDATE_DAEMON as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'update', title: 'Updates' } },
  ...[VOICE_STATUS, VOICE_SETUP].map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'voice', title: 'Voice' } })),
  { definition: LOCAL_AUTH_REMOVE_FIRST_RUN_FILE as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'local-auth', title: 'Local sign-in' } },
  // System, Workspaces (builtin/workspaces.ts): the registered workspaces, unregistering one and registering one again.
  ...WORKSPACES_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'workspaces', title: 'Workspaces' } })),
  // Sessions, Chats and System, Workspaces (builtin/chats.ts): the chats and their projects, moving one to another
  // project, and the folder a chat with none is given its own in.
  ...CHATS_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'workspaces', title: 'Workspaces' } })),
  // System (builtin/system-settings.ts, system-daemon.ts): every setting, the voice settings as a file, updates, setup, support bundles.
  ...SYSTEM_SETTINGS_CAPABILITIES.map(({ definition, command }) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command })),
  ...SYSTEM_UPDATE_CAPABILITIES.map(({ definition, command }) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command })),
  ...SYSTEM_SETUP_CAPABILITIES.map(({ definition, command }) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command })),
  // System (builtin/system-bundles.ts): support bundles, the support folder and a setup moved to another computer.
  ...SYSTEM_BUNDLE_CAPABILITIES.map(({ definition, command }) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command })),
  // Work and agents (builtin/remote.ts): the remote runners the daemon holds, their pools and what they hand back.
  ...REMOTE_CAPABILITIES_ALL.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'remote', title: 'Remote runners' } })),
  // Work and agents (builtin/agents.ts): the coding agents the daemon finds and hosts, through its acp.* methods.
  ...[AGENTS_HOSTABLE, AGENTS_HOST].map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'agents', title: 'Your agents' } })),
  // Code and changes (builtin/code.ts): re-running a worktree's setup and removing a worktree, each through the daemon's
  // own method, in the caller's project.
  ...CODE_DAEMON_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'worktree', title: 'Worktrees' } })),
  // Work and agents (builtin/media-collect.ts): a media job still being made, collected by the daemon's media.collect.
  { definition: MEDIA_COLLECT as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'media', title: 'Media' } },
  // Work and agents (builtin/tasks.ts): a task given to an agent on the daemon (tasks.create), from any program or the web.
  { definition: WORK_DAEMON_TASK_ADD as unknown as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'work', title: 'Work' } },
  // Work and agents (builtin/research.ts, handed-off.ts): research runs, the research queue and reports, and coding work
  // handed to the terminal app, kept and run by the daemon's runner over the Agent's stores.
  ...RESEARCH_DAEMON_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'research', title: 'Research' } })),
  ...HANDED_OFF_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'agents', title: 'Your agents' } })),
  // Work and agents (builtin/work.ts): your work on the daemon's one runner, each act through its own daemon method.
  ...WORK_METHOD_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'work', title: 'Work' } })),
  // A task a model or an outside agent hands over, made a piece of work and started (builtin/work.ts); no slash command carries it.
  { definition: WORK_DELEGATE as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'work', title: 'Work' } },
  // Sessions (builtin/sessions.ts): a conversation the daemon hosts, started for the caller's own project folder.
  ...[HOSTED_NEW, HOSTED_LIST, HOSTED_END]
    .map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'hosted', title: 'Hosted sessions' } })),
  // Memory and knowledge (builtin/notes.ts, personas.ts, routines.ts, artifacts.ts, documents.ts): the Agent's own stores, kept by the daemon.
  ...NOTES_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'notes', title: 'Notes' } })),
  ...PERSONAS_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'personas', title: 'Personas' } })),
  ...ROUTINES_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'routines', title: 'Routines' } })),
  ...ARTIFACTS_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'artifacts', title: 'Saved artifacts' } })),
  ...DOCUMENTS_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'documents', title: 'Documents' } })),
  // Memory and knowledge (builtin/agent-homes.ts): the Agent's separate homes and their starter templates, kept by the daemon.
  ...AGENT_HOMES_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'agent-home', title: 'Agent homes' } })),
  // Devices and network (builtin/cluster.ts, cloudflare.ts): the machine group and Cloudflare; no slash command carries them.
  ...CLUSTER_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'cluster', title: 'Machine group' } })),
  ...CLOUDFLARE_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'cloudflare', title: 'Cloudflare' } })),
  // Devices and network (builtin/network-scan.ts): scanning your local network for model servers, by the daemon.
  ...NETWORK_SCAN_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'network-scan', title: 'Network scan for model servers' } })),
  // Devices and network (builtin/settings-sync.ts): your settings carried to another machine, part by owner.
  ...SETTINGS_SYNC_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'settings-sync', title: 'Settings sync' } })),
  // A device on the old shared token given its own; the token is the outcome's reveal (builtin/devices.ts).
  { definition: DEVICES_MIGRATE_SHARED as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'devices', title: 'Paired devices' } },
  // The projects a paired device or a member may work in, given and taken by the owner (builtin/devices-projects.ts).
  ...CALLER_PROJECTS_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'devices', title: 'Paired devices' } })),
  ...CALLER_SHARED_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'devices', title: 'Paired devices' } })),
  // The account that signs in from other devices, made on Addresses and ports (builtin/network-account.ts).
  { definition: NETWORK_SIGN_IN_ACCOUNT as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'devices', title: 'Paired devices' } },
  // Waiting for you, Purchases (builtin/purchases.ts): the purchases that wait on the owner, and what he does on each.
  ...PURCHASES_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'payments', title: 'Purchases waiting for you' } })),
  // The sends the Agent's content check refused, posted to the owner inbox (builtin/waiting.ts).
  { definition: GOOGLE_WAITING as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'google', title: 'Gmail and Google Calendar' } },
  // Mail, calendar and channels (builtin/google.ts): the one Google connection, connected, checked, adopted and
  // disconnected as the daemon's work, and the answers on a refused send; no slash command carries them.
  ...GOOGLE_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'google', title: 'Gmail and Google Calendar' } })),
  // Waiting for you (builtin/waiting.ts, telegram.ts): the owner inbox, the kinds of approval, and Telegram messages held for the owner.
  ...[QUESTIONS_LIST, QUESTIONS_ALL, QUESTIONS_SHOW, QUESTIONS_ANSWER, QUESTIONS_WITHDRAW]
    .map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'questions', title: 'What waits on you' } })),
  { definition: DECISIONS_LIST as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'decisions', title: 'What was decided for you' } },
  { definition: APPROVAL_KINDS_CAPABILITY as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'approval', title: 'Approvals' } },
  ...[TELEGRAM_LIST, TELEGRAM_CONFIGURE, TELEGRAM_APPROVE, TELEGRAM_DENY, TELEGRAM_STATUS, TELEGRAM_READ, TELEGRAM_CANCEL, TELEGRAM_REVOKE, TELEGRAM_RELEASE]
    .map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'telegram', title: 'Telegram messages held for you' } })),
  // Money (builtin/money.ts): cards, addresses, purchases allowed ahead of time and what was spent; each a daemon method run as the caller.
  ...MONEY_CAPABILITIES.map((definition) => ({
    definition: definition as CapabilityDefinition<DaemonCapabilityServices>,
    command: definition.capability.id.startsWith('usage.') ? { name: 'usage', title: 'Usage' } : { name: 'payments', title: 'Payments' },
  })),
  // Permissions and safety (builtin/secrets.ts, permissions.ts, security.ts, safety-methods.ts): your secrets, the permission
  // rules, folder trust, the paired devices' tokens, who may sign in, who is who, the phones' always-allow grants.
  ...[SECRETS_LIST, SECRETS_LINK, SECRETS_GET, SECRETS_TEST, SECRETS_PROVIDERS, SECRETS_STORAGE, SECRETS_TRUST, SECRETS_DELETE]
    .map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: SECRETS })),
  ...[PERMISSIONS_NEVER, PERMISSIONS_ADD, PERMISSIONS_PLACE].map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'permissions', title: 'Permissions' } })),
  ...[SECURITY_TOKENS, SECURITY_SANDBOX_PRESETS, SECURITY_FOLDER, SECURITY_TRUST_FOLDER, SECURITY_RESTRICT_FOLDER]
    .map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'security', title: 'Security' } })),
  // The policy bundles (one activation record every program follows), what is trusted, the sandbox setting; no slash command carries them.
  ...SECURITY_REVIEW_DAEMON_CAPABILITIES
    .map((definition) => ({ definition: definition as unknown as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'security', title: 'Security' } })),
  ...SAFETY_METHOD_CAPABILITIES.map(({ definition, command }) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command })),
  // Tools and extensions (builtin/tools.ts): a web search through the daemon's web search service.
  { definition: WEB_SEARCH as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'web-search', title: 'Search the web' } },
  // Tools and extensions (builtin/mcp.ts): what the MCP config files keep, for the caller's project.
  ...MCP_DAEMON_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'mcp', title: 'MCP servers and tools' } })),
  // Tools and extensions (builtin/plugins.ts): which plugins are on, their trust, keys and the local catalog.
  ...PLUGIN_DAEMON_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'plugin', title: 'Plugins' } })),
  // Tools and extensions (builtin/marketplace.ts): the local curated catalog and the installs from it.
  ...MARKETPLACE_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'marketplace', title: 'Marketplace' } })),
  // Tools and extensions (builtin/tools-extras.ts): an image or a video made by the daemon's media providers.
  { definition: MEDIA_MAKE as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'media', title: 'Images and video' } },
  // Models and providers (builtin/models.ts, services.ts): backups, pins, routing, providers of your own, sign-ins, accounts, services.
  ...MODELS_CAPABILITIES.map(({ definition, command }) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command })),
  ...SERVICES_CAPABILITIES.map(({ definition, command }) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command })),
  // Models and providers (builtin/compare.ts): blind model comparisons, run by the daemon's comparison runner.
  ...COMPARE_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'compare', title: 'Model comparisons' } })),
  // This conversation (builtin/context-windows.ts): a model's context window size, kept by the daemon for every program.
  ...CONTEXT_WINDOW_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<DaemonCapabilityServices>, command: { name: 'context', title: 'Context' } })),
];

/**
 * The capabilities that run through a daemon method of their own (method-capability.ts): found and run with that
 * method by every door, whether or not a slash command carries them.
 */
export const METHOD_CAPABILITIES: readonly { readonly definition: MethodCapabilityDefinition; readonly command: { readonly name: string; readonly title: string } }[] = [
  ...MESSAGES_METHOD_CAPABILITIES,
  // Devices and network (builtin/devices.ts): paired devices, the relay, devices waiting to pair, phones, grants, captures.
  ...DEVICES_CAPABILITIES.map((definition) => ({ definition, command: { name: 'devices', title: 'Paired devices' } })),
  // Automation (builtin/automation.ts): schedules and their runs, triggers, CI watches and check-ins, each the daemon's own method.
  ...AUTOMATION_METHOD_CAPABILITIES,
  // Models and providers (builtin/models.ts): the model lists, the shared default model, starting and finishing a sign-in, the accounts.
  ...MODELS_METHOD_CAPABILITIES,
  // Mail, calendar and channels (builtin/notify.ts): the daemon's failed notifications.
  { definition: NOTIFY_FAILED, command: { name: 'notify', title: 'Webhook notifications' } },
  // Mail, calendar and channels (builtin/channel-reads.ts): readiness, setup guide, what came in, what was sent, the routes.
  ...CHANNEL_READ_CAPABILITIES.map((definition) => ({ definition, command: { name: 'channels', title: 'Channels' } })),
];

/** A capability that runs through its own daemon method, by id. */
export function methodCapability(id: string): MethodCapabilityDefinition | undefined {
  return METHOD_CAPABILITIES.find((moved) => moved.definition.capability.id === id)?.definition;
}

export const SESSION_CAPABILITIES: readonly Moved<never>[] = [
  { definition: CONVERSATION_CLEAR as CapabilityDefinition<never>, command: { name: 'clear', title: 'Start a fresh conversation' } },
  { definition: CONVERSATION_COMPACT as CapabilityDefinition<never>, command: { name: 'compact', title: 'Compact the conversation' } },
  { definition: CONVERSATION_UNDO as CapabilityDefinition<never>, command: { name: 'undo', title: 'Undo' } },
  // The program's key table (builtin/keys.ts): the Keys place and the model run these; no slash command carries them.
  { definition: KEYS_BIND as CapabilityDefinition<never>, command: KEYS },
  { definition: KEYS_RESET as CapabilityDefinition<never>, command: KEYS },
  { definition: KEYS_RESET_ALL as CapabilityDefinition<never>, command: KEYS },
  // Your conversations (builtin/sessions.ts): saved ones are files of the program holding the conversation.
  ...[
    SESSION_CURRENT, SESSION_LIST, SESSION_INFO, SESSION_SEARCH, SESSION_DELETE, SESSION_RESUME, SESSION_FORK, SESSION_RENAME,
    SESSION_SAVE_SAVED, SESSION_UPLOAD, SESSION_BRANCHES, SESSION_SWITCH_BRANCH, SESSION_MERGE_BRANCH,
    // Reading this conversation's record through, and the view over it.
    SESSION_EVENTS, SESSION_GROUPS, SESSION_HOTSPOTS, SESSION_FIND, SESSION_NEXT, SESSION_PREV, SESSION_BOOKMARKS, SESSION_COMPOSER, SESSION_RESTORED,
    // The project's cross-session task graph, the one file both terminal programs and a turn's task tool use.
    SESSION_GRAPH, SESSION_LINK_TASK, SESSION_HAND_OFF, SESSION_ACCEPT, SESSION_WITHDRAW, SESSION_CANCEL,
  ].map((definition) => ({ definition: definition as CapabilityDefinition<never>, command: { name: 'session', title: 'Sessions' } })),
  // The terminal's own join of the daemon's hosted sessions: it follows the joined one live.
  ...[HOSTED_STATUS, HOSTED_ATTACH, HOSTED_SEND, HOSTED_LEAVE]
    .map((definition) => ({ definition: definition as CapabilityDefinition<never>, command: { name: 'hosted', title: 'Hosted sessions' } })),
  // Tools and extensions: reading the hooks file again into this program's dispatcher (builtin/hooks.ts).
  { definition: HOOKS_RELOAD as CapabilityDefinition<never>, command: HOOKS },
  // Tools and extensions (builtin/tools.ts): the tools this program's model can call, and their contracts.
  ...TOOL_REGISTRY_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<never>, command: { name: 'tools', title: 'Tools' } })),
  // Tools and extensions (builtin/mcp.ts): this program's own tool server connections and its session's settings.
  ...MCP_SESSION_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<never>, command: { name: 'mcp', title: 'MCP servers and tools' } })),
  // Tools and extensions (builtin/plugins.ts): the plugins this program runs.
  ...PLUGIN_SESSION_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<never>, command: { name: 'plugin', title: 'Plugins' } })),
  // Tools and extensions (builtin/marketplace.ts): what fits this project, as this program reads it.
  { definition: MARKETPLACE_RECOMMEND as CapabilityDefinition<never>, command: { name: 'marketplace', title: 'Marketplace' } },
  // Tools and extensions (builtin/tools-extras.ts): the terminal app's helper interfaces, its view links saved to a file, and
  // the tool running in the hosted session it joined.
  { definition: TOOLS_HELPERS as CapabilityDefinition<never>, command: { name: 'helpers', title: 'Integration helpers' } },
  { definition: DEEPLINK_EXPORT as CapabilityDefinition<never>, command: { name: 'deeplink', title: 'Links to views' } },
  { definition: HOSTED_STOP_TOOL as CapabilityDefinition<never>, command: { name: 'hosted', title: 'Hosted sessions' } },
  // Memory and knowledge (builtin/memory-session.ts, templates.ts, deeplink.ts): what this program's turns were given and
  // holds, memory kept as files in its project, a template as the next message, and links to the terminal app's views.
  ...MEMORY_SESSION_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<never>, command: MEMORY })),
  ...TEMPLATE_SESSION_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<never>, command: { name: 'template', title: 'Prompt templates' } })),
  ...[DEEPLINK_OPEN, DEEPLINK_INSPECT].map((definition) => ({ definition: definition as CapabilityDefinition<never>, command: { name: 'deeplink', title: 'Links to views' } })),
  // Memory and knowledge (builtin/routines.ts): a routine's steps sent as the next message of this conversation.
  { definition: ROUTINES_START as CapabilityDefinition<never>, command: { name: 'routines', title: 'Routines' } },
  // This conversation (builtin/pinned-lines.ts): the lines pinned in it, kept for its length and given again after compaction.
  ...PINNED_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<never>, command: { name: 'pinned', title: 'Pinned lines' } })),
  // The controls on the conversation itself (builtin/conversation-controls.ts): the turn, its record, its context, the composer, checkpoints.
  ...CONVERSATION_CONTROLS.map(({ definition, command }) => ({ definition: definition as CapabilityDefinition<never>, command })),
  // Code and changes (builtin/code.ts): git, the code index, code lookups, tests and worktrees, on the program's project folder.
  ...CODE_SESSION_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<never>, command: codeCommandOf(definition.capability.id) })),
  // Waiting for you (builtin/waiting.ts): a choice on a call Jev decided here, and the calls just-vibes held here.
  ...[DECISIONS_KEEP, DECISIONS_NEVER, DECISIONS_ALWAYS, DECISIONS_ASK]
    .map((definition) => ({ definition: definition as CapabilityDefinition<never>, command: { name: 'decisions', title: 'What was decided for you' } })),
  ...[HELD_LIST, HELD_APPROVE, HELD_DISMISS].map((definition) => ({ definition: definition as CapabilityDefinition<never>, command: { name: 'held', title: 'Held calls' } })),
  // Work and agents (builtin/checklist.ts): the project's checklist, kept by the program holding the conversation in the shared file.
  ...CHECKLIST_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<never>, command: { name: 'work', title: 'Work' } })),
  // Work and agents (builtin/tasks.ts): this program's tasks and the daemon's.
  ...TASKS_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<never>, command: { name: 'work', title: 'Work' } })),
  // Work and agents (builtin/work-intake.ts): asking for work, and the journal that makes a resend safe.
  ...WORK_INTAKE_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<never>, command: { name: 'work', title: 'Work' } })),
  // Permissions and safety: this conversation's permissions and plan mode, a secret for this session, the sandbox sessions this program started.
  { definition: SECRETS_USE as CapabilityDefinition<never>, command: SECRETS },
  ...[PERMISSIONS_MODE, PERMISSIONS_SHOW].map((definition) => ({ definition: definition as CapabilityDefinition<never>, command: { name: 'permissions', title: 'Permissions' } })),
  ...[PLAN_STATUS, PLAN_ON, PLAN_OFF].map((definition) => ({ definition: definition as CapabilityDefinition<never>, command: { name: 'plan', title: 'Plan mode (nothing is changed)' } })),
  ...[SECURITY_SANDBOX_SESSIONS, SECURITY_START_SANDBOX, SECURITY_SANDBOX_SESSION, SECURITY_STOP_SANDBOX, SECURITY_RUN_IN_SANDBOX, SECURITY_SAVE_SANDBOX, SECURITY_READ_SANDBOX]
    .map((definition) => ({ definition: definition as CapabilityDefinition<never>, command: { name: 'security', title: 'Security' } })),
  // What needs attention, the whole review and risky MCP routes (this program's live state with the daemon's facts), the probe here.
  ...SECURITY_REVIEW_SESSION_CAPABILITIES.map((definition) => ({ definition: definition as unknown as CapabilityDefinition<never>, command: { name: 'security', title: 'Security' } })),
  // Work and agents (builtin/replay.ts): the runs this program recorded of its turns, and the one loaded.
  ...REPLAY_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<never>, command: { name: 'replay', title: 'Recorded runs' } })),
  // Work and agents (builtin/agents.ts): team modes, recipes and archetypes, work contracts and stopping agents.
  ...AGENTS_SESSION_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<never>, command: { name: 'agents', title: 'Your agents' } })),
  // Work and agents (builtin/agents.ts): the Agent's briefing of its own state.
  { definition: WORK_BRIEF as CapabilityDefinition<never>, command: { name: 'brief', title: 'Briefing' } },
  // Work and agents (builtin/eval.ts, research.ts): task suites run in this program's project, and a question or page sent to its conversation.
  ...EVAL_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<never>, command: { name: 'eval', title: 'Evaluate on real tasks' } })),
  ...RESEARCH_SESSION_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<never>, command: { name: 'research', title: 'Research' } })),
  // System (builtin/system-session.ts): this session at a glance, closing the program, how much it prints.
  { definition: SYSTEM_STATUS as CapabilityDefinition<never>, command: { name: 'status', title: 'Status' } },
  { definition: SYSTEM_QUIT as CapabilityDefinition<never>, command: { name: 'quit', title: 'Quit' } },
  ...[VERBOSITY_SHOW, VERBOSITY_SET, VERBOSITY_SET_DOMAIN].map((definition) => ({ definition: definition as CapabilityDefinition<never>, command: { name: 'verbosity', title: 'How much the app prints' } })),
  // Speaking and listening, on this terminal's speaker and microphone.
  ...[VOICE_REVIEW, VOICE_ON, VOICE_OFF, VOICE_SPEAK, VOICE_WAKE_AGAIN].map((definition) => ({ definition: definition as CapabilityDefinition<never>, command: { name: 'voice', title: 'Voice' } })),
  // System (builtin/system-program.ts): this program's health, release readiness, its own start, links, help, stop speaking, the wake word.
  ...SYSTEM_PROGRAM_CAPABILITIES.map(({ definition, command }) => ({ definition: definition as CapabilityDefinition<never>, command })),
  // Models and providers (builtin/service-sessions.ts): this program's own sign-in to a daemon or listener.
  ...[ACCOUNTS_SIGN_IN, ACCOUNTS_SIGN_OUT].map((definition) => ({ definition: definition as CapabilityDefinition<never>, command: { name: 'accounts', title: 'Accounts' } })),
  // Devices and network (builtin/devices-session.ts): pairing something on this program's screen, and its own credential for its daemon.
  ...DEVICES_SESSION_CAPABILITIES.map((definition) => ({ definition: definition as CapabilityDefinition<never>, command: { name: 'devices', title: 'Paired devices' } })),
];

/** A moved daemon capability by id. */
export function daemonCapability(id: string): CapabilityDefinition<DaemonCapabilityServices> | undefined {
  return DAEMON_CAPABILITIES.find((moved) => moved.definition.capability.id === id)?.definition;
}

// Every daemon capability's folder input states whether a turn or process works in it (capabilities/work-folders.ts).
assertWorkFoldersDeclared(DAEMON_CAPABILITIES.map((moved) => moved.definition));
// Every daemon capability's input that names a record by id says what it addresses (control-plane/record-addresses.ts).
assertCapabilityAddressesDeclared(DAEMON_CAPABILITIES.map((moved) => moved.definition));

/** The inputs of a daemon capability a turn or process works in: checked by the dispatch as projects the caller may name. */
export function capabilityWorkFolderInputs(id: string): readonly string[] {
  return workFolderInputsOf(daemonCapability(id));
}

/** The catalog entries of every moved capability. */
export function movedCapabilityEntries(): readonly CapabilityEntry[] {
  return [
    ...[...DAEMON_CAPABILITIES, ...SESSION_CAPABILITIES].map((moved) => entryOfDefinition(moved.definition as CapabilityDefinition<never>, moved.command)),
    ...METHOD_CAPABILITIES.map((moved) => methodCapabilityEntry(moved.definition, moved.command)),
  ];
}
