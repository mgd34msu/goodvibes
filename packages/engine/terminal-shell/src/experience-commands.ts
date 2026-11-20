import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ConfigKey, ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { localOwnerActor } from '@goodvibes/engine/platform/platform/config';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import { defineCommand, type DescribedCommand } from './command-actions/define.js';
import type { ActionValues, CommandActionContext, FixedChoice } from './command-actions/types.js';
import { choiceInput, doAction, readAction, textInput } from './described-command-kit.js';
import { readRefusal } from '@goodvibes/engine/errors';
import { commandRefusal } from './command-confirmation.js';
import { switchAlwaysSpeak } from './tts-runtime-commands.js';
import { inspectVoiceBundle, isVoiceBundleKey, readVoiceBundle, type VoiceBundle } from './voice-settings-review.js';
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
interface VoiceContext extends CommandActionContext {
  readonly platform: { readonly configManager: Pick<ConfigManager, 'get' | 'setDynamic' | 'setMany' | 'getSchema'>; readonly voiceService?: unknown };
  /** Returns whether anything was playing; a port that returns nothing is treated as having stopped playback. */
  readonly stopSpokenOutput?: (() => boolean | void) | undefined;
  readonly submitSpokenInput?: ((prompt: string) => void) | undefined;
  readonly renderRequest: () => void;
}

const VOICE_LOCAL = { terminalOnly: 'Voice runs in the terminal app.' } as const;
const BUNDLE_FILE = (help: string) => ({
  id: 'path', label: 'File', help, kind: 'path' as const, freeTextReason: 'a file path', required: true as const, typed: { position: 1 as const },
});

/**
 * `/voice`, described once (command-actions/) for both terminal apps: hear an
 * answer spoken, speak every answer, stop what is playing, the local voice
 * runtime and the wake word, and the voice settings as a file. Each app
 * supplies how it reads and sets up its voice runtime and wake word.
 */
export function createVoiceExperienceCommand<Context extends VoiceContext>(policy: {
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
}): DescribedCommand<Context> {
  /** A failure that is not a refusal is reported as one, where the app asks for that. */
  const guarded = (work: (values: ActionValues, ctx: Context) => Promise<string | void>) => async (values: ActionValues, ctx: Context): Promise<string | void> => {
    try {
      return await work(values, ctx);
    } catch (error) {
      if (!policy.reportFailure || readRefusal(error)) throw error;
      throw commandRefusal('voice command failed: ' + (error instanceof Error ? error.message : String(error)));
    }
  };
  const alwaysSpeak = (enabled: boolean) => async (_values: ActionValues, ctx: Context): Promise<string> => {
    const said = switchAlwaysSpeak(ctx, enabled);
    ctx.renderRequest();
    return said;
  };
  return defineCommand<Context>({
    name: 'voice',
    leadingFlagsOnly: true,
    title: 'Voice',
    summary: 'Hear answers spoken, set up the local voice runtime and the wake word, and keep the voice settings as a file',
    group: 'Experience',
    report: 'review',
    firstScreenRows: [
      'review', 'speak', 'stop', 'on', 'off',
      { label: 'The local voice runtime…', actions: ['status', 'setup'] },
      { label: 'The wake word…', actions: ['wake-status', 'wake-setup'] },
      { label: 'Voice settings as a file…', actions: ['export', 'inspect', 'import'] },
    ],
    actions: [
      readAction<Context>({
        id: 'review', label: 'See your voice settings', readsOnlyThisMachine: true, word: 'review', operator: VOICE_LOCAL,
        sentence: 'Shows whether every answer is spoken aloud and how voice is set up here.',
        async rowValue(ctx) { return ctx.platform.configManager.get('ui.voiceEnabled') ? 'answers spoken' : 'answers not spoken'; },
        async run(_values, ctx) { return policy.review(Boolean(ctx.platform.configManager.get('ui.voiceEnabled') ?? false)).join('\n'); },
      }),
      doAction<Context>({
        id: 'speak', label: 'Ask and hear the answer spoken', word: 'speak', touches: 'another-machine', operator: VOICE_LOCAL,
        inputs: [textInput({ id: 'prompt', label: 'Message', help: 'What to ask', why: 'your own words', kind: 'long-text', typed: { tail: true } })],
        sentence: '{prompt} is sent as a message and the answer is played aloud.', example: { prompt: 'summarise the last change' },
        async run(values, ctx) {
          if (!ctx.submitSpokenInput) throw commandRefusal('Speech output is not available in this session; nothing was sent.', undefined, 'UNAVAILABLE');
          ctx.submitSpokenInput(values.prompt!);
        },
      }),
      doAction<Context>({
        id: 'stop', label: 'Stop what is being spoken', word: 'stop', operator: VOICE_LOCAL,
        sentence: 'Whatever is being played aloud now stops.',
        async run(_values, ctx) {
          if (!ctx.stopSpokenOutput) throw commandRefusal('Speech output is not available in this session.', undefined, 'UNAVAILABLE');
          return ctx.stopSpokenOutput() === false ? 'Nothing is playing.' : 'Stopped speaking.';
        },
      }),
      {
        id: 'on', label: 'Speak every answer aloud', word: 'on', inputs: [],
        sentence: 'Every answer will be played aloud until you change it.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'off', operator: VOICE_LOCAL, example: {},
        run: alwaysSpeak(true),
      },
      {
        id: 'off', label: 'Stop speaking every answer', word: 'off', inputs: [],
        sentence: 'Answers will no longer be played aloud, until you change it.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'on', operator: VOICE_LOCAL, example: {},
        run: alwaysSpeak(false),
      },
      readAction<Context>({
        id: 'status', label: 'See the local voice runtime', word: 'status', operator: VOICE_LOCAL,
        sentence: 'Shows whether speech output and speech-to-text are installed here, and an install in progress.',
        run: guarded(async (_values, ctx) => { await policy.provision('status', [], ctx, policy.paths(ctx)); }),
      }),
      doAction<Context>({
        id: 'setup', label: 'Install the local voice runtime', word: 'setup', touches: 'another-machine', operator: VOICE_LOCAL,
        sentence: 'The local speech output and, where this machine has a published bundle, speech-to-text are downloaded and set up; it can be hundreds of megabytes.',
        run: guarded(async (_values, ctx) => { await policy.provision('setup', [], ctx, policy.paths(ctx)); }),
      }),
      readAction<Context>({
        id: 'wake-status', label: 'See wake-word detection', word: 'wake-status', operator: VOICE_LOCAL,
        sentence: 'Shows whether the wake-word models are here and how listening for the wake word is set.',
        run: guarded(async (_values, ctx) => { await policy.wake(['wake', 'status'], ctx, policy.paths(ctx)); }),
      }),
      doAction<Context>({
        id: 'wake-setup', label: 'Set up the wake word', word: 'wake-setup', touches: 'another-machine', operator: VOICE_LOCAL,
        inputs: [choiceInput({
          id: 'stt', label: 'Speech-to-text', help: 'What makes a wake word useful', typed: { flag: '--with-speech-to-text', switchOn: 'yes' },
          choices: [{ value: 'no', label: 'Only say whether it is needed' }, { value: 'yes', label: 'Install it too' }],
          optional: { default: 'no', means: 'only say whether it is needed' },
        })],
        sentence: 'The wake-word models are downloaded and checked, and speech-to-text is installed too when chosen.', example: { stt: 'yes' },
        run: guarded(async (values, ctx) => { await policy.wake(['wake', 'setup', ...(values.stt === 'yes' ? ['yes'] : [])], ctx, policy.paths(ctx)); }),
      }),
      doAction<Context>({
        id: 'export', label: 'Save your voice settings to a file', word: 'export', operator: VOICE_LOCAL,
        inputs: [BUNDLE_FILE('Where to write them')],
        sentence: 'The voice settings you changed from their defaults are written to {path}.', example: { path: 'voice.json' },
        run: guarded(async (values, ctx) => {
          const target = policy.paths(ctx).resolveWorkspacePath(values.path!);
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
          return `Voice settings written to ${target} (${Object.keys(settings).length} changed voice setting${Object.keys(settings).length === 1 ? '' : 's'}).`;
        }),
      }),
      readAction<Context>({
        id: 'inspect', label: 'Read a voice settings file', word: 'inspect', operator: VOICE_LOCAL,
        inputs: [BUNDLE_FILE('The file to read')],
        sentence: 'Shows the settings in {path} without applying them.', example: { path: 'voice.json' },
        run: guarded(async (values, ctx) => inspectVoiceBundle(readBundleFile(policy.paths(ctx).resolveWorkspacePath(values.path!)))),
      }),
      {
        id: 'import', label: 'Apply voice settings from a file', word: 'import', inputs: [BUNDLE_FILE('The file to apply')],
        sentence: 'The voice settings in {path} are applied until you change it.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none', operator: VOICE_LOCAL, example: { path: 'voice.json' },
        run: guarded(async (values, ctx) => {
          const target = policy.paths(ctx).resolveWorkspacePath(values.path!);
          const read = readVoiceBundle(readBundleFile(target));
          if ('problem' in read) throw commandRefusal('Nothing was applied. ' + read.problem);
          const changes = Object.entries(read.bundle.settings).map(([key, setting]) => ({ key: key as ConfigKey, value: setting }));
          const result = ctx.platform.configManager.setMany(changes, localOwnerActor());
          if (!result.ok) throw commandRefusal(`Voice settings not applied: ${result.refusal.reason}`, result.refusal.next.join(' ') || undefined);
          // The daemon's settings in the file went to it as one update; it is applied only once the daemon took it.
          const refused = result.pending ? await result.pending.settle() : [];
          if (refused.length > 0) {
            const first = refused[0]!;
            const kept = result.saved.length - refused.length;
            throw commandRefusal(`Voice settings not fully applied: the daemon refused ${refused.map(refusal => refusal.key).join(', ')} (${first.error instanceof Error ? first.error.message : String(first.error)}), which keep their previous values${kept > 0 ? `; the other ${kept} setting${kept === 1 ? ' was' : 's were'} saved` : ''}.`);
          }
          return `Voice settings applied: ${result.saved.length} setting${result.saved.length === 1 ? '' : 's'} from ${target}.`;
        }),
      },
    ],
  });
}

/** A voice settings file as JSON; refused when it is missing or unreadable. */
function readBundleFile(target: string): unknown {
  if (!existsSync(target)) throw commandRefusal('File not found: ' + target);
  try {
    return JSON.parse(readFileSync(target, 'utf-8'));
  } catch (error) {
    throw commandRefusal('Could not read the voice settings file: ' + (error instanceof Error ? error.message : String(error)));
  }
}
