import { createWelcomeCommand } from '@goodvibes-jev/engine/terminal-shell/entry-workspace-commands';
import { estimateConversationTokens } from '@goodvibes-jev/engine/platform/platform/core';
import { evaluateSessionMaintenance, formatSessionMaintenanceLines, getGuidanceMode } from '@/runtime/index.ts';
import { dismissGuidance, evaluateContextualGuidance, formatGuidanceItems, resetGuidance } from '@/runtime/index.ts';
import type { GuidancePersistenceOptions } from '@/runtime/index.ts';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireReadModels, requireSessionMemoryStore, requireShellPaths } from './runtime-services.ts';

/** The guidance items active now, with the maintenance reading they were built from. */
function currentGuidance(ctx: CommandContext, guidanceOptions: GuidancePersistenceOptions) {
  const llmMessages = ctx.session.conversationManager.getMessagesForLLM();
  const readModels = requireReadModels(ctx);
  const session = readModels.session.getSnapshot();
  const intelligence = readModels.intelligence.getSnapshot();
  const mcp = readModels.mcp.getSnapshot();
  const health = readModels.health.getSnapshot();
  const marketplace = readModels.marketplace.getSnapshot();
  const maintenance = evaluateSessionMaintenance({
    configManager: ctx.platform.configManager,
    currentTokens: estimateConversationTokens(llmMessages),
    contextWindow: ctx.provider.providerRegistry.getKnownContextWindowForModel(ctx.provider.providerRegistry.getCurrentModel()) ?? 0,
    messageCount: llmMessages.length,
    sessionMemoryCount: requireSessionMemoryStore(ctx).list().length,
    session: session.session,
  });
  const authRequiredMcpServers = mcp.servers.filter((server) => server.status === 'auth_required').map((server) => server.name);
  const items = evaluateContextualGuidance(
    ctx.platform.configManager,
    {
      pendingApproval: session.pendingApproval,
      denialCount: session.denialCount,
      authRequiredMcpCount: authRequiredMcpServers.length,
      authRequiredMcpServers,
      degradedProviderCount: health.providerProblems.length,
      degradedProviders: health.providerProblems,
      intelligenceUnavailable: intelligence.diagnosticsStatus === 'unavailable' && intelligence.symbolSearchStatus === 'unavailable',
      recommendations: marketplace.recommendations,
      sessionId: session.session.id,
    },
    maintenance,
    guidanceOptions,
  );
  return { items, maintenance };
}

export function registerGuidanceRuntimeCommands(registry: CommandRegistry): void {
  registry.register(welcomeCommand);

  registry.register({
    name: 'guidance',
    description: 'Review contextual operational guidance without interrupting the main conversation flow',
    usage: '[review|dismiss <id>|reset [id]]',
    async handler(args, ctx) {
      const sub = (args[0] ?? 'review').toLowerCase();
      const shellPaths = requireShellPaths(ctx);
      const guidanceOptions = {
        homeDirectory: shellPaths.homeDirectory,
        surfaceRoot: 'tui',
      };
      if (sub === 'dismiss') {
        const id = args[1];
        if (!id) {
          ctx.print('Usage: /guidance dismiss <id>');
          return;
        }
        // A dismissal hides the occurrence showing now; the same condition coming back later shows again.
        const item = currentGuidance(ctx, guidanceOptions).items.find((candidate) => candidate.id === id);
        if (!item) {
          ctx.print(`Guidance item ${id} is not showing now, so there is nothing to dismiss. /guidance lists the items that are.`);
          return;
        }
        if (!dismissGuidance(item, guidanceOptions)) {
          ctx.print(`Could not save the dismissal of guidance item ${id}: the guidance store is busy or unreadable, so nothing was changed. Try again.`);
          return;
        }
        ctx.print(`Dismissed guidance item ${id}. It shows again if the condition comes back.`);
        return;
      }
      if (sub === 'reset') {
        if (!resetGuidance(args[1], guidanceOptions)) {
          ctx.print('Could not reset guidance: the guidance store is busy or unreadable, so nothing was changed. Try again.');
          return;
        }
        ctx.print(args[1] ? `Reset guidance item ${args[1]}.` : 'Reset all dismissed guidance items.');
        return;
      }
      if (sub !== 'review') {
        ctx.print('Usage: /guidance [review|dismiss <id>|reset [id]]');
        return;
      }

      const { items, maintenance } = currentGuidance(ctx, guidanceOptions);
      ctx.print(
        [
          `Guidance Review (${getGuidanceMode(ctx.platform.configManager)})`,
          '',
          ...formatGuidanceItems(items),
          '',
          ...formatSessionMaintenanceLines(maintenance, maintenance.guidanceMode === 'guided' ? 'guided' : 'minimal'),
        ].join('\n'),
      );
    },
  });
}

const welcomeCommand = createWelcomeCommand<CommandContext>({
  description: 'Open the product entry point for the onboarding wizard, security, marketplace, remote, and operator workflows',
  open(ctx) {
    if (ctx.openOnboardingWizard) {
      ctx.openOnboardingWizard({ mode: 'edit' });
      return;
    }
    ctx.print('Use /onboarding to open the setup wizard.');
    return;
  },
  lines: [
    'Welcome To GoodVibes',
    '  /onboarding         - open the onboarding wizard with current settings preloaded',
    '  /setup onboarding   - open the same onboarding wizard from setup workflows',
    '  /health review      - unified startup, service, and sandbox posture',
    '  /sandbox review     - inspect VM isolation posture',
    '  /marketplace open   - browse curated plugins, skills, hook packs, and policy packs',
    '  /remote setup       - review bridge, tunnel, env, and bootstrap flows',
    '  /security           - review trust posture, policy pressure, and incidents',
    '  /cockpit            - unified operator control room',
  ],
});
