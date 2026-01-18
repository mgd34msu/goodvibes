// ============================================================================
// TERMINAL MANAGER SERVICE
// ============================================================================

import * as pty from 'node-pty';
import * as fs from 'fs';
import * as path from 'path';
import { sendToRenderer } from '../window.js';
import { getSetting, logActivity } from '../database/index.js';
import { addRecentProject } from './recentProjects.js';
import { Logger } from './logger.js';
import { getPTYStreamAnalyzer } from './ptyStreamAnalyzer.js';
import type { TerminalInfo, TerminalStartOptions, TerminalStartResult } from '../../shared/types/index.js';

const logger = new Logger('TerminalManager');

// ============================================================================
// INPUT VALIDATION - Security against command injection
// ============================================================================

/**
 * Validate session ID format to prevent command injection.
 * Claude session IDs follow a specific format (alphanumeric with hyphens).
 */
function isValidSessionId(sessionId: string): boolean {
  // Session IDs should be alphanumeric with hyphens, typically UUID format
  // Max length prevents buffer overflow attacks
  return /^[a-zA-Z0-9-]+$/.test(sessionId) && sessionId.length > 0 && sessionId.length <= 128;
}

/**
 * Validate shell path to prevent command injection.
 * Only allows paths that:
 * 1. Contain no shell metacharacters
 * 2. Are absolute paths or known shell names
 * 3. Actually exist on the filesystem (for absolute paths)
 */
function isValidShellPath(shellPath: string): boolean {
  if (!shellPath || shellPath.length === 0 || shellPath.length > 1024) {
    return false;
  }

  // Known safe shell names (for PATH lookup)
  const knownShells = [
    'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh',
    'cmd.exe', 'powershell.exe', 'pwsh.exe', 'pwsh',
    'cmd', 'powershell',
  ];

  // If it's a known shell name (no path), allow it
  if (knownShells.includes(shellPath) || knownShells.includes(path.basename(shellPath))) {
    // For simple names, ensure no shell metacharacters
    if (/^[\w.-]+$/.test(shellPath)) {
      return true;
    }
  }

  // For absolute paths, validate the path format and check existence
  if (path.isAbsolute(shellPath)) {
    // Prevent shell metacharacters in the path
    // Allow: alphanumeric, path separators, dots, dashes, underscores, spaces (quoted in spawn)
    // Disallow: ; | & $ ` ( ) { } < > ! ? * [ ] \ (except as path sep on Windows)
    const dangerousChars = /[;|&$`(){}<>!?*[\]]/;
    if (dangerousChars.test(shellPath)) {
      logger.warn('Shell path contains dangerous characters', { shellPath });
      return false;
    }

    // Check if the file exists and is executable
    try {
      const stats = fs.statSync(shellPath);
      if (!stats.isFile()) {
        logger.warn('Shell path is not a file', { shellPath });
        return false;
      }
      return true;
    } catch (error) {
      // File doesn't exist or can't be accessed
      const errorCode = error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : 'UNKNOWN';
      logger.warn('Shell path does not exist or is not accessible', {
        shellPath,
        errorCode,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  // For relative paths or unknown formats, be strict
  // Only allow simple executable names without metacharacters
  if (/^[\w.-]+$/.test(shellPath)) {
    return true;
  }

  logger.warn('Shell path validation failed', { shellPath });
  return false;
}

/**
 * Validate working directory path.
 * Prevents directory traversal and ensures the path exists.
 */
function isValidWorkingDirectory(cwd: string): boolean {
  if (!cwd || cwd.length === 0 || cwd.length > 4096) {
    return false;
  }

  // Prevent shell metacharacters
  const dangerousChars = /[;|&$`(){}<>!?*[\]]/;
  if (dangerousChars.test(cwd)) {
    logger.warn('Working directory contains dangerous characters', { cwd });
    return false;
  }

  // Check if directory exists
  try {
    const stats = fs.statSync(cwd);
    if (!stats.isDirectory()) {
      logger.warn('Working directory is not a directory', { cwd });
      return false;
    }
    return true;
  } catch (error) {
    const errorCode = error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : 'UNKNOWN';
    logger.warn('Working directory does not exist or is not accessible', {
      cwd,
      errorCode,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

interface InternalTerminal {
  id: number;
  pty: pty.IPty;
  name: string;
  cwd: string;
  startTime: Date;
  resumeSessionId?: string;
  sessionType?: 'user' | 'subagent';
  isPlainTerminal?: boolean;
}

const terminals = new Map<number, InternalTerminal>();
let terminalIdCounter = 0;

// ============================================================================
// INITIALIZATION
// ============================================================================

export function initTerminalManager(): void {
  // Start periodic cleanup of stale entries in the stream analyzer
  const analyzer = getPTYStreamAnalyzer();
  analyzer.startPeriodicCleanup(() => getActiveTerminalIds());

  logger.info('Terminal manager initialized');
}

/**
 * Get the set of currently active terminal IDs.
 * Used by PTYStreamAnalyzer for periodic stale entry cleanup.
 */
export function getActiveTerminalIds(): Set<number> {
  return new Set(terminals.keys());
}

// ============================================================================
// TERMINAL OPERATIONS
// ============================================================================

export async function startTerminal(options: TerminalStartOptions): Promise<TerminalStartResult> {
  try {
    const workingDir = options.cwd || process.cwd();

    // Validate working directory to prevent injection attacks
    if (!isValidWorkingDirectory(workingDir)) {
      logger.error('Invalid working directory', { cwd: workingDir });
      return { error: 'Invalid working directory path' };
    }

    const terminalId = ++terminalIdCounter;

    // Find claude executable path
    const claudePath = process.platform === 'win32' ? 'claude.cmd' : 'claude';

    // Build arguments array
    const args: string[] = [];

    // Check if we should skip permissions
    const skipPermissions = getSetting<boolean>('skipPermissions') !== false;
    logger.info(`Skip permissions setting: ${skipPermissions} (raw value: ${getSetting<boolean>('skipPermissions')})`);
    if (skipPermissions) {
      args.push('--dangerously-skip-permissions');
    }

    // Add resume flag if resuming a session (with validation)
    if (options.resumeSessionId) {
      // Validate session ID to prevent command injection
      if (!isValidSessionId(options.resumeSessionId)) {
        logger.error('Invalid session ID format', { sessionId: options.resumeSessionId });
        return { error: 'Invalid session ID format' };
      }
      args.push('--resume', options.resumeSessionId);
      logger.info(`Resuming session: ${options.resumeSessionId}, type: ${options.sessionType || 'user'}`);
    } else {
      logger.info('Starting new session (no resume session ID provided)');
    }

    // Log the full command that will be executed
    const fullCommand = `${claudePath} ${args.join(' ')}`;
    logger.info(`Full Claude command: ${fullCommand}`);

    // Spawn Claude with node-pty
    const ptyProc = pty.spawn(claudePath, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: workingDir,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        FORCE_COLOR: '1',
        COLORTERM: 'truecolor',
      },
      useConpty: true,
    });

    const name = options.name || workingDir.split(/[/\\]/).pop() || 'Terminal';

    const terminalInfo: InternalTerminal = {
      id: terminalId,
      pty: ptyProc,
      name,
      cwd: workingDir,
      startTime: new Date(),
      resumeSessionId: options.resumeSessionId,
      sessionType: options.sessionType,
    };

    terminals.set(terminalId, terminalInfo);

    // Handle PTY data
    ptyProc.onData((data) => {
      sendToRenderer('terminal-data', { id: terminalId, data });

      // Analyze stream for agent detection and other patterns
      const analyzer = getPTYStreamAnalyzer();
      analyzer.analyze(terminalId, data, options.resumeSessionId);
    });

    // Handle PTY exit
    ptyProc.onExit(({ exitCode }) => {
      sendToRenderer('terminal-exit', { id: terminalId, exitCode });

      // Clean up stream analyzer state for this terminal to prevent memory leaks
      const analyzer = getPTYStreamAnalyzer();
      analyzer.clearTerminal(terminalId);

      // Notify main process about terminal exit for agent cleanup
      // This is sent via the internal event, not to renderer
      import('electron').then(({ ipcMain }) => {
        if (ipcMain?.emit) {
          ipcMain.emit('terminal-exited', null, { terminalId });
        }
      }).catch((error) => {
        logger.error('Failed to emit terminal-exited event', error);
      });

      terminals.delete(terminalId);

      // Log activity for terminal exit
      logActivity(
        'terminal_end',
        options.resumeSessionId || null,
        `Terminal closed: ${name} (exit code: ${exitCode})`,
        { cwd: workingDir, terminalId, exitCode }
      );

      logger.info(`Terminal ${terminalId} exited with code ${exitCode}`);
    });

    // Add to recent projects
    addRecentProject(workingDir, name);

    // Log activity for terminal start
    logActivity(
      'terminal_start',
      options.resumeSessionId || null,
      `Started terminal: ${name}`,
      { cwd: workingDir, terminalId, resumeSessionId: options.resumeSessionId }
    );

    logger.info(`Terminal ${terminalId} started in ${workingDir}`);

    return {
      id: terminalId,
      name,
      cwd: workingDir,
      resumeSessionId: options.resumeSessionId,
      sessionType: options.sessionType,
    };
  } catch (error) {
    logger.error('Failed to start terminal', error);
    return { error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

export async function startPlainTerminal(options: TerminalStartOptions): Promise<TerminalStartResult> {
  try {
    const workingDir = options.cwd || process.cwd();

    // Validate working directory to prevent injection attacks
    if (!isValidWorkingDirectory(workingDir)) {
      logger.error('Invalid working directory for plain terminal', { cwd: workingDir });
      return { error: 'Invalid working directory path' };
    }

    const terminalId = ++terminalIdCounter;

    // Determine shell based on user preference or platform defaults
    const customShell = getSetting<string>('preferredShell');
    const defaultShell = process.platform === 'win32'
      ? process.env.COMSPEC || 'cmd.exe'
      : process.env.SHELL || '/bin/bash';

    // Use custom shell only if it's valid, otherwise fall back to default
    let shell = defaultShell;
    if (customShell) {
      if (isValidShellPath(customShell)) {
        shell = customShell;
      } else {
        logger.warn('Custom shell path is invalid, using default', {
          customShell,
          defaultShell,
        });
      }
    }

    // Final validation of the shell path
    if (!isValidShellPath(shell)) {
      logger.error('Shell path validation failed', { shell });
      return { error: 'Invalid shell configuration' };
    }

    logger.info(`Starting plain terminal with shell: ${shell} (custom: ${!!customShell}) in ${workingDir}`);

    // Spawn shell with node-pty
    const ptyProc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: workingDir,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        FORCE_COLOR: '1',
        COLORTERM: 'truecolor',
      },
      useConpty: process.platform === 'win32',
    });

    const name = options.name || 'Terminal';

    const terminalInfo: InternalTerminal = {
      id: terminalId,
      pty: ptyProc,
      name,
      cwd: workingDir,
      startTime: new Date(),
      isPlainTerminal: true,
    };

    terminals.set(terminalId, terminalInfo);

    // Handle PTY data
    ptyProc.onData((data) => {
      sendToRenderer('terminal-data', { id: terminalId, data });
    });

    // Handle PTY exit
    ptyProc.onExit(({ exitCode }) => {
      sendToRenderer('terminal-exit', { id: terminalId, exitCode });

      // Clean up stream analyzer state for this terminal to prevent memory leaks
      // (Plain terminals may not use analyzer, but cleanup is safe and prevents stale entries)
      const analyzer = getPTYStreamAnalyzer();
      analyzer.clearTerminal(terminalId);

      terminals.delete(terminalId);

      // Log activity for terminal exit
      logActivity(
        'terminal_end',
        null,
        `Plain terminal closed: ${name} (exit code: ${exitCode})`,
        { cwd: workingDir, terminalId, exitCode, isPlainTerminal: true }
      );

      logger.info(`Plain terminal ${terminalId} exited with code ${exitCode}`);
    });

    // Note: Plain terminals do NOT add to recent projects - only Claude sessions do

    // Log activity for terminal start
    logActivity(
      'terminal_start',
      null,
      `Started plain terminal: ${name}`,
      { cwd: workingDir, terminalId, isPlainTerminal: true }
    );

    logger.info(`Plain terminal ${terminalId} started in ${workingDir}`);

    return {
      id: terminalId,
      name,
      cwd: workingDir,
      isPlainTerminal: true,
    };
  } catch (error) {
    logger.error('Failed to start plain terminal', error);
    return { error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// Chunk size for large pastes (4KB is safe for most terminals)
const PASTE_CHUNK_SIZE = 4096;
// Delay between chunks in milliseconds
const PASTE_CHUNK_DELAY_MS = 10;

export function writeToTerminal(id: number, data: string): void {
  const terminal = terminals.get(id);
  if (!terminal) return;

  try {
    // For small data, write directly
    if (data.length <= PASTE_CHUNK_SIZE) {
      terminal.pty.write(data);
      return;
    }

    // For large data, chunk it to prevent buffer overflow
    writeChunked(terminal.pty, data);
  } catch (error) {
    logger.error(`Failed to write to terminal ${id}`, error);
  }
}

/**
 * Write large data in chunks with delays to prevent buffer overflow.
 * This is necessary because node-pty and terminals have buffer size limits.
 */
function writeChunked(ptyProc: pty.IPty, data: string): void {
  let offset = 0;

  const writeNextChunk = () => {
    if (offset >= data.length) return;

    const chunk = data.slice(offset, offset + PASTE_CHUNK_SIZE);
    offset += PASTE_CHUNK_SIZE;

    try {
      ptyProc.write(chunk);

      if (offset < data.length) {
        setTimeout(writeNextChunk, PASTE_CHUNK_DELAY_MS);
      }
    } catch (error) {
      logger.error('Failed to write chunk to terminal', error);
    }
  };

  writeNextChunk();
}

export function resizeTerminal(id: number, cols: number, rows: number): void {
  const terminal = terminals.get(id);
  if (terminal) {
    try {
      terminal.pty.resize(cols, rows);
    } catch (error) {
      logger.error(`Failed to resize terminal ${id}`, error);
    }
  }
}

export function killTerminal(id: number): boolean {
  const terminal = terminals.get(id);
  if (terminal) {
    try {
      terminal.pty.kill();
      terminals.delete(id);
      logger.info(`Terminal ${id} killed`);
      return true;
    } catch (error) {
      logger.error(`Failed to kill terminal ${id}`, error);
    }
  }
  return false;
}

export function getAllTerminals(): TerminalInfo[] {
  const list: TerminalInfo[] = [];
  for (const [id, term] of terminals) {
    list.push({
      id,
      name: term.name,
      cwd: term.cwd,
      startTime: term.startTime,
      resumeSessionId: term.resumeSessionId,
      sessionType: term.sessionType,
      isPlainTerminal: term.isPlainTerminal,
    });
  }
  return list;
}

export function closeAllTerminals(): void {
  for (const [id, term] of terminals) {
    try {
      term.pty.kill();
    } catch (error) {
      logger.error(`Failed to kill terminal ${id} during cleanup`, error);
    }
  }
  terminals.clear();
  logger.info('All terminals closed');
}

export function getTerminalCount(): number {
  return terminals.size;
}
