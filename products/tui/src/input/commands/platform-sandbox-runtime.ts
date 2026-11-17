import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import {
  buildSandboxReview,
  getSandboxPreset,
  inspectSandboxProbe,
  renderSandboxPresets,
  renderSandboxProfiles,
  renderSandboxRecommendation,
  renderSandboxReview,
  type SandboxProbe,
} from '@goodvibes-jev/engine/platform/platform/runtime/sandbox';
import { renderSandboxDoctor } from '../../runtime/sandbox-public-gaps.ts';
import { handleSandboxSessionCommand } from './platform-sandbox-session.ts';

const SANDBOX_USAGE = '[open|review|recommend|profiles|presets|preset <id>|apply-preset <id>|probe|doctor|session ...|set-mcp <disabled|contained>]';
const PRESET_IDS = 'contained|host-mcp';

function applySandboxPreset(
  configManager: CommandContext['platform']['configManager'],
  presetId: string,
): boolean {
  const preset = getSandboxPreset(presetId);
  if (!preset) return false;
  configManager.setDynamic('sandbox.mcpIsolation', preset.config.mcpIsolation);
  return true;
}

function renderSandboxPresetDetail(presetId: string): string | null {
  const preset = getSandboxPreset(presetId);
  if (!preset) return null;
  return [
    `Sandbox Preset ${preset.id}`,
    `  label: ${preset.label}`,
    `  summary: ${preset.summary}`,
    `  mcp isolation: ${preset.config.mcpIsolation}`,
    ...preset.notes.map((note) => `  note: ${note}`),
  ].join('\n');
}

export function registerPlatformSandboxRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'sandbox',
    description: 'Review the command and MCP server boundary, and choose whether MCP servers run contained',
    usage: SANDBOX_USAGE,
    async handler(args, ctx) {
      const sub = args[0] ?? 'open';
      if (sub === 'open' || sub === 'panel') {
        ctx.openModal?.('sandbox-modal');
        return;
      }
      if (sub === 'review') {
        ctx.print(renderSandboxReview(ctx.platform.configManager));
        return;
      }
      if (sub === 'recommend') {
        ctx.print(renderSandboxRecommendation(ctx.platform.configManager));
        return;
      }
      if (sub === 'profiles') {
        ctx.print(renderSandboxProfiles(ctx.platform.configManager));
        return;
      }
      if (sub === 'presets') {
        ctx.print(renderSandboxPresets());
        return;
      }
      if (sub === 'preset') {
        const rendered = args[1] ? renderSandboxPresetDetail(args[1]) : null;
        ctx.print(rendered ?? `Usage: /sandbox preset <${PRESET_IDS}>`);
        return;
      }
      if (sub === 'apply-preset') {
        const ok = args[1] ? applySandboxPreset(ctx.platform.configManager, args[1]) : false;
        ctx.print(ok ? `Applied sandbox preset ${args[1]}; MCP servers pick it up when they next connect (/mcp reload).` : `Usage: /sandbox apply-preset <${PRESET_IDS}>`);
        return;
      }
      if (sub === 'probe') {
        const review = buildSandboxReview(ctx.platform.configManager);
        const probe: SandboxProbe = {
          version: 1,
          checkedAt: Date.now(),
          host: review.host.platform,
          currentBackend: review.backendProbe?.resolvedBackend ?? 'host',
          mcpIsolation: review.config.mcpIsolation,
          secureSandboxReady: review.host.secureSandboxReady,
          recommendedCommand: '/sandbox doctor',
        };
        ctx.print([
          inspectSandboxProbe(probe),
          ...review.host.warnings.map((warning) => `  warning: ${warning}`),
        ].join('\n'));
        return;
      }
      if (sub === 'doctor') {
        ctx.print(renderSandboxDoctor(ctx.platform.configManager));
        return;
      }
      // Keep an explicit migration response for old command invocations. No
      // guest provisioning, wrapper execution or retired setting writes remain.
      if (sub === 'qemu' || sub.startsWith('set-qemu-') || ['init-qemu', 'scaffold-qemu-wrapper', 'wrapper-test', 'guest-test', 'guest-bundle'].includes(sub)) {
        ctx.print('QEMU sandbox commands have been retired: processes are contained with bubblewrap instead. Use /sandbox review or /sandbox session.');
        return;
      }
      if (sub === 'session') {
        await handleSandboxSessionCommand(args, ctx);
        return;
      }
      if (sub === 'set-mcp') {
        const mode = args[1];
        if (mode !== 'disabled' && mode !== 'contained') {
          ctx.print('Usage: /sandbox set-mcp <disabled|contained>');
          return;
        }
        ctx.platform.configManager.setDynamic('sandbox.mcpIsolation', mode);
        const ready = buildSandboxReview(ctx.platform.configManager).host.secureSandboxReady;
        ctx.print(mode === 'disabled'
          ? 'MCP servers will run as host processes when they next connect (/mcp reload).'
          : ready
            ? 'MCP servers will each start inside their own bubblewrap boundary when they next connect (/mcp reload).'
            : 'Saved, but this host has no bubblewrap: a stdio MCP server will not start until bubblewrap is installed or this is set back to disabled.');
        return;
      }
      ctx.print(`Usage: /sandbox ${SANDBOX_USAGE}\n  The sandbox review, recommendation and profiles for a support thread are in /setup support-bundle <dir> (platform-review.json).`);
    },
  });
}
