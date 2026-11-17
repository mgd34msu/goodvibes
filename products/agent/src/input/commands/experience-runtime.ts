import {
  createApprovalMatrixCommand,
  COMMON_APPROVAL_SUMMARIES,
  createVoiceExperienceCommand,
} from '@goodvibes-jev/engine/terminal-shell/experience-commands';
import '@goodvibes-jev/engine/terminal-shell/voice-settings-review';
import 'node:fs';
import 'node:path';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireShellPaths, requireVoiceSetup } from './runtime-services.ts';
import { commandRefusal, requireYesFlag } from './confirmation.ts';
import { handleApprovalOperatorAction } from './operator-actions-runtime.ts';
import { resolveWakeRuntimeSettings } from '@goodvibes-jev/engine/platform/platform/voice/wake/runtime';
import {
  agentWakeCapabilities,
  wakeStatusLines,
  WAKE_SETUP_ANNOUNCEMENT,
} from '../../core/wake-provision-status.ts';
import { proposesSpeechToText, runWakeSetupPlan } from '../../core/wake-setup-plan.ts';
import { readRefusal } from '@goodvibes-jev/engine/errors';

function formatVoiceComponentState(state: string): string {
  return state.replace(/[_-]+/g, ' ');
}

interface VoiceInstallProgressComponentLike {
  readonly component: string;
  readonly phase: string;
  readonly message?: string | undefined;
  readonly bytesTotal?: number | undefined;
  readonly bytesDone?: number | undefined;
}

interface VoiceInstallProgressLike {
  readonly startedAt: number;
  readonly components: readonly VoiceInstallProgressComponentLike[];
}

/** One honest line per install component: phase plus byte sizes where the manifest knows them. */
function formatVoiceInstallProgressLine(component: VoiceInstallProgressComponentLike): string {
  const mb = (n: number): string => (n / (1024 * 1024)).toFixed(1);
  const bytes =
    component.bytesTotal !== undefined
      ? component.bytesDone !== undefined
        ? ` (${mb(component.bytesDone)} of ${mb(component.bytesTotal)} MB)`
        : ` (${mb(component.bytesTotal)} MB)`
      : '';
  return `  ${component.component}: ${formatVoiceComponentState(component.phase)}${bytes}${component.message ? `, ${component.message}` : ''}`;
}

export function registerExperienceRuntimeCommands(registry: CommandRegistry): void {
  registry.register(approvalMatrixCommand);

  registry.register(voiceExperienceCommand);
}

const approvalMatrixCommand = createApprovalMatrixCommand<CommandContext>({
  usage: '[matrix|review <kind>|approve <id> --yes|deny <id> --yes|cancel <id> --yes]',
  help: 'Usage: /approval [matrix|review <kind>|approve <id> --yes|deny <id> --yes|cancel <id> --yes]',
  hidden: true,
  matrix: [
    ['shell', COMMON_APPROVAL_SUMMARIES.shell],
    ['file', COMMON_APPROVAL_SUMMARIES.file],
    ['network', COMMON_APPROVAL_SUMMARIES.network],
    ['delegate', 'Explicit GoodVibes TUI build delegation approval; Agent-owned job fanout is blocked.'],
    ['mcp', COMMON_APPROVAL_SUMMARIES.mcp],
    ['remote', COMMON_APPROVAL_SUMMARIES.remote],
    ['hook', COMMON_APPROVAL_SUMMARIES.hook],
    ['plugin', COMMON_APPROVAL_SUMMARIES.plugin],
  ] as const,
  related: '  Related workspaces: /security, /trust, /mcp',
  open(ctx) {
    ctx.print(
      'Open Agent Workspace -> Work & Approvals -> Review approval class for the workspace view, or run /approval matrix for the compact command output.',
    );
    return;
  },
  action: handleApprovalOperatorAction,
});
const voiceExperienceCommand = createVoiceExperienceCommand<CommandContext>({
  description:
    'Review or toggle always-speak mode, manage the managed local-voice runtime and the wake-word models, and export or import the voice settings',
  usage:
    '[review|status|setup --yes|enable|disable|wake status|wake setup --yes [yes]|bundle export <path> --yes|bundle inspect <path>|bundle import <path> --yes]',
  help: 'Usage: /voice [review|status|setup --yes|enable|disable|wake status|wake setup --yes [yes]|bundle export <path> --yes|bundle inspect <path>|bundle import <path> --yes]',
  reportFailure: true,
  paths: requireShellPaths,
  async wake(args, ctx, _shellPaths, yes) {
    // Wake artifacts live under the same managed voice root as the local
    // runtime, in its `wake` subdirectory, and are served by the same
    // voiceSetup service, so this reads and provisions through the platform's
    // own wake service rather than a second provisioning path. Nothing
    // downloads unless the user typed `setup --yes`.
    const voiceSetup = requireVoiceSetup(ctx);
    const wakeSub = (args[1] ?? 'status').toLowerCase();
    // Read the artifact state BEFORE resolving: whether the speech gate is on
    // disk decides whether voice.wake.vadThreshold above 0 is honoured or
    // refused, so resolving first would report a blocker that does not match
    // what /voice wake setup has already downloaded.
    const status = voiceSetup.wakeStatus();
    const settings = resolveWakeRuntimeSettings(
      (key: string) => ctx.platform.configManager.get(key as Parameters<typeof ctx.platform.configManager.get>[0]),
      'agent',
      agentWakeCapabilities({ vadReady: status.vadReady }),
    );
    if (wakeSub === 'status') {
      ctx.print(['Wake-Word Detection', ...wakeStatusLines(status, settings)].join('\n'));
      return;
    }
    if (wakeSub === 'setup') {
      if (!yes) {
        requireYesFlag(ctx, 'download the pinned wake-word classifier and speech-embedding front end (~3.7 MB)', '/voice wake setup --yes');
        return;
      }
      // The platform's voice setup: this surface listens for the wake word,
      // the models are fetched, and speech-to-text (what makes a wake word
      // useful) is proposed, or installed when the answer `yes` was given.
      // The command ends when the work does, so whoever ran it (the owner or
      // the model) gets the outcome; the owner's composer is not held by it.
      ctx.print(WAKE_SETUP_ANNOUNCEMENT);
      try {
        const outcome = await runWakeSetupPlan(voiceSetup, args[2]?.toLowerCase() === 'yes');
        const proposesStt = proposesSpeechToText(outcome);
        ctx.print(['Wake-Word Setup', outcome.rendered, ...(proposesStt ? ['(yes: /voice wake setup --yes yes installs it now)'] : [])].join('\n'));
      } catch (error) {
        if (readRefusal(error)) throw error;
        throw commandRefusal(`Wake-Word Setup\n  setup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    throw commandRefusal('Usage: /voice wake [status|setup --yes]');
  },
  async provision(sub, _args, ctx, _shellPaths, yes) {
    if (sub === 'status') {
      const status = requireVoiceSetup(ctx).status();
      // Live install progress: voice.local.status carries an
      // installInProgress section only while an install run is active
      // (platform 5357f09e); absent means no run (or an older host build) and
      // nothing renders, never a fabricated progress view.
      const installInProgress: VoiceInstallProgressLike | undefined = status.installInProgress;
      ctx.print(
        [
          'Managed Local-Voice Status',
          `  platform: ${status.platform ?? 'unknown'}`,
          `  state: ${formatVoiceComponentState(status.state)}`,
          `  tts (${status.tts.engine}): binary ${status.tts.binaryPresent ? 'present' : 'missing'}, voice ${status.tts.voicePresent ? 'present' : 'missing'}`,
          `  stt (${status.stt.engine}): ${status.stt.supported ? formatVoiceComponentState(status.stt.state) : 'not supported on this build'}${status.stt.reason ? ` (${status.stt.reason})` : ''}`,
          ...(status.offerBytes != null ? [`  install size ~${Math.round(status.offerBytes / (1024 * 1024))} MB`] : []),
          ...(installInProgress
            ? [
                `  install in progress (started ${new Date(installInProgress.startedAt).toISOString()})`,
                ...installInProgress.components.map((component) => `  ${formatVoiceInstallProgressLine(component)}`),
              ]
            : ['  next /voice setup --yes']),
        ].join('\n'),
      );
      return;
    }
    if (sub === 'setup') {
      if (!yes) {
        requireYesFlag(ctx, 'install the managed local-voice runtime (downloads piper TTS + a default voice)', '/voice setup --yes');
        return;
      }
      const voiceSetup = requireVoiceSetup(ctx);
      // install() is single-flight: a second run joins the one in progress and
      // gets the same receipt. The command ends when the install does, so
      // whoever ran it (the owner or the model) gets the receipt; the owner's
      // composer is not held by it.
      ctx.print('Installing managed local-voice runtime...');
      // Live per-component progress from voice.local.status while the install
      // runs (an older host build whose status carries no installInProgress
      // section shows only the line above until the receipt). The poll ends
      // with the install.
      let installSettled = false;
      const renderedProgress = new Map<string, string>();
      const pollInstallProgress = async (): Promise<void> => {
        while (!installSettled) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          if (installSettled) return;
          try {
            const progress: VoiceInstallProgressLike | undefined = voiceSetup.status().installInProgress;
            if (!progress) continue;
            for (const component of progress.components) {
              const line = formatVoiceInstallProgressLine(component);
              if (renderedProgress.get(component.component) !== line) {
                renderedProgress.set(component.component, line);
                ctx.print(line);
              }
            }
          } catch {
            // A failed status read must never break the running install.
          }
        }
      };
      void pollInstallProgress();
      try {
        const result = await voiceSetup.install();
        ctx.print([
          'Managed Local-Voice Setup',
          ...result.components.map(
            (component) =>
              `  ${component.id}: ${formatVoiceComponentState(component.state)}${component.error ? ` (${component.error})` : ''}`,
          ),
          `  tts (${result.tts.engine}): ${formatVoiceComponentState(result.tts.state)}${result.tts.reason ? ` (${result.tts.reason})` : ''}`,
          // STT (whisper.cpp) provisions only where goodvibes has published a
          // pinned per-platform bundle; elsewhere it reports its real state.
          `  stt (${result.stt.engine}): ${formatVoiceComponentState(result.stt.state)}${result.stt.reason ? ` (${result.stt.reason})` : ''}`,
          `  result: ${result.provisioned ? 'voice.local.* configured' : 'not provisioned'}`,
          ...result.configured.set.map((entry) => `  set ${entry.key} = ${entry.value}`),
          ...result.configured.skipped.map((entry) => `  skipped ${entry.key} (${entry.reason})`),
        ].join('\n'));
      } catch (error) {
        if (readRefusal(error)) throw error;
        throw commandRefusal(`voice setup failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        installSettled = true;
      }
      return;
    }
  },
  review: (enabled) => [
    'Voice Review',
    `  enabled: ${enabled ? 'yes' : 'no'}`,
    '  posture: optional local companion interaction; disabled by default',
    '  note: voice remains an optional operator convenience, not a required SaaS dependency',
    '  next /voice status',
    '  next /voice setup --yes',
  ],
});
