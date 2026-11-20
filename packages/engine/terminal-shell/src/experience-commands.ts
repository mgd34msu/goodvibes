import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ConfigKey, ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { localOwnerActor } from '@goodvibes-jev/engine/platform/platform/config';
import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import type { TerminalSlashCommand } from './command-registry.js';
import { defineCommand, type DescribedCommand } from './command-actions/define.js';
import type { CommandActionContext, FixedChoice } from './command-actions/types.js';
import { choiceInput, doAction, readAction } from './described-command-kit.js';
import { readRefusal } from '@goodvibes-jev/engine/errors';
import { commandRefusal, stripYesFlag } from './command-confirmation.js';
import { switchAlwaysSpeak } from './tts-runtime-commands.js';
import { inspectVoiceBundle, isVoiceBundleKey, readVoiceBundle, type VoiceBundle } from './voice-settings-review.js';
interface ExperienceContext {
  print(message: string): void;
  readonly platform: { readonly configManager: Pick<ConfigManager, 'get' | 'setDynamic' | 'setMany' | 'getSchema'>; readonly voiceService?: unknown };
}
/** What each kind of approval asks about, the same words in both terminal apps. */
const APPROVAL_KINDS: readonly FixedChoice[] = [
  { value: 'shell', label: 'Running a command', help: 'What the command changes, and whether it reads a credential.' },
  { value: 'file', label: 'Changing a file', help: 'Which file, and whether it is a settings file or a notebook.' },
  { value: 'network', label: 'Reaching the network', help: 'Which host, and how much of it.' },
  { value: 'delegate', label: 'Starting agents or handing work on', help: 'How many agents, and how deep they may start more.' },
  { value: 'mcp', label: 'Trusting a connected tool server more', help: 'Which server, and which hosts and paths it may then reach.' },
  { value: 'remote', label: 'Sending work to another machine', help: 'Which machine, how far it is trusted, and what comes back.' },
  { value: 'hook', label: 'Running a hook', help: 'Whether the hook may refuse or change what it sees.' },
  { value: 'plugin', label: 'Installing or switching on a plugin', help: 'Where it came from, and what it may do.' },
  { value: 'sandbox', label: 'Changing how commands are contained', help: 'Which isolation, and what leaves it.' },
];

/**
 * `/approval`, described once (command-actions/) for both terminal apps: what
 * each kind of approval asks about, and where the approvals waiting on you
 * are. An approval is answered with `/questions answer`; this command does not
 * answer one a second way.
 */
export function createApprovalCommand<Context extends CommandActionContext>(host: {
  /** Open where this app shows the approvals waiting on you; throws a refusal when it cannot. */
  readonly openWaiting: (context: Context) => void;
}): DescribedCommand<Context> {
  return defineCommand<Context>({
    name: 'approval',
    title: 'Approvals',
    summary: 'What each kind of approval asks about, and the approvals waiting on you',
    group: 'Permissions',
    report: 'kinds',
    actions: [
      readAction<Context>({
        id: 'kinds', label: 'See the kinds of approval', word: 'kinds',
        inputs: [choiceInput({ id: 'kind', label: 'Kind', help: 'One kind only', choices: APPROVAL_KINDS, typed: { position: 1 }, optional: { default: '', means: 'every kind' } })],
        sentence: 'Shows what each kind of approval asks about {kind}, and what to check before you answer one.', example: { kind: 'shell' },
        async run(values) {
          const kinds = values.kind ? APPROVAL_KINDS.filter((kind) => kind.value === values.kind) : APPROVAL_KINDS;
          return [
            'Kinds of approval',
            ...kinds.map((kind) => `  ${kind.label} (${kind.value}): ${kind.help ?? ''}`),
            '',
            'Answer one that waits on you: /questions answer. Rules that answer for you: /permissions.',
          ].join('\n');
        },
      }),
      doAction<Context>({
        id: 'waiting', label: 'Open the approvals waiting on you', word: 'waiting', touches: 'reads',
        sentence: 'Opens the list of approvals waiting on your answer.',
        operator: { method: 'approvals.list', fields: {} },
        async run(_values, ctx) { host.openWaiting(ctx); },
      }),
    ],
  });
}
export function createVoiceExperienceCommand<Context extends ExperienceContext>(policy: {
  readonly description: string;
  readonly usage: string;
  readonly help: string;
  readonly reportFailure: boolean;
  readonly paths: (context: Context) => ShellPathService;
  readonly wake: (args: string[], ctx: Context, shellPaths: ShellPathService) => void | Promise<void>;
  readonly provision: (
    sub: 'status' | 'setup',
    args: string[],
    ctx: Context,
    shellPaths: ShellPathService,
  ) => void | Promise<void>;
  readonly review: (enabled: boolean) => string[];
}): TerminalSlashCommand<Context> {
  return {
    name: 'voice',
    effect: 'mixed',
    description: policy.description,
    usage: policy.usage,
    async handler(args, ctx) {
      try {
        const { rest } = stripYesFlag(args);
        const commandArgs = [...rest],
          shellPaths = policy.paths(ctx),
          sub = (commandArgs[0] ?? 'review').toLowerCase();
        if (sub === 'wake') {
          await policy.wake(commandArgs, ctx, shellPaths);
          return;
        }
        if (sub === 'status' || sub === 'setup') {
          await policy.provision(sub, commandArgs, ctx, shellPaths);
          return;
        }
        if (sub === 'review') {
          ctx.print(policy.review(Boolean(ctx.platform.configManager.get('ui.voiceEnabled') ?? false)).join('\n'));
          return;
        }
        if (sub === 'enable' || sub === 'disable') {
          // Same switch, same rule as /tts on|off: a reversible preference, so no confirmation.
          ctx.print(switchAlwaysSpeak(ctx, sub === 'enable'));
          return;
        }
        if (sub === 'bundle') {
          const mode = commandArgs[1],
            path = commandArgs[2];
          if (mode === 'export' || mode === 'inspect' || mode === 'import') {
            if (!path) {
              throw commandRefusal(`Usage: /voice bundle ${mode} <path>`);
            }
            const target = shellPaths.resolveWorkspacePath(path);
            if (mode === 'export') {
              const config = ctx.platform.configManager;
              const settings: Record<string, unknown> = {};
              for (const setting of config.getSchema()) {
                if (!isVoiceBundleKey(setting.key)) continue;
                const value = config.get(setting.key);
                if (JSON.stringify(value) !== JSON.stringify(setting.default)) settings[setting.key] = value;
              }
              const bundle: VoiceBundle = { version: 2, exportedAt: Date.now(), settings };
              mkdirSync(dirname(target), { recursive: true });
              writeFileSync(target, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
              ctx.print(`Voice bundle exported to ${target} (${Object.keys(settings).length} changed voice setting${Object.keys(settings).length === 1 ? '' : 's'}).`);
              return;
            }
            if (!existsSync(target)) throw commandRefusal('File not found: ' + target);
            let value: unknown;
            try {
              value = JSON.parse(readFileSync(target, 'utf-8'));
            } catch (error) {
              throw commandRefusal('Could not read the voice bundle: ' + (error instanceof Error ? error.message : String(error)));
            }
            if (mode === 'inspect') {
              ctx.print(inspectVoiceBundle(value));
              return;
            }
            const read = readVoiceBundle(value);
            if ('problem' in read) throw commandRefusal('Nothing was applied. ' + read.problem);
            const changes = Object.entries(read.bundle.settings).map(([key, setting]) => ({ key: key as ConfigKey, value: setting }));
            const result = ctx.platform.configManager.setMany(changes, localOwnerActor());
            if (!result.ok) throw commandRefusal(`Voice bundle not applied: ${result.refusal.reason}`, result.refusal.next.join(' ') || undefined);
            // The daemon's settings in the bundle went to it as one update; it is applied only once the daemon took it.
            const refused = result.pending ? await result.pending.settle() : [];
            if (refused.length > 0) {
              const first = refused[0]!;
              const kept = result.saved.length - refused.length;
              throw commandRefusal(`Voice bundle not fully applied: the daemon refused ${refused.map(refusal => refusal.key).join(', ')} (${first.error instanceof Error ? first.error.message : String(first.error)}), which keep their previous values${kept > 0 ? `; the other ${kept} setting${kept === 1 ? ' was' : 's were'} saved` : ''}.`);
            }
            ctx.print(`Voice bundle applied: ${result.saved.length} setting${result.saved.length === 1 ? '' : 's'} from ${target}.`);
            return;
          }
        }
        ctx.print(policy.help);
      } catch (error) {
        // A refusal already says what was not done; anything else is reported as one.
        if (!policy.reportFailure || readRefusal(error)) throw error;
        throw commandRefusal('voice command failed: ' + (error instanceof Error ? error.message : String(error)));
      }
    },
  };
}
