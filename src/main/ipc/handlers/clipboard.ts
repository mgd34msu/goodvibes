// ============================================================================
// CLIPBOARD & CONTEXT MENU IPC HANDLERS
// ============================================================================

import { ipcMain, clipboard, Menu, BrowserWindow } from 'electron';
import { Logger } from '../../services/logger.js';
import { withContext } from '../utils.js';

const logger = new Logger('IPC:Clipboard');

export function registerClipboardHandlers(): void {
  // ============================================================================
  // CLIPBOARD HANDLERS
  // ============================================================================

  ipcMain.handle('clipboard-read', withContext('clipboard-read', async () => {
    return clipboard.readText();
  }));

  ipcMain.handle('clipboard-write', withContext('clipboard-write', async (_, text: string) => {
    clipboard.writeText(text);
    return true;
  }));

  // ============================================================================
  // CONTEXT MENU HANDLERS
  // ============================================================================

  ipcMain.handle('show-context-menu', withContext('show-context-menu', async (event, options: {
    hasSelection: boolean;
    isEditable: boolean;
    isTerminal?: boolean;
  }) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;

    const menuTemplate: Electron.MenuItemConstructorOptions[] = [];

    // Cut - only for editable fields with selection
    if (options.isEditable && options.hasSelection) {
      menuTemplate.push({
        label: 'Cut',
        accelerator: 'CmdOrCtrl+X',
        role: 'cut',
      });
    }

    // Copy - for any selection
    if (options.hasSelection) {
      menuTemplate.push({
        label: 'Copy',
        accelerator: 'CmdOrCtrl+C',
        role: 'copy',
      });
    }

    // Paste - for editable fields or terminal
    if (options.isEditable || options.isTerminal) {
      menuTemplate.push({
        label: 'Paste',
        accelerator: 'CmdOrCtrl+V',
        role: 'paste',
      });
    }

    // Select All - for editable fields
    if (options.isEditable) {
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
  }));

  // Terminal-specific context menu with clipboard access via IPC
  ipcMain.handle('show-terminal-context-menu', withContext('show-terminal-context-menu', async (event, options: {
    hasSelection: boolean;
    selectedText?: string;
  }) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return null;

    return new Promise<string | null>((resolve) => {
      const menuTemplate: Electron.MenuItemConstructorOptions[] = [];

      if (options.hasSelection && options.selectedText) {
        menuTemplate.push({
          label: 'Copy',
          accelerator: 'CmdOrCtrl+C',
          click: () => {
            if (options.selectedText) {
              clipboard.writeText(options.selectedText);
            }
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
