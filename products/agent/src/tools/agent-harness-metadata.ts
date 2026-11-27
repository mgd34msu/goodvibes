import { agentHarnessModes, hostActions, settingsActions } from './agent-harness-route-format.ts';
import { EFFECT_ADMISSION_SENTENCE } from '@goodvibes/engine/terminal-shell/agent-turn/effect-admission';
import type { TerminalCommandEffect } from '@goodvibes/engine/terminal-shell/command-registry';
import type { SlashCommand } from '../input/command-registry.ts';
export { describeCliCommandPolicy } from './agent-harness-cli-command-policy.ts';
// Re-exported so this module stays the one import site for harness metadata,
// exactly as describeCliCommandPolicy above already is.
export {
  blockedConnectedHostCapabilities,
  connectedHostCapabilityMap,
  connectedHostRouteFamilies,
  connectedHostSummary,
  describeConnectedHostCapability,
} from './agent-harness-connected-host-capabilities.ts';
export type { ConnectedHostCapabilityResolution } from './agent-harness-connected-host-capabilities.ts';

export interface CommandExecutionPolicy {
  /** Declared on the command's definition (`effect`, next to `usage`); `undeclared` when the command states none, which the model runner refuses. */
  readonly effect: TerminalCommandEffect | 'undeclared';
  readonly readVerbs?: readonly string[];
  readonly confirmation: string;
  readonly requiresConfirmation?: boolean;
  readonly preferredModelTool?: string;
  readonly boundary: string;
}

/** Model-facing notes for a command: how to reach it and what it touches. They grant nothing; the effect is the command's own. */
function commandModelNotes(commandName: string): Omit<CommandExecutionPolicy, 'effect' | 'readVerbs'> {
  const root = commandName.replace(/^\//, '').trim().toLowerCase();
  const confirmation = 'Model command effects require current recorded engine admission. Caller confirmation and request fields grant no authority; owner-specific scope and effect checks remain mandatory.';
  if (root === 'work') {
    return {
      requiresConfirmation: false,
      confirmation: 'Reads use the daemon\'s existing read permissions. Every act on a piece of work runs under current authority; caller confirmation flags grant no authority.',
      preferredModelTool: 'capability_find, then capability_run with a work.* capability',
      boundary: '/work opens the Work place for the person. Every act on work (see it, start, check, stop, go on, answer it, run a failed step again, its spending limit, a plan before it runs, propose a piece of work with its plan) is a work.* capability: find it with capability_find and run it with capability_run. Host, principal, workspace and live capability checks remain mandatory.',
    };
  }
  if (root === 'agent') {
    return {
      confirmation,
      preferredModelTool: 'capability_find and capability_run',
      boundary: 'The person reaches every place from the menu (Ctrl+G then m). Use capability_find and capability_run for concrete model-readable operation.',
    };
  }
  if (root === 'setup' || root === 'welcome') {
    return {
      confirmation,
      preferredModelTool: `capability_find and capability_run, or ${agentHarnessModes('open_ui_surface')}`,
      boundary: 'Setup is the Setup tab of the System place for the person. Model-side changes should use settings or a setup.<topic> capability.',
    };
  }
  if (root === 'commands' || root === 'help' || root === 'shortcuts') {
    return {
      confirmation,
      preferredModelTool: root === 'shortcuts' ? agentHarnessModes('shortcuts', 'keybindings', 'keybinding') : agentHarnessModes('commands', 'command'),
      boundary: 'Discovery commands open visible help surfaces. The model should inspect the matching harness catalog directly before invoking commands.',
    };
  }
  if (root === 'keybindings') {
    return {
      confirmation,
      preferredModelTool: agentHarnessModes('shortcuts', 'keybindings', 'keybinding', 'run_keybinding'),
      boundary: 'Keybinding inspection is read-only. Running a keybinding needs explicit confirmation through agent_harness run_keybinding; a binding is changed with capability_run id:"keys.bind" (keys.reset puts one back).',
    };
  }
  if (root === 'payments') {
    return {
      confirmation,
      preferredModelTool: settingsActions('list', 'get', 'set'),
      boundary: 'Budgets, windows, CVV handling and the two addresses are ordinary daemon-owned settings and can be read or written through the settings adapter. The card itself cannot: number, expiry, verification code and cardholder name are typed only by the person at a local terminal, through a masked prompt that echoes nothing, and are stored write-only in the daemon secret store. Nothing here returns them and nothing here sets them, and no card prompt is ever offered over Telegram, ntfy, Discord, Slack, WhatsApp, Signal or a webhook, approving or cancelling a purchase over those channels still works.',
    };
  }
  if (root === 'settings' || root === 'config') {
    return {
      confirmation,
      preferredModelTool: settingsActions('list', 'get', 'set', 'reset', 'import'),
      boundary: 'Settings can be changed through the first-class settings adapter, including daemon-owned ones, a write routes to the runtime that owns the key and reports the store it landed in. A change is applied only for what the owner asked in this turn, and confirm or explicitUserRequest arguments are not authority; payment card details, credential destinations and a credential reference to another key\'s secret are refused with the key and the reason; payment limits and every other setting are written when asked.',
    };
  }
  if (root === 'model' || root === 'effort') {
    return {
      confirmation,
      preferredModelTool: `${settingsActions('get', 'set')} or ${agentHarnessModes('open_ui_surface')}`,
      boundary: 'Model and reasoning-effort changes affect the current Agent chat route. Prefer settings for concrete values and UI surface routing for visible pickers.',
    };
  }
  if (root === 'provider' || root === 'providers') {
    return {
      confirmation,
      preferredModelTool: `${settingsActions('get', 'set')} or ${agentHarnessModes('open_ui_surface')}`,
      boundary: 'Provider selection and custom provider files belong to Agent provider configuration. Adding, removing, or switching providers requires explicit user intent.',
    };
  }
  if (root === 'refresh-models') {
    return {
      confirmation,
      preferredModelTool: `${settingsActions('list', 'get')} or ${agentHarnessModes('tools')}`,
      boundary: 'Model catalog refresh may call provider discovery routes and update local provider metadata. Do not run it without explicit user request.',
    };
  }
  if (root === 'pin' || root === 'unpin') {
    return {
      confirmation,
      preferredModelTool: agentHarnessModes('run_command'),
      boundary: 'Pinned model changes mutate local Agent provider preferences only and require an explicit model id.',
    };
  }
  if (root === 'mode') {
    return {
      confirmation,
      preferredModelTool: settingsActions('get', 'set'),
      boundary: 'Interaction-mode changes affect the current Agent operator notification posture and should be explicit.',
    };
  }
  if (root === 'vibe' || root === 'vibes') {
    return {
      confirmation,
      preferredModelTool: 'vibe or agent_local_registry',
      boundary: 'VIBE.md status/show are read-only; init writes a local personality file and import-persona writes an Agent-local persona after explicit confirmation.',
    };
  }
  if (root === 'brief') {
    return {
      confirmation,
      preferredModelTool: 'agent_operator_briefing',
      boundary: 'Briefing reads current Agent operator posture and next actions without mutating connected-host state.',
    };
  }
  if (root === 'context') {
    return {
      confirmation,
      preferredModelTool: agentHarnessModes('open_ui_surface', 'run_command'),
      boundary: 'There is no /context command: the usage breakdown and the current model\'s window are reads (capability_find "context window"; a person has them in This conversation). Setting a window override for the current model, or clearing it and any learned limit, changes the model registry\'s persisted override file and needs explicit user intent.',
    };
  }
  if (root === 'health' || root === 'compat' || root === 'status' || root === 'accounts' || root === 'security') {
    return {
      confirmation,
      preferredModelTool: root === 'compat'
        ? hostActions('services', 'service', 'status')
        : `${hostActions('services', 'service', 'status')} or ${settingsActions('list', 'get')} or ${agentHarnessModes('tools', 'open_ui_surface')}`,
      boundary: 'Diagnostics and review commands inspect Agent, provider, MCP, security, and connected-host readiness without taking lifecycle ownership.',
    };
  }
  if (root === 'update' || root === 'upgrade') {
    return {
      confirmation,
      preferredModelTool: agentHarnessModes('run_command'),
      boundary: 'Check is a read-only release lookup; apply downloads, checksum-verifies, and atomically swaps the installed binary (and vector addon) keeping the previous version beside it, and rollback exchanges the kept previous version back in. Apply and rollback change the installed program and require explicit user intent.',
    };
  }
  if (root === 'trust' || root === 'auth' || root === 'bundle') {
    return {
      confirmation,
      preferredModelTool: agentHarnessModes('run_command'),
      boundary: 'Review subcommands are read-only; bundle export/import or auth/trust bundle export writes local files and requires explicit confirmation.',
    };
  }
  if (root === 'mcp' || root === 'voice' || root === 'subscription' || root === 'secrets') {
    return {
      confirmation,
      preferredModelTool: root === 'secrets'
        ? settingsActions('list', 'get', 'set', 'reset')
        : `capability_find and capability_run, ${agentHarnessModes('open_ui_surface')}, or ${settingsActions('list', 'get', 'set')}`,
      boundary: 'Harness-owned configuration, secret, voice, subscription, and MCP commands can expose credentials or external account state. Mutations require explicit user intent and should prefer secret refs over raw values.',
    };
  }
  if (
    root === 'memory'
    || root === 'memories'
    || root === 'note'
    || root === 'persona'
    || root === 'personas'
    || root === 'skill'
    || root === 'skills'
    || root === 'routine'
    || root === 'routines'
  ) {
    return {
      confirmation,
      preferredModelTool: 'agent_local_registry',
      boundary: 'Agent-local library records only unless the invoked command explicitly promotes to a connected schedule or Agent Knowledge source.',
    };
  }
  if (root === 'owner-profile' || root === 'about-me') {
    return {
      // Reads print his own profile; set and forget change the file and already
      // require --yes at the command itself. The model's route is the `profile`
      // tool, not this command: the tool carries the authority naming where a
      // fact came from, his verbatim words, and the one-line disclosure that
      // goes back in the reply, none of which a shell string can express.
      confirmation,
      preferredModelTool: 'profile',
      boundary: 'The owner profile is one Markdown file at daemon scope that only the daemon writes. Reads are safe; every write carries an authority and is refused unless the fact came from him directly. Record facts through the `profile` tool during a conversation rather than invoking this command.',
    };
  }
  if (root === 'notes') {
    return {
      confirmation,
      preferredModelTool: 'capability_find and capability_run, or agent_local_registry',
      boundary: 'Opening Notes is visible navigation (Memory and knowledge, Notes); note record changes use the notes.* capabilities or the Agent-local registry.',
    };
  }
  if (root === 'knowledge') {
    return {
      confirmation,
      preferredModelTool: 'agent_knowledge or agent_knowledge_ingest',
      boundary: 'Agent Knowledge only. Do not use default knowledge or non-Agent knowledge spaces.',
    };
  }
  if (root === 'approval' || root === 'approvals' || root === 'automation') {
    return {
      confirmation,
      preferredModelTool: 'agent_operator_action',
      boundary: 'Only explicit allowlisted approval and automation operator actions should be performed from the model.',
    };
  }
  if (root === 'ci' || root === 'principals' || root === 'principal' || root === 'channel-profiles' || root === 'channel-profile') {
    return {
      confirmation,
      // agent_operator_method, NOT agent_operator_action: the action tool's
      // allowlist covers only approvals.* and automation.* and cannot invoke
      // ci.*/principals.*/channels.profiles.*, pointing the model there would
      // dead-end in "unknown action".
      preferredModelTool: 'agent_operator_method (methodId "ci.status", "ci.watches.*", "principals.*", "channels.profiles.*")',
      boundary: `CI status/watches, principal identity mappings, and per-channel profile defaults live on the connected host. Reads run through agent_operator_method without confirmation. Writes there: ${EFFECT_ADMISSION_SENTENCE} Mutating slash/CLI subcommands require --yes.`,
    };
  }
  if (root === 'schedule' || root === 'remind' || root === 'reminder') {
    return {
      confirmation,
      preferredModelTool: 'schedule',
      boundary: 'Connected schedules require an explicit user request and do not create hidden Agent jobs or local schedulers.',
    };
  }
  if (root === 'google' || root === 'gmail') {
    return {
      confirmation,
      preferredModelTool: 'google',
      boundary: 'The Google account that backs mail and calendar is the daemon\'s one connection, connected on the Google tab of Mail, calendar and channels (capability google.connect; google.adopt takes up credentials found on the daemon\'s machine). Once connected, the google tool is the model route, no MCP server is involved. A model\'s capability_run of a Google capability that stores, adopts, replaces or removes a credential is put to the owner, opening on No.',
    };
  }
  if (root === 'mail') {
    return {
      confirmation,
      preferredModelTool: 'capability_run (mail.set to configure the mailbox, mail.settings to view it, mail.password to store the password; the daemon runs each)',
      boundary: 'Email IMAP reads are read-only (EXAMINE); a send asks the owner first and goes only to the configured account. The mailbox is the daemon\'s: mail.set validates each field and writes it to the daemon\'s settings, mail.password stores the password as a secret reference in the daemon\'s store. Setting the mail servers, ports, security or username changes where the stored password is presented, and storing the password writes a credential, so a model\'s call of either is put to the owner, opening on No.',
    };
  }
  if (root === 'calendar' || root === 'cal') {
    return {
      confirmation,
      preferredModelTool: agentHarnessModes('run_command'),
      boundary: 'The calendar is the daemon\'s: the capabilities calendar.upcoming, all, get, subscriptions, accounts and status read and need no admission; add, change, delete and import change events (delete asks first); subscribe and refresh read a feed from outside; unsubscribe and disconnect cannot be undone and are asked first; connect and use-app keep a credential and a feed on the private network loosens a protection, so a model\'s call of them is put to the owner, opening on No. Find them with capability_find.',
    };
  }
  if (root === 'channels' || root === 'channel' || root === 'notify') {
    return {
      confirmation,
      preferredModelTool: root === 'notify' ? 'agent_notify' : 'agent_channel_send',
      boundary: 'External delivery requires an explicit target and direct user authorization.',
    };
  }
  if (root === 'media') {
    return {
      confirmation,
      preferredModelTool: 'agent_media_generate',
      boundary: 'Media generation uses configured Agent media providers and writes normal artifacts only.',
    };
  }
  if (root === 'image') {
    return {
      confirmation,
      preferredModelTool: agentHarnessModes('open_ui_surface'),
      boundary: 'Image attachment reads a local image and submits a model turn with image content. Use only for explicit user-supplied files.',
    };
  }
  if (root === 'tts') {
    return {
      confirmation,
      preferredModelTool: `${settingsActions('get', 'set')} or ${agentHarnessModes('open_ui_surface')}`,
      boundary: 'Live TTS submits a normal prompt and may call model and speech providers; stopping playback is local runtime control.',
    };
  }
  if (root === 'workplan' || root === 'plan' || root === 'task' || root === 'tasks') {
    return {
      confirmation,
      preferredModelTool: 'agent_work_plan',
      boundary: 'Work planning stays in the current Agent/project planning surfaces unless the command explicitly calls connected-host operator routes.',
    };
  }
  if (root === 'delegate') {
    return {
      confirmation,
      preferredModelTool: 'capability_run id:"work.delegate"',
      boundary: 'Delegation is explicit user-directed work only; no hidden background review or separate Agent job should be created implicitly.',
    };
  }
  if (
    root === 'session'
    || root === 'conversation'
    || root === 'clear'
    || root === 'reset'
    || root === 'compact'
    || root === 'quit'
    || root === 'exit'
    || root === 'save'
    || root === 'resume'
    || root === 'title'
    || root === 'undo'
    || root === 'redo'
    || root === 'retry'
  ) {
    return {
      confirmation,
      preferredModelTool: agentHarnessModes('commands', 'command', 'run_command'),
      boundary: 'Session and conversation commands operate on the visible harness session lifecycle.',
    };
  }
  if (root === 'agents') {
    return {
      confirmation,
      preferredModelTool: agentHarnessModes('run_command'),
      boundary: 'Opens Your agents (what is running, what waits for you, what is scheduled, the background services); it only changes what is on screen.',
    };
  }
  if (root === 'notifications') {
    return {
      confirmation,
      preferredModelTool: agentHarnessModes('run_command'),
      boundary: 'Opens the notification history (every system notice in full, newest first); it only changes what is on screen.',
    };
  }
  if (root === 'bookmarks' || root === 'expand' || root === 'collapse' || root === 'next-error' || root === 'prev-error') {
    return {
      confirmation,
      preferredModelTool: root === 'bookmarks' ? `${agentHarnessModes('open_ui_surface')} or ${agentHarnessModes('run_command')}` : agentHarnessModes('run_command'),
      boundary: 'Conversation display navigation mutates only the visible transcript view or scroll position.',
    };
  }
  if (root === 'paste') {
    return {
      confirmation,
      preferredModelTool: agentHarnessModes('run_keybinding'),
      boundary: 'Paste reads the local clipboard and mutates the visible prompt or image attachment state.',
    };
  }
  if (root === 'profile' || root === 'agent-profile') {
    return {
      confirmation,
      preferredModelTool: 'capability_find and capability_run',
      boundary: 'Agent profile commands manage isolated Agent runtime profiles and starter templates. Mutations require explicit confirmation.',
    };
  }
  if (root === 'qrcode') {
    return {
      confirmation,
      preferredModelTool: agentHarnessModes('run_command'),
      boundary: 'Each run mints a named device token that gives a new device access to the connected host, so only the owner typing the command counts; a model invocation is refused before anything is minted. The Agent does not manage connected-host listener lifecycle.',
    };
  }
  return {
    confirmation,
    boundary: 'Inspect the command description, usage, and action metadata before invoking through run_command.',
  };
}

/**
 * The admission policy of a command, from what its definition declares: the
 * command's `effect` and `readVerbs`, or its per-verb declaration
 * (command-verbs.ts). The notes above only describe routes.
 */
export function describeCommandPolicy(commandName: string, command?: Pick<SlashCommand, 'effect' | 'readVerbs'>): CommandExecutionPolicy {
  return { ...commandModelNotes(commandName), effect: command?.effect ?? 'undeclared',
    ...(command?.readVerbs ? { readVerbs: command.readVerbs } : {}) };
}

export function settingsPolicySummary(): Record<string, unknown> {
  return {
    discovery: 'Use settings action:"list" for the setting catalog and action:"get" with key, target, or query for one setting. Hidden/scriptable settings require includeHidden:true unless the exact key is supplied.',
    mutation: 'Use settings action:"set" or action:"reset" with key, target, or query; the complete resolved effect plan requires current recorded admission. Ambiguous lookups are refused.',
    secretHandling: 'Raw secret values require the secure provisioning path and are refused before judgment, including through aliases. Stored references are opaque; reset/clear captures exact scoped secret deletion.',
    writablePolicy: 'Each setting descriptor includes writable and onSettingsScreen. Managed or read-only owners refuse mutations. The current source, privacy floor and recorded permission decision govern every proposed effect.',
  };
}
