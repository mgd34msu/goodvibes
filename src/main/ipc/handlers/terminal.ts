// ============================================================================
// TERMINAL IPC HANDLERS
// ============================================================================

import { ipcMain } from 'electron';
import { Logger } from '../../services/logger.js';
import { withContext } from '../utils.js';
import {
  startTerminal,
  startPlainTerminal,
  writeToTerminal,
  resizeTerminal,
  killTerminal,
  getAllTerminals,
} from '../../services/terminalManager.js';
import { commandExists } from '../../services/safeExec.js';
import {
  terminalStartOptionsSchema,
  plainTerminalStartOptionsSchema,
  terminalInputSchema,
  terminalResizeSchema,
  terminalIdSchema,
} from '../schemas/terminal.js';
import type { ZodError } from 'zod';

// Validation helpers are imported from shared utils
import { ValidationErrorResponse, formatValidationError } from '../utils/validation-helpers.js';

// ============================================================================
// TEXT EDITOR DETECTION
// ============================================================================

interface TextEditorInfo {
  name: string;
  command: string;
  available: boolean;
}

const TEXT_EDITORS: Array<{ name: string; command: string; windowsCommands?: string[] }> = [
  { name: 'Neovim', command: 'nvim', windowsCommands: ['nvim', 'nvim.exe'] },
  { name: 'Vim', command: 'vim', windowsCommands: ['vim', 'vim.exe'] },
  { name: 'Nano', command: 'nano', windowsCommands: ['nano', 'nano.exe'] },
  { name: 'VS Code', command: 'code', windowsCommands: ['code', 'code.cmd'] },
  { name: 'Emacs', command: 'emacs', windowsCommands: ['emacs', 'emacs.exe'] },
  { name: 'Helix', command: 'hx', windowsCommands: ['hx', 'hx.exe'] },
  { name: 'Micro', command: 'micro', windowsCommands: ['micro', 'micro.exe'] },
];

// Cache for detected editors - only needs to run once per app session
let cachedEditors: TextEditorInfo[] | null = null;

/**
 * Check if a command exists on the system.
 * Uses the centralized safeExec utility which validates inputs
 * and uses array-form arguments to prevent command injection.
 * @param command - The command to check for existence
 * @returns boolean indicating if command exists
 */
function checkCommandExists(command: string): boolean {
  return commandExists(command);
}

/**
 * Detects available text editors on the system by checking for their commands.
 * Results are cached for the lifetime of the app session.
 * @returns Array of editor information including name, command, and availability status
 */
function detectAvailableEditors(): TextEditorInfo[] {
  // Return cached result if available
  if (cachedEditors !== null) {
    return cachedEditors;
  }

  const isWindows = process.platform === 'win32';

  cachedEditors = TEXT_EDITORS.map(editor => {
    let available = false;
    let command = editor.command;

    if (isWindows && editor.windowsCommands) {
      for (const cmd of editor.windowsCommands) {
        if (checkCommandExists(cmd)) {
          available = true;
          command = cmd;
          break;
        }
      }
    } else {
      available = checkCommandExists(editor.command);
    }

    return {
      name: editor.name,
      command,
      available,
    };
  });

  return cachedEditors;
}

/**
 * Gets the command for the first available text editor on the system.
 * @returns The editor command string, or null if no editors are available
 */
function getDefaultEditor(): string | null {
  const editors = detectAvailableEditors();
  const available = editors.find(e => e.available);
  return available?.command ?? null;
}

const logger = new Logger('IPC:Terminal');

/**
 * Registers all terminal-related IPC handlers.
 * Handles terminal lifecycle operations including starting Claude terminals,
 * plain terminals, input/output, resizing, killing, and editor detection.
 */
export function registerTerminalHandlers(): void {
  // ============================================================================
  // START-CLAUDE HANDLER
  // Starts a Claude terminal session with validated options
  // ============================================================================
  ipcMain.handle('start-claude', withContext('start-claude', async (_, options: unknown) => {
    const result = terminalStartOptionsSchema.safeParse(options);
    if (!result.success) {
      logger.warn('start-claude validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }

    const validatedOptions = result.data;
    logger.info('IPC: start-claude received', {
      cwd: validatedOptions.cwd,
      name: validatedOptions.name,
      resumeSessionId: validatedOptions.resumeSessionId,
      sessionType: validatedOptions.sessionType
    });
    return startTerminal(validatedOptions);
  }));

  // ============================================================================
  // START-PLAIN-TERMINAL HANDLER
  // Starts a plain terminal without Claude
  // ============================================================================
  ipcMain.handle('start-plain-terminal', withContext('start-plain-terminal', async (_, options: unknown) => {
    const result = plainTerminalStartOptionsSchema.safeParse(options);
    if (!result.success) {
      logger.warn('start-plain-terminal validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }

    const validatedOptions = result.data;
    logger.info('IPC: start-plain-terminal received', {
      cwd: validatedOptions.cwd,
      name: validatedOptions.name
    });
    return startPlainTerminal(validatedOptions);
  }));

  // ============================================================================
  // TERMINAL-INPUT HANDLER
  // Writes data to a terminal - critical for security as this can execute commands
  // ============================================================================
  ipcMain.handle('terminal-input', withContext('terminal-input', async (_, input: unknown) => {
    const result = terminalInputSchema.safeParse(input);
    if (!result.success) {
      logger.warn('terminal-input validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }

    const { id, data } = result.data;
    writeToTerminal(id, data);
    return { success: true };
  }));

  // ============================================================================
  // TERMINAL-RESIZE HANDLER
  // Resizes a terminal - validates cols/rows are within safe bounds
  // ============================================================================
  ipcMain.handle('terminal-resize', withContext('terminal-resize', async (_, input: unknown) => {
    const result = terminalResizeSchema.safeParse(input);
    if (!result.success) {
      logger.warn('terminal-resize validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }

    const { id, cols, rows } = result.data;
    resizeTerminal(id, cols, rows);
    return { success: true };
  }));

  // ============================================================================
  // KILL-TERMINAL HANDLER
  // Terminates a terminal session by ID
  // ============================================================================
  ipcMain.handle('kill-terminal', withContext('kill-terminal', async (_, id: unknown) => {
    const result = terminalIdSchema.safeParse(id);
    if (!result.success) {
      logger.warn('kill-terminal validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }

    return killTerminal(result.data);
  }));

  // ============================================================================
  // GET-TERMINALS HANDLER
  // Returns all active terminals - no input validation needed
  // ============================================================================
  ipcMain.handle('get-terminals', withContext('get-terminals', async () => {
    return getAllTerminals();
  }));

  // ============================================================================
  // TEXT EDITOR DETECTION HANDLERS
  // These handlers have no user input to validate
  // ============================================================================
  ipcMain.handle('get-available-editors', withContext('get-available-editors', async () => {
    return detectAvailableEditors();
  }));

  ipcMain.handle('get-default-editor', withContext('get-default-editor', async () => {
    return getDefaultEditor();
  }));

  logger.info('Terminal handlers registered');
}
