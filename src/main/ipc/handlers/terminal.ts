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

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

/**
 * Standard error response for IPC validation failures.
 * Returns a structured error that the renderer can handle.
 */
interface ValidationErrorResponse {
  success: false;
  error: string;
  code: 'VALIDATION_ERROR';
  details?: Array<{ path: string; message: string }>;
}

/**
 * Format Zod validation errors into a structured response
 */
function formatValidationError(error: ZodError): ValidationErrorResponse {
  const details = error.errors.map(e => ({
    path: e.path.join('.'),
    message: e.message,
  }));

  return {
    success: false,
    error: `Validation failed: ${details.map(d => d.message).join(', ')}`,
    code: 'VALIDATION_ERROR',
    details,
  };
}

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

/**
 * Check if a command exists on the system.
 * Uses the centralized safeExec utility which validates inputs
 * and uses array-form arguments to prevent command injection.
 */
function checkCommandExists(command: string): boolean {
  return commandExists(command);
}

function detectAvailableEditors(): TextEditorInfo[] {
  const isWindows = process.platform === 'win32';

  return TEXT_EDITORS.map(editor => {
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
}

function getDefaultEditor(): string | null {
  const editors = detectAvailableEditors();
  const available = editors.find(e => e.available);
  return available?.command ?? null;
}

const logger = new Logger('IPC:Terminal');

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
