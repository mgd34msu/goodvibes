import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { ContentPart, ProviderApi } from '@goodvibes-jev/engine/sdk/platform/providers';
import { formatModelDiscoveryReport } from '@goodvibes-jev/engine/sdk/platform/providers';
import { resolveAndValidatePath, summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { TerminalSlashCommand } from './command-registry.js';
import type { TerminalConversationManager } from './terminal-conversation.js';
export interface LocalCommandContext {
  readonly print: (message: string) => void;
  readonly renderRequest: () => void;
  readonly submitInput?: ((text: string, content: ContentPart[]) => void) | undefined;
  readonly workspace: { readonly shellPaths?: { readonly workingDirectory: string } | undefined };
  readonly platform: { readonly configManager: { getWorkingDirectory(): string | undefined } };
  readonly session: { readonly conversationManager: TerminalConversationManager };
}
/** Shared local operations; products provide presentation and explicit discovery policy. */
export function createLocalCommandActions<Context extends LocalCommandContext>(
  requireProviderApi: (context: Context) => ProviderApi,
  policy: {
    readonly hidden: boolean;
    readonly liveDiscovery: boolean;
    readonly unpinByModelId: boolean;
    readonly imageHint: string;
    readonly supportedFormats: string;
    readonly maximumImageSize: string;
    readonly partialRefresh: string;
    readonly error: (detail: string) => string;
    readonly imageFailure: (kind: string, detail: string) => string;
    readonly invalidBlockType: (type: string, valid: readonly string[]) => string;
    readonly noteTouch: (conversation: TerminalConversationManager, key: string) => void;
  },
) {
  function toggleBlocks(typeFilter: string, collapsed: boolean, ctx: Context): void {
    const VALID_TYPES = ['all', 'thinking', 'tool', 'code'] as const;
    if (!VALID_TYPES.includes(typeFilter as (typeof VALID_TYPES)[number])) {
      ctx.print(policy.invalidBlockType(typeFilter, VALID_TYPES));
      return;
    }
    const blockRegistry = ctx.session.conversationManager.getBlockRegistry();
    if (!blockRegistry || blockRegistry.length === 0) {
      ctx.print('No blocks found.');
      return;
    }
    let count = 0;
    for (const [i, block] of blockRegistry.entries()) {
      // A merged assistant turn (type 'assistant_turn', see
      // conversation-turn-structure.ts) owns the whole tool subtree beneath its
      // header, so '/expand tool'/'collapse tool' treats it the same as a plain
      // 'tool' block, toggling the header's collapse key shows or hides every
      // tool row underneath it.
      const matchesType =
        typeFilter === 'all' ||
        (typeFilter === 'tool' && (block.type === 'tool' || block.type === 'assistant_turn')) ||
        (typeFilter === 'code' && block.type === 'code') ||
        (typeFilter === 'thinking' && block.type === 'thinking');
      if (!matchesType) continue;
      const isCurrentlyCollapsed = ctx.session.conversationManager.isCollapsed(i);
      if (collapsed ? !isCurrentlyCollapsed : isCurrentlyCollapsed) {
        ctx.session.conversationManager.toggleCollapseAtLine(block.startLine);
        // Expanding a turn also expands each result's own collapse key in the
        // same pass. A result hidden by a collapsed turn pushes no BlockMeta of
        // its own, so it never surfaces from this loop to be toggled
        // individually, without this, '/expand tool' would only open the turn
        // header and each result would still render at its own default collapse
        // state, needing a second pass. '/collapse tool' needs no matching step:
        // collapsing the turn hides every result regardless of its own key.
        if (!collapsed && block.type === 'assistant_turn' && block.groupMemberIndexes) {
          for (const [k, memberIdx] of block.groupMemberIndexes.entries()) {
            const memberKey = block.groupMemberKeys?.[k] ?? `msg_${memberIdx}`;
            ctx.session.conversationManager.setCollapsed(memberKey, false);
            // An explicit /expand is a deliberate user action on this key, same
            // as Tab/Ctrl+Y/Ctrl+B, exempts it from search's close-time
            // auto-re-collapse (see ConversationManager.noteUserTouch).
            policy.noteTouch(ctx.session.conversationManager, memberKey);
          }
        }
        count++;
      }
    }
    ctx.print(
      `${collapsed ? 'Collapsed' : 'Expanded'} ${count} block${count !== 1 ? 's' : ''}${typeFilter !== 'all' ? ` (${typeFilter})` : ''}.`,
    );
    ctx.renderRequest();
  }
  return {
    toggleBlocks,
    image: {
      name: 'image',
      hidden: policy.hidden,
      aliases: ['img'],
      description: 'Attach an image file to the next message',
      usage: '<path> [prompt text]',
      argsHint: policy.imageHint,
      async handler(args: string[], ctx: Context) {
        if (args.length === 0) {
          ctx.print('Usage: /image <path> [prompt text]\nSupported formats: PNG, JPEG, WebP, GIF');
          return;
        }
        const rawPath = args[0];
        if (rawPath === undefined) return;
        const promptText = args.slice(1).join(' ') || `Attached image: ${rawPath.split('/').pop() ?? rawPath}`;
        const projectRoot = ctx.workspace.shellPaths?.workingDirectory ?? ctx.platform.configManager.getWorkingDirectory();
        if (!projectRoot) {
          ctx.print(policy.error('working directory is unavailable.'));
          return;
        }
        let resolvedPath: string;
        try {
          resolvedPath = resolveAndValidatePath(rawPath, projectRoot);
        } catch (err) {
          ctx.print(policy.error(summarizeError(err)));
          return;
        }
        if (!existsSync(resolvedPath)) {
          ctx.print(policy.imageFailure('File not found', rawPath));
          return;
        }
        const ext = resolvedPath.slice(resolvedPath.lastIndexOf('.')).toLowerCase();
        const mediaType = (
          { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' } as Record<
            string,
            string
          >
        )[ext];
        if (!mediaType) {
          ctx.print(policy.imageFailure('Unsupported image format', ext) + policy.supportedFormats);
          return;
        }
        const stat = statSync(resolvedPath);
        if (stat.size > 20 * 1024 * 1024) {
          ctx.print(`Image too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). ${policy.maximumImageSize}`);
          return;
        }
        let data: string;
        try {
          data = (await readFile(resolvedPath)).toString('base64');
        } catch (err) {
          ctx.print(policy.imageFailure('Failed to read image', summarizeError(err)));
          return;
        }
        const currentModel = await requireProviderApi(ctx).getCurrentModel();
        if (!currentModel.capabilities.multimodal) {
          ctx.print(`Warning: ${currentModel.displayName} does not support image input. The image will be stripped when sending.`);
        }
        const content: ContentPart[] = [
          { type: 'text', text: promptText },
          { type: 'image', data, mediaType },
        ];
        ctx.submitInput?.(promptText, content);
      },
    } satisfies TerminalSlashCommand<Context>,
    'refresh-models': {
      name: 'refresh-models',
      hidden: policy.hidden,
      description: 'Refresh model catalog, benchmarks, and token limits',
      async handler(_args: string[], ctx: Context) {
        const providerApi = requireProviderApi(ctx);
        let catalogOk = false;
        let benchmarksOk = false;
        let limitsOk = false;
        ctx.print('Refreshing model catalog...');
        try {
          const catalog = await providerApi.refreshCatalog();
          catalogOk = true;
          ctx.print(`Model catalog refreshed: ${catalog.modelCount} models from ${catalog.providerCount} providers`);
        } catch (e) {
          ctx.print(policy.imageFailure('Catalog refresh failed', summarizeError(e)));
        }
        ctx.print('Refreshing benchmarks...');
        try {
          const benchmarkCount = await providerApi.refreshBenchmarks();
          benchmarksOk = true;
          ctx.print(`Benchmarks refreshed${benchmarkCount > 0 ? `: ${benchmarkCount} model records available.` : '.'}`);
        } catch (e) {
          ctx.print(policy.imageFailure('Benchmarks refresh failed', summarizeError(e)));
        }
        ctx.print('Refreshing token limits...');
        try {
          const count = await providerApi.refreshModelLimits();
          limitsOk = true;
          ctx.print(`Token limits refreshed: ${count} models updated.`);
        } catch (e) {
          ctx.print(policy.imageFailure('Token limits refresh failed', summarizeError(e)));
        }
        let discoveryOk = !policy.liveDiscovery;
        if (policy.liveDiscovery) {
          ctx.print('Refreshing live provider model lists...');

          try {
            // Explicit user refresh → force past each provider's TTL cache and
            // report the delta ("3 new, 1 retired") or the honest fallback reason.
            const reports = await providerApi.refreshLiveModelDiscovery(undefined, { force: true });
            discoveryOk = reports.every((report) => !report.error);
            if (reports.length === 0) {
              ctx.print('No providers perform live model discovery.');
            } else {
              for (const report of reports) {
                if (report.source === 'live' || report.error || report.unclassifiedModels?.length)
                  ctx.print(`  ${formatModelDiscoveryReport(report.providerId, report)}`);
              }
              const absent = reports.filter((report) => report.skippedReason === 'local-endpoint-unavailable');
              if (absent.length > 0)
                ctx.print(`Local servers not running: ${absent.map((report) => report.providerId).join(', ')} (skipped).`);
              const unchanged = reports.filter(
                (report) => report.source !== 'live' && !report.error && !report.skippedReason && !report.unclassifiedModels?.length,
              ).length;
              if (unchanged > 0) ctx.print(`${unchanged} providers kept their cached or bundled lists (no live refresh).`);
            }
          } catch (e) {
            ctx.print(policy.imageFailure('Live model discovery failed', summarizeError(e)));
          }
        }
        if (!catalogOk || !benchmarksOk || !limitsOk || !discoveryOk) ctx.print(policy.partialRefresh);
      },
    } satisfies TerminalSlashCommand<Context>,
    pin: {
      name: 'pin',
      hidden: policy.hidden,
      description: 'Pin a model to the favorites list',
      usage: '<model-id>',
      argsHint: '<model-id>',
      async handler(args: string[], ctx: Context) {
        const providerApi = requireProviderApi(ctx);
        const modelId = args[0];
        if (!modelId) {
          const favorites = await providerApi.getFavorites();
          ctx.print(
            favorites.pinned.length === 0
              ? 'No pinned models. Use /pin <model-id> to pin one.'
              : `Pinned models:\n${favorites.pinned.map((entry) => `  ★ ${entry.registryKey ?? entry.modelId}`).join('\n')}`,
          );
          return;
        }
        const favorites = await providerApi.getFavorites();
        if (favorites.pinned.some((entry) => entry.modelId === modelId || entry.registryKey === modelId)) {
          ctx.print(policy.imageFailure('Model already pinned', modelId));
          return;
        }
        try {
          await providerApi.pinModel(modelId);
          ctx.print(`Pinned: ${modelId}`);
        } catch (e) {
          ctx.print(policy.error(summarizeError(e)));
        }
      },
    } satisfies TerminalSlashCommand<Context>,
    unpin: {
      name: 'unpin',
      hidden: policy.hidden,
      description: 'Unpin a model from the favorites list',
      usage: '<model-id>',
      argsHint: '<model-id>',
      async handler(args: string[], ctx: Context) {
        const providerApi = requireProviderApi(ctx);
        const modelId = args[0];
        if (!modelId) {
          ctx.print('Usage: /unpin <model-id>');
          return;
        }
        const favorites = await providerApi.getFavorites();
        const pinned = favorites.pinned.find(
          (entry) => entry.registryKey === modelId || (policy.unpinByModelId && entry.modelId === modelId),
        );
        if (!pinned) {
          ctx.print(`Model is not pinned: ${modelId}`);
          return;
        }
        await providerApi.unpinModel(pinned.registryKey);
        ctx.print(`Unpinned: ${modelId}`);
      },
    } satisfies TerminalSlashCommand<Context>,
  };
}
