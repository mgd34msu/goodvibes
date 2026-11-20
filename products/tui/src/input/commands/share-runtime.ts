import { writeJsonFileAtomic } from '@goodvibes-jev/engine/platform/platform/state/durable-file-io';
import { getSharedNotificationFeed } from '../../views/notifications-feed.ts';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import type { CommandContext } from '../command-registry.ts';
import {
  type ExportMessage,
  defaultExportPath,
  exportToHTML,
  exportToJSON,
  exportToMarkdownExtended,
} from '@goodvibes-jev/engine/platform/platform/export';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';
import { requireShellPaths } from '@goodvibes-jev/engine/terminal-shell/command-service-access';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import { calcSessionCost, isModelPriced } from '@goodvibes-jev/engine/platform/platform/providers';
import {
  GistUploadTarget,
  NO_TOKEN_GUIDANCE,
  resolveGithubToken,
} from '../../export/gist-uploader.ts';
import { copyToClipboard } from '../../utils/clipboard.ts';
import { openBrowser } from '../../utils/browser.ts';

export interface ShareInput {
  readonly format: 'html' | 'json' | 'md';
  /** Empty for ~/goodvibes-exports/session-<timestamp>.<ext>. */
  readonly path: string;
  readonly redact: boolean;
  readonly upload: boolean;
  readonly copy: boolean;
  readonly open: boolean;
}

/**
 * Write this conversation as html, json or Markdown, and with `upload` send it
 * to a secret GitHub Gist and print the link (`/session save-file` and
 * `/session upload`). The local file is written first; an upload that fails
 * leaves it.
 */
export async function shareConversation(ctx: CommandContext, input: ShareInput): Promise<void> {
      const shellPaths = requireShellPaths(ctx);
      const { format, upload, redact } = input;
      const doCopy = input.copy;
      const doOpen = input.open;
      const pathArgs = input.path ? [input.path] : [];
      const args = [format, input.path, upload ? 'upload' : '', redact ? 'redact' : ''];
      const begun = upload ? ctx.commandReadings?.begin('share', JSON.stringify(args)) : undefined;
      if (upload && !begun?.ok) {
        ctx.print(begun?.reason === 'pending'
          ? 'This upload is already in progress; its link is printed when it finishes. Nothing new was started.'
          : 'Gist upload is not available while the terminal is closing. Nothing was exported or uploaded.');
        return;
      }
      const reading = begun?.ok ? begun : undefined;
      const conversation = ctx.session.conversationManager;
      const history = conversation.captureHistoryReadingLifetime();
      const sourceSignal = reading ? AbortSignal.any([history.signal, reading.signal]) : history.signal;
      const generation = conversation.getReplacementGeneration();
      const current = () => !sourceSignal.aborted && (!reading || reading.current())
        && ctx.session.conversationManager === conversation
        && conversation.getReplacementGeneration() === generation;
      try {
      const outputPath = pathArgs.length > 0
        ? shellPaths.resolveWorkspacePath(pathArgs[0])
        : defaultExportPath(format, shellPaths.homeDirectory);

      const convData = ctx.session.conversationManager.toJSON() as {
        messages: Array<{
          role: string;
          content: unknown;
          toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
          callId?: string;
          toolName?: string;
          reasoningContent?: string;
          reasoningSummary?: string;
          usage?: {
            inputTokens: number;
            outputTokens: number;
            cacheReadTokens?: number;
            cacheWriteTokens?: number;
          };
          cancelled?: boolean;
        }>;
      };

      if (!convData.messages || convData.messages.length === 0) {
        ctx.print('Nothing to export: conversation is empty.');
        return;
      }

      const messages: ExportMessage[] = convData.messages.map((m) => ({
        role: m.role as ExportMessage['role'],
        content: m.content as string,
        toolCalls: m.toolCalls,
        callId: m.callId,
        toolName: m.toolName,
        reasoningContent: m.reasoningContent,
        reasoningSummary: m.reasoningSummary,
        usage: m.usage,
        cancelled: m.cancelled,
      }));

      // Accumulate per-message usage totals for session cost calculation.
      let totalInput = 0;
      let totalOutput = 0;
      let totalCacheRead = 0;
      let totalCacheWrite = 0;
      for (const m of convData.messages) {
        if (m.usage) {
          totalInput      += m.usage.inputTokens ?? 0;
          totalOutput     += m.usage.outputTokens ?? 0;
          totalCacheRead  += m.usage.cacheReadTokens ?? 0;
          totalCacheWrite += m.usage.cacheWriteTokens ?? 0;
        }
      }
      const sessionModel = ctx.session.runtime.model;
      const sessionCostUsd = calcSessionCost(
        totalInput, totalOutput, totalCacheRead, totalCacheWrite, sessionModel,
      );
      // The exported document has no field for "this cost is a placeholder",
      // omit `cost` entirely rather than embed a misleading 0 when the model
      // never resolved to a real price.
      const costIsUnpriced = !isModelPriced(sessionModel);
      if (costIsUnpriced) {
        ctx.print(`Note: cost omitted from export; no pricing data for model "${sessionModel}".`);
      }

      const metadata = {
        model: sessionModel,
        provider: ctx.session.runtime.provider,
        sessionId: ctx.session.runtime.sessionId,
        title: ctx.session.conversationManager.title || undefined,
      };
      const options = { redact, cost: costIsUnpriced ? undefined : sessionCostUsd, signal: sourceSignal };

      let outputContent: string;
      try {
        if (format === 'html') outputContent = await exportToHTML(messages, metadata, options);
        else if (format === 'json') outputContent = await exportToJSON(messages, metadata, options);
        else outputContent = await exportToMarkdownExtended(messages, metadata, options);
      } catch (err) {
        if (!current()) return;
        ctx.print(`Export failed: ${summarizeError(err)}`);
        return;
      }

      if (!current()) return;
      const { mkdirSync } = await import('node:fs');
      const { dirname, basename } = await import('node:path');
      if (!current()) return;
      try {
        mkdirSync(dirname(outputPath), { recursive: true });
      } catch (mkdirErr) {
        logger.warn(
          `[share] mkdir failed for ${dirname(outputPath)}:`,
          mkdirErr instanceof Error ? { message: mkdirErr.message } : undefined,
        );
      }

      try {
        await writeFile(outputPath, outputContent, { encoding: 'utf-8', signal: sourceSignal });
      } catch (err) {
        if (!current()) return;
        ctx.print(`Failed to write export: ${summarizeError(err)}`);
        return;
      }

      if (!current()) return;

      // Optional Gist upload: resolve auth token then push content as a secret gist.
      let shareLink: string | undefined;
      let uploadReceipt: string | undefined;
      if (upload) {
        // The github service entry's bearer, else GITHUB_TOKEN; resolved once, right before the request.
        const serviceRegistry = ctx.platform.serviceRegistry;
        let authHeaders: Record<string, string> | null = null;
        let lookupFailure: string | undefined;
        if (serviceRegistry) {
          try {
            authHeaders = await serviceRegistry.resolveAuth('github');
          } catch (error) {
            lookupFailure = summarizeError(error);
          }
        }
        if (!current()) return;
        const token = await resolveGithubToken(authHeaders, { signal: sourceSignal });
        if (!current()) return;
        if (!token) {
          ctx.print(lookupFailure
            ? `Upload not attempted: the github service entry could not be read (${lookupFailure}) and GITHUB_TOKEN is not set. Local export saved at ${outputPath}.`
            : NO_TOKEN_GUIDANCE);
        } else {
          try {
            const gistFilename = basename(outputPath);
            const description = metadata.title
              ? `GoodVibes session: ${metadata.title}`
              : 'GoodVibes session export';
            const uploader = new GistUploadTarget(token, description);
            const result = await uploader.upload(outputContent, gistFilename, sourceSignal);
            // A revoked UI owner does not revoke a request GitHub already saw.
            // Preserve the outcome under the original export/session identity,
            // without writing an old session's URL into the replacement UI.
            const receiptPath = `${outputPath}.gist-${randomUUID()}.json`;
            try {
              writeJsonFileAtomic(receiptPath, {
                version: 1, sessionId: metadata.sessionId, exportedPath: outputPath,
                recordedAt: new Date().toISOString(),
                ...(result.ok ? { status: 'accepted', url: result.url } : { status: 'unconfirmed' }),
              }, { durable: true, mode: 0o600, cleanupStaleTemps: false });
              uploadReceipt = receiptPath;
            } catch {
              // The global notification history can retain an explicitly
              // source-labelled receipt without mutating a replacement chat.
              getSharedNotificationFeed().recordNotice({
                domain: 'share', level: 'warning', timestamp: Date.now(),
                title: `Gist ${result.ok ? 'accepted' : 'unconfirmed'} for session ${metadata.sessionId}; receipt not saved`,
                body: result.ok ? result.url : 'GitHub may have received the upload. Check before retrying.',
              });
            }
            if (!current()) return;
            if (result.ok) {
              shareLink = result.url;
            } else {
              ctx.print(`Upload unconfirmed: ${result.error}. GitHub may have received it; check before retrying.`);
            }
          } catch (error) {
            if (!current()) return;
            // The local export is already written; the failure is the upload's alone.
            ctx.print(`Upload failed: the Gist upload did not complete (${summarizeError(error)}). Local export saved at ${outputPath}.`);
          }
        }
      }

      // Copy export path to clipboard if requested.
      if (doCopy) {
        copyToClipboard(outputPath);
      }

      // Open the exported HTML in the default browser if requested.
      let openResult = '';
      if (doOpen && format === 'html') {
        openResult = openBrowser(pathToFileURL(outputPath).href, { allowFile: true });
      }

      // Emit the summary line, with all post-export hints inline.
      const hints: string[] = [];
      if (upload) hints.push(redact ? '(redacted before upload)' : '(uploaded unredacted, as stored)');
      else hints.push(redact ? '(sensitive data redacted)' : '(not redacted)');
      if (shareLink) hints.push(`Share link: ${shareLink}`);
      if (uploadReceipt) hints.push(`Upload receipt: ${uploadReceipt}`);
      if (doCopy) hints.push('(path copied to clipboard)');
      if (doOpen && format === 'html') hints.push(openResult === 'browser open requested' ? '(opened in browser)' : `(not opened: ${openResult})`);
      if (doOpen && format !== 'html') hints.push('(not opened: only an html file opens in the browser)');

      const hint = hints.length > 0 ? '  ' + hints.join('  ') : '';
      ctx.print(`Exported ${format.toUpperCase()} session to ${outputPath}${hint}`);
      } finally { reading?.finish(); }
}
