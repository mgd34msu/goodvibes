// ============================================================================
// MENU CONFIGURATION
// ============================================================================

import { Menu, shell, MenuItemConstructorOptions, globalShortcut, app } from 'electron';
import { getMainWindow, sendToRenderer } from './window.js';

export function createMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New Session',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendToRenderer('new-session'),
        },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => sendToRenderer('close-tab'),
        },
        { type: 'separator' },
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => sendToRenderer('open-settings'),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo', accelerator: 'CmdOrCtrl+Z' },
        { role: 'redo', accelerator: 'CmdOrCtrl+Shift+Z' },
        { type: 'separator' },
        { role: 'cut', accelerator: 'CmdOrCtrl+X' },
        { role: 'copy', accelerator: 'CmdOrCtrl+C' },
        { role: 'paste', accelerator: 'CmdOrCtrl+V' },
        { role: 'selectAll', accelerator: 'CmdOrCtrl+A' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Terminal',
          accelerator: 'CmdOrCtrl+1',
          click: () => sendToRenderer('switch-view', 'terminal'),
        },
        {
          label: 'Sessions',
          accelerator: 'CmdOrCtrl+2',
          click: () => sendToRenderer('switch-view', 'sessions'),
        },
        {
          label: 'Analytics',
          accelerator: 'CmdOrCtrl+3',
          click: () => sendToRenderer('switch-view', 'analytics'),
        },
        {
          label: 'Notes',
          accelerator: 'CmdOrCtrl+4',
          click: () => sendToRenderer('switch-view', 'notes'),
        },
        { type: 'separator' },
        {
          label: 'Next Tab',
          accelerator: 'CmdOrCtrl+Tab',
          click: () => sendToRenderer('next-tab'),
        },
        {
          label: 'Previous Tab',
          accelerator: 'CmdOrCtrl+Shift+Tab',
          click: () => sendToRenderer('prev-tab'),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Claude Documentation',
          click: () => shell.openExternal('https://docs.anthropic.com/'),
        },
        {
          label: 'About GoodVibes',
          click: () => sendToRenderer('show-about'),
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
