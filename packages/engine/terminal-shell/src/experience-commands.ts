import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ConfigKey, ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { localOwnerActor } from '@goodvibes/engine/platform/platform/config';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import { defineCommand, type DescribedCommand } from './command-actions/define.js';
import type { ActionDescription, ActionValues, CommandActionContext } from './command-actions/types.js';
import { doAction, readAction } from './described-command-kit.js';
import { readRefusal } from '@goodvibes/engine/errors';
import { commandRefusal } from './command-confirmation.js';
import { daemonCapabilityAction, runDaemonCapability, sessionCapabilityAction, type DaemonCapabilityBinding } from './command-actions/capability-actions.js';
import {
  VOICE_OFF, VOICE_ON, VOICE_REVIEW, VOICE_SETUP, VOICE_SPEAK, VOICE_STATUS, VOICE_STOP, VOICE_WAKE_AGAIN, VOICE_WAKE_SETUP, VOICE_WAKE_STATUS,
  type CapabilityDefinition, type SystemSessionServices,
} from '@goodvibes/engine/platform/platform/capabilities';
import { printedText } from './health-command.js';
import { inspectVoiceBundle, isVoiceBundleKey, readVoiceBundle, type VoiceBundle } from './voice-settings-review.js';
export interface VoiceContext extends CommandActionContext {
  readonly platform: { readonly configManager: Pick<ConfigManager, 'get' | 'setDynamic' | 'setMany' | 'getSchema'>; readonly voiceService?: unknown };
  /** Returns whether anything was playing; a port that returns nothing is treated as having stopped playback. */
  readonly stopSpokenOutput?: (() => boolean | void) | undefined;
  readonly submitSpokenInput?: ((prompt: string) => void) | undefined;
  readonly listenForWakeAgain?: (() => Promise<string>) | undefined;
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
  /** This program's own services: speaking and listening run here (capabilities/builtin/system-session.ts). */
  readonly services: (context: Context) => SystemSessionServices;
  /** How this program reaches the daemon for a capability (its `capability-binding.ts`): the voice runtime is the daemon's. */
  readonly capability: DaemonCapabilityBinding<Context>;
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
  const speaking = (definition: CapabilityDefinition<SystemSessionServices>): ActionDescription<Context> =>
    sessionCapabilityAction<Context, SystemSessionServices>(definition, policy.services, VOICE_LOCAL);
  const runtime = (definition: CapabilityDefinition<never>, sub: 'status' | 'setup'): ActionDescription<Context> => ({
    ...daemonCapabilityAction<Context>(definition, policy.capability),
    run: guarded(async (values, ctx) => {
      if (ctx.invokedByModel !== true && ctx.printLive) { await policy.provision(sub, [], ctx, policy.paths(ctx)); return; }
      const answer = await runDaemonCapability(definition.capability.id, values, ctx, policy.capability);
      return answer.detail ?? '';
    }),
  });
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
      { label: 'The wake word…', actions: ['wake-status', 'wake-setup', 'wake-again'] },
      { label: 'Voice settings as a file…', actions: ['export', 'inspect', 'import'] },
    ],
    actions: [
      // Speaking and listening are capabilities of this program (capabilities/builtin/system-session.ts).
      { ...speaking(VOICE_REVIEW), async rowValue(ctx: Context) { return ctx.platform.configManager.get('ui.voiceEnabled') ? 'answers spoken' : 'answers not spoken'; } },
      speaking(VOICE_SPEAK),
      speaking(VOICE_STOP),
      speaking(VOICE_ON),
      speaking(VOICE_OFF),
      // The voice runtime is the daemon's (capabilities/builtin/system.ts voice.status, voice.setup). A person typing it at
      // a terminal that can redraw a line also sees an install's progress (the same voice.local.* methods, followed on
      // screen); a place, a model and a script get the capability's answer.
      runtime(VOICE_STATUS, 'status'),
      runtime(VOICE_SETUP, 'setup'),
      // The wake word on this terminal's microphone (capabilities/builtin/system-program.ts; `wakeServicesOf` below).
      speaking(VOICE_WAKE_STATUS),
      speaking(VOICE_WAKE_SETUP),
      speaking(VOICE_WAKE_AGAIN),
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

/** What one program supplies for `/voice` (its wake word, its runtime's progress, its services, its daemon binding). */
export type VoiceExperiencePolicy<Context extends VoiceContext> = Parameters<typeof createVoiceExperienceCommand<Context>>[0];

/**
 * The wake word on this program's microphone, as the capabilities `voice.wake-status` and `voice.wake-setup` take it
 * (system-session.ts `speech.wake`): the program's own wake work, its printed lines returned as words.
 */
export function wakeServicesOf<Context extends VoiceContext>(
  policy: { readonly paths: (context: Context) => ShellPathService; readonly wake: (args: string[], ctx: Context, shellPaths: ShellPathService) => void | Promise<void> },
  ctx: Context,
): { status(): Promise<string>; setup(withSpeechToText: boolean): Promise<string> } {
  return {
    status: () => printedText(ctx, (collecting) => policy.wake(['wake', 'status'], collecting, policy.paths(collecting))),
    setup: (withSpeechToText) => printedText(ctx, (collecting) => policy.wake(['wake', 'setup', ...(withSpeechToText ? ['yes'] : [])], collecting, policy.paths(collecting))),
  };
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
