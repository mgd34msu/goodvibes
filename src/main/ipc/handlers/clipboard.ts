// ============================================================================
// CLIPBOARD & CONTEXT MENU IPC HANDLERS
// ============================================================================

import { ipcMain, clipboard, Menu, BrowserWindow, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from '../../services/logger.js';
import { withContext } from '../utils.js';
import {
  clipboardWriteSchema,
  contextMenuOptionsSchema,
  terminalContextMenuOptionsSchema,
} from '../schemas/clipboard.js';

const logger = new Logger('IPC:Clipboard');

// Validation helpers are imported from shared utils
import { ValidationErrorResponse, formatValidationError } from '../utils/validation-helpers.js';

// ============================================================================
// HANDLERS
// ============================================================================

export function registerClipboardHandlers(): void {
  // ============================================================================
  // CLIPBOARD HANDLERS
  // ============================================================================

  ipcMain.handle('clipboard-read', withContext('clipboard-read', async () => {
    return clipboard.readText();
  }));

  ipcMain.handle('clipboard-write', withContext('clipboard-write', async (_, text: unknown) => {
    // Validate input with Zod
    const validation = clipboardWriteSchema.safeParse(text);
    if (!validation.success) {
      logger.warn('clipboard-write validation failed', { error: validation.error.message });
      return formatValidationError(validation.error);
    }

    clipboard.writeText(validation.data);
    return { success: true };
  }));

  ipcMain.handle('clipboard-has-image', withContext('clipboard-has-image', async () => {
    const image = clipboard.readImage();
    return !image.isEmpty();
  }));

  ipcMain.handle('clipboard-read-image', withContext('clipboard-read-image', async () => {
    try {
      const image = clipboard.readImage();
      if (image.isEmpty()) {
        return { success: false, error: 'No image in clipboard' };
      }

      // Detect available clipboard formats
      const formats = clipboard.availableFormats();

      // Determine best image format and get buffer
      const mimeToExt: Record<string, string> = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'image/bmp': '.bmp',
        'image/tiff': '.tiff',
      };

      let imageBuffer: Buffer;
      let extension = '.png';

      if (formats.includes('image/jpeg')) {
        // Preserve JPEG format natively
        imageBuffer = image.toJPEG(100);
        extension = '.jpg';
      } else if (formats.some(f => f.startsWith('image/') && f !== 'image/png' && f !== 'image/jpeg')) {
        // Try to read exotic format raw from clipboard
        const exoticFormat = formats.find(f => f.startsWith('image/') && f !== 'image/png' && mimeToExt[f]);
        if (exoticFormat) {
          try {
            const rawBuffer = clipboard.readBuffer(exoticFormat);
            if (rawBuffer && rawBuffer.length > 0) {
              imageBuffer = rawBuffer;
              extension = mimeToExt[exoticFormat] || '.png';
            } else {
              imageBuffer = image.toPNG();
              extension = '.png';
            }
          } catch {
            // Fall back to PNG
            imageBuffer = image.toPNG();
            extension = '.png';
          }
        } else {
          imageBuffer = image.toPNG();
        }
      } else {
        // Default to PNG
        imageBuffer = image.toPNG();
        extension = '.png';
      }

      // Try to extract original filename from clipboard
      let originalFilename: string | null = null;

      if (formats.includes('text/uri-list')) {
        try {
          const uriList = clipboard.read('text/uri-list');
          if (uriList) {
            const firstUri = uriList.split('\n')[0].trim();
            if (firstUri.startsWith('file://')) {
              const decodedPath = decodeURIComponent(firstUri.replace('file://', ''));
              const basename = path.basename(decodedPath);
              // Sanitize: strip path separators, null bytes, limit length
              const sanitized = basename
                .replace(/[/\\:\0]/g, '')
                .replace(/\.\./g, '')
                .slice(0, 255);
              if (sanitized && /\.(png|jpg|jpeg|gif|webp|bmp|tiff|svg)$/i.test(sanitized)) {
                originalFilename = sanitized;
              }
            }
          }
        } catch {
          // Filename extraction is best-effort
        }
      }

      // Build final filename
      const filename = originalFilename || `paste-${Date.now()}${extension}`;

      const tempDir = path.join(app.getPath('temp'), 'goodvibes-clipboard');
      await fs.promises.mkdir(tempDir, { recursive: true });

      // Clean up old paste-* files to prevent accumulation
      try {
        const existingFiles = await fs.promises.readdir(tempDir);
        const staleFiles = existingFiles.filter(f => f.startsWith('paste-'));
        await Promise.all(staleFiles.map(f => fs.promises.unlink(path.join(tempDir, f)).catch(() => {})));
      } catch {
        // Cleanup is best-effort
      }

      const filePath = path.join(tempDir, filename);
      await fs.promises.writeFile(filePath, imageBuffer);

      return { success: true, filePath };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to read image from clipboard', { error: errorMessage });
      return { success: false, error: errorMessage };
    }
  }));

  // ============================================================================
  // CONTEXT MENU HANDLERS
  // ============================================================================

  ipcMain.handle('show-context-menu', withContext('show-context-menu', async (event, options: unknown) => {
    // Validate input with Zod
    const validation = contextMenuOptionsSchema.safeParse(options);
    if (!validation.success) {
      logger.warn('show-context-menu validation failed', { error: validation.error.message });
      return formatValidationError(validation.error);
    }

    const validatedOptions = validation.data;
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return { success: false, error: 'Window not found', code: 'WINDOW_NOT_FOUND' };

    const menuTemplate: Electron.MenuItemConstructorOptions[] = [];

    // Cut - only for editable fields with selection
    if (validatedOptions.isEditable && validatedOptions.hasSelection) {
      menuTemplate.push({
        label: 'Cut',
        accelerator: 'CmdOrCtrl+X',
        role: 'cut',
      });
    }

    // Copy - for any selection
    if (validatedOptions.hasSelection) {
      menuTemplate.push({
        label: 'Copy',
        accelerator: 'CmdOrCtrl+C',
        role: 'copy',
      });
    }

    // Paste - for editable fields or terminal
    if (validatedOptions.isEditable || validatedOptions.isTerminal) {
      menuTemplate.push({
        label: 'Paste',
        accelerator: 'CmdOrCtrl+V',
        role: 'paste',
      });
    }

    // Select All - for editable fields
    if (validatedOptions.isEditable) {
      if (menuTemplate.length > 0) {
        menuTemplate.push({ type: 'separator' });
      }
      menuTemplate.push({
        label: 'Select All',
        accelerator: 'CmdOrCtrl+A',
        role: 'selectAll',
      });
    }

    // Only show menu if there are items
    if (menuTemplate.length > 0) {
      const menu = Menu.buildFromTemplate(menuTemplate);
      menu.popup({ window });
    }

    return { success: true };
  }));

  // Terminal-specific context menu with clipboard access via IPC
  ipcMain.handle('show-terminal-context-menu', withContext('show-terminal-context-menu', async (event, options: unknown) => {
    // Validate input with Zod
    const validation = terminalContextMenuOptionsSchema.safeParse(options);
    if (!validation.success) {
      logger.warn('show-terminal-context-menu validation failed', { error: validation.error.message });
      return formatValidationError(validation.error);
    }

    const validatedOptions = validation.data;
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return { success: false, error: 'Window not found', code: 'WINDOW_NOT_FOUND' };

    return new Promise<string | { success: false; error: string; code: string } | null>((resolve) => {
      const menuTemplate: Electron.MenuItemConstructorOptions[] = [];

      if (validatedOptions.hasSelection && validatedOptions.selectedText) {
        const textToCopy = validatedOptions.selectedText;
        menuTemplate.push({
          label: 'Copy',
          accelerator: 'CmdOrCtrl+C',
          click: () => {
            clipboard.writeText(textToCopy);
            resolve('copy');
          },
        });
      }

      const clipboardText = clipboard.readText();
      if (clipboardText) {
        menuTemplate.push({
          label: 'Paste',
          accelerator: 'CmdOrCtrl+V',
          click: () => {
            resolve('paste');
          },
        });
      }

      const clipboardImage = clipboard.readImage();
      if (!clipboardImage.isEmpty()) {
        menuTemplate.push({
          label: 'Paste Image',
          click: () => {
            resolve('paste-image');
          },
        });
      }

      if (menuTemplate.length > 0) {
        menuTemplate.push({ type: 'separator' });
      }

      menuTemplate.push({
        label: 'Clear Terminal',
        click: () => {
          resolve('clear');
        },
      });

      const menu = Menu.buildFromTemplate(menuTemplate);
      menu.popup({
        window,
        callback: () => {
          // Menu closed without selection
          resolve(null);
        },
      });
    });
  }));

  logger.info('Clipboard handlers registered');
}
