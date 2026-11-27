import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { ContentPart, ProviderApi } from '@goodvibes/engine/platform/platform/providers';
import { resolveAndValidatePath, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import { isHeldPath } from '@goodvibes/engine/platform/platform/capabilities';
import type { TerminalConversationManager } from './terminal-conversation.js';
import { MAX_IMAGE_ATTACH_BYTES } from './modal-input-routes.js';
import { commandRefusal } from './command-confirmation.js';
export interface LocalCommandContext {
  readonly print: (message: string) => void;
  readonly renderRequest: () => void;
  readonly submitInput?: ((text: string, content: ContentPart[]) => void) | undefined;
  /** Sends the image prompt as a turn exactly as given. */
  readonly submitTurn?: ((text: string, content: ContentPart[]) => void) | undefined;
  readonly workspace: { readonly shellPaths?: { readonly workingDirectory: string } | undefined };
  readonly platform: { readonly configManager: { getWorkingDirectory(): string | null | undefined } };
  readonly session: { readonly conversationManager: TerminalConversationManager };
}
/** Shared local operations; products provide presentation and explicit discovery policy. */
export function createLocalCommandActions<Context extends LocalCommandContext>(
  requireProviderApi: (context: Context) => ProviderApi,
  policy: {
    readonly unpinByModelId: boolean;
    readonly supportedFormats: string;
    readonly maximumImageSize: string;
    readonly error: (detail: string) => string;
    readonly imageFailure: (kind: string, detail: string) => string;
    readonly invalidBlockType: (type: string, valid: readonly string[]) => string;
    readonly noteTouch: (conversation: TerminalConversationManager, key: string) => void;
  },
) {
  function toggleBlocks(typeFilter: string, collapsed: boolean, ctx: Context): void {
    const VALID_TYPES = ['all', 'thinking', 'tool', 'code'] as const;
    if (!VALID_TYPES.includes(typeFilter as (typeof VALID_TYPES)[number])) throw commandRefusal(policy.invalidBlockType(typeFilter, VALID_TYPES));
    const blockRegistry = ctx.session.conversationManager.getBlockRegistry();
    if (!blockRegistry || blockRegistry.length === 0) {
      ctx.print('No blocks found.');
      return;
    }
    let count = 0;
    for (const [i, block] of blockRegistry.entries()) {
      // A merged assistant turn (type 'assistant_turn', see
      // conversation-turn-structure.ts) owns the whole tool subtree beneath its
      // header, so '/session expand tool'/'collapse tool' treats it the same as a plain
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
        // individually, without this, '/session expand tool' would only open the turn
        // header and each result would still render at its own default collapse
        // state, needing a second pass. '/session collapse tool' needs no matching step:
        // collapsing the turn hides every result regardless of its own key.
        if (!collapsed && block.type === 'assistant_turn' && block.groupMemberIndexes) {
          for (const [k, memberIdx] of block.groupMemberIndexes.entries()) {
            const memberKey = block.groupMemberKeys?.[k] ?? `msg_${memberIdx}`;
            ctx.session.conversationManager.setCollapsed(memberKey, false);
            // An explicit /session expand is a deliberate user action on this key, same
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
  /**
   * Send an image file of the project with a message as a new turn: the conversation's image control
   * (capabilities/builtin/conversation-controls.ts, conversation.image). What it says, in words.
   */
  async function attachImage(ctx: Context, rawPath: string, message: string): Promise<string> {
    const promptText = message || `Attached image: ${rawPath.split('/').pop() ?? rawPath}`;
    const projectRoot = ctx.workspace.shellPaths?.workingDirectory ?? ctx.platform.configManager.getWorkingDirectory();
    if (!projectRoot) throw commandRefusal(policy.error('working directory is unavailable.'));
    let resolvedPath: string;
    try {
      // A file the conversation's control already placed and holds for this call (capabilities/held-paths.ts) is read
      // as held: placing it again would read the project's path a second time.
      resolvedPath = isHeldPath(rawPath) ? rawPath : resolveAndValidatePath(rawPath, projectRoot);
    } catch (err) {
      throw commandRefusal(policy.error(summarizeError(err)));
    }
    if (!existsSync(resolvedPath)) throw commandRefusal(policy.imageFailure('File not found', rawPath));
    const ext = resolvedPath.slice(resolvedPath.lastIndexOf('.')).toLowerCase();
    const mediaType = (
      { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' } as Record<
        string,
        string
      >
    )[ext];
    if (!mediaType) throw commandRefusal(policy.imageFailure('Unsupported image format', ext) + policy.supportedFormats);
    const stat = statSync(resolvedPath);
    if (stat.size > MAX_IMAGE_ATTACH_BYTES) throw commandRefusal(`Image too large (${(stat.size / 1024 / 1024).toFixed(1)}MB).`, policy.maximumImageSize);
    let data: string;
    try {
      data = (await readFile(resolvedPath)).toString('base64');
    } catch (err) {
      throw commandRefusal(policy.imageFailure('Failed to read image', summarizeError(err)));
    }
    const currentModel = await requireProviderApi(ctx).getCurrentModel();
    const warning = currentModel.capabilities.multimodal ? '' : `Warning: ${currentModel.displayName} does not support image input. The image will be stripped when sending.`;
    const content: ContentPart[] = [
      { type: 'text', text: promptText },
      { type: 'image', data, mediaType },
    ];
    if (!ctx.submitTurn) throw commandRefusal('The image was not sent: this surface cannot send a message.');
    ctx.submitTurn(promptText, content);
    return warning;
  }
  return {
    toggleBlocks,
    attachImage,
    // Pinning a model is the daemon's (capabilities/builtin/models.ts, pin.*): the Models and providers place and the
    // model picker's star run it there, for every program.
  };
}
