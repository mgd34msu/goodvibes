// ============================================================================
// EXPORT IPC HANDLERS
// ============================================================================

import { ipcMain, dialog } from 'electron';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import archiver from 'archiver';
import { Logger } from '../../services/logger.js';
import { withContext } from '../utils.js';
import * as db from '../../database/index.js';
import type { Session, SessionMessage } from '../../../shared/types/index.js';
import {
  exportSessionSchema,
  bulkExportSchema,
  validateInput,
} from '../schemas/index.js';

const logger = new Logger('IPC:Export');

/**
 * Custom error class for IPC validation failures
 */
class IPCValidationError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'VALIDATION_ERROR'
  ) {
    super(message);
    this.name = 'IPCValidationError';
  }
}

// ============================================================================
// FORMATTERS
// ============================================================================

function formatAsMarkdown(session: Session, messages: SessionMessage[]): string {
  let md = `# Session: ${session.customTitle || session.projectName || session.id}\n\n`;
  md += `**Project:** ${session.projectName}\n`;
  md += `**Date:** ${session.startTime}\n`;
  md += `**Messages:** ${session.messageCount}\n`;
  md += `**Tokens:** ${session.tokenCount}\n`;
  md += `**Cost:** $${(session.cost ?? 0).toFixed(2)}\n\n`;
  md += `---\n\n`;

  for (const msg of messages) {
    md += `## ${msg.role.charAt(0).toUpperCase() + msg.role.slice(1)}\n\n`;
    md += `${msg.content}\n\n`;
  }

  return md;
}

function formatAsHtml(session: Session, messages: SessionMessage[]): string {
  let html = `<!DOCTYPE html>
<html>
<head>
  <title>Session: ${session.customTitle || session.id}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; }
    .meta { background: #f5f5f5; padding: 15px; border-radius: 8px; margin-bottom: 20px; }
    .message { margin: 20px 0; padding: 15px; border-radius: 8px; }
    .user { background: #e3f2fd; }
    .assistant { background: #f3e5f5; }
    .thinking { background: #fff3e0; font-style: italic; }
    .tool { background: #e8f5e9; font-family: monospace; }
    pre { overflow-x: auto; }
  </style>
</head>
<body>
  <h1>${session.customTitle || session.projectName || session.id}</h1>
  <div class="meta">
    <p><strong>Project:</strong> ${session.projectName}</p>
    <p><strong>Date:</strong> ${session.startTime}</p>
    <p><strong>Messages:</strong> ${session.messageCount}</p>
    <p><strong>Tokens:</strong> ${session.tokenCount}</p>
    <p><strong>Cost:</strong> $${(session.cost ?? 0).toFixed(2)}</p>
  </div>`;

  for (const msg of messages) {
    html += `<div class="message ${msg.role}">
      <strong>${msg.role}</strong>
      <pre>${escapeHtml(msg.content)}</pre>
    </div>`;
  }

  html += `</body></html>`;
  return html;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================================
// HANDLERS
// ============================================================================

export function registerExportHandlers(): void {
  ipcMain.handle('export-session', withContext('export-session', async (_, data: unknown) => {
    // Validate input using Zod schema
    const validation = validateInput(exportSessionSchema, data);
    if (!validation.success) {
      logger.warn('export-session validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid export data: ${validation.error}`);
    }

    const { sessionId, format } = validation.data;

    const session = db.getSession(sessionId);
    if (!session) return { success: false, error: 'Session not found' };

    const messages = db.getSessionMessages(sessionId);
    const result = await dialog.showSaveDialog({
      title: 'Export Session',
      defaultPath: `session-${sessionId}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });

    if (result.canceled || !result.filePath) {
      return { success: false, error: 'Export cancelled' };
    }

    let content: string;

    if (format === 'json') {
      content = JSON.stringify({ session, messages }, null, 2);
    } else if (format === 'markdown') {
      content = formatAsMarkdown(session, messages);
    } else {
      content = formatAsHtml(session, messages);
    }

    await fs.writeFile(result.filePath, content, 'utf-8');
    return { success: true, path: result.filePath };
  }));

  ipcMain.handle('bulk-export', withContext('bulk-export', async (_, sessionIds: unknown) => {
    // Validate input using Zod schema
    const validation = validateInput(bulkExportSchema, sessionIds);
    if (!validation.success) {
      logger.warn('bulk-export validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid session IDs: ${validation.error}`);
    }

    const validatedSessionIds = validation.data;

    const result = await dialog.showSaveDialog({
      title: 'Export Sessions as ZIP',
      defaultPath: `sessions-export-${Date.now()}.zip`,
      filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
    });

    if (result.canceled || !result.filePath) {
      return { success: false, error: 'Export cancelled' };
    }

    const filePath = result.filePath;

    return new Promise((resolve) => {
      const output = createWriteStream(filePath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      // Handle stream events
      output.on('close', () => {
        resolve({ success: true, path: filePath });
      });

      output.on('error', (err) => {
        logger.error('Export write stream error', err);
        resolve({ success: false, error: `Write error: ${err.message}` });
      });

      archive.on('error', (err) => {
        logger.error('Archive error', err);
        output.close();
        resolve({ success: false, error: `Archive error: ${err.message}` });
      });

      archive.pipe(output);

      for (const sessionId of validatedSessionIds) {
        const session = db.getSession(sessionId);
        if (session) {
          const messages = db.getSessionMessages(sessionId);
          archive.append(JSON.stringify({ session, messages }, null, 2), {
            name: `${sessionId}.json`,
          });
        }
      }

      archive.finalize();
    });
  }));

  logger.info('Export handlers registered');
}
