// ============================================================================
// TERMINAL MANAGER SERVICE
// ============================================================================

import * as pty from 'node-pty';
import { sendToRenderer } from '../window.js';
import { getSetting, logActivity } from '../database/index.js';
import { addRecentProject } from './recentProjects.js';
import { Logger } from './logger.js';
import { getPTYStreamAnalyzer } from './ptyStreamAnalyzer.js';
import type { TerminalInfo, TerminalStartOptions, TerminalStartResult } from '../../shared/types/index.js';

const logger = new Logger('TerminalManager');

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
  logger.info('Terminal manager initialized');
}

// ============================================================================
// TERMINAL OPERATIONS
// ============================================================================

export async function startTerminal(options: TerminalStartOptions): Promise<TerminalStartResult> {
  try {
    const workingDir = options.cwd || process.cwd();
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

    // Add resume flag if resuming a session
    if (options.resumeSessionId) {
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

      // DEBUG: Log data that might contain agent patterns
      // Strip ANSI codes for pattern matching
      const cleanData = data.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
      const hasArrow = data.includes('→') || data.includes('\u2192') || data.includes('\u279C');
      const hasParenthesis = data.includes('(') && data.includes(')');
      const hasKnownAgent = /orchestrator|frontend-ui|backend-data|auth-specialist|fullstack-developer|factory/i.test(cleanData);
      const hasCreateAgent = /Create\s+[\w-]+\s+agent/i.test(cleanData);
      // NEW: Check for Claude CLI agent format: hyphenated-name(task)
      const hasClaudeAgentFormat = /[●·✻✽✶✢*]\s*[a-z][a-z0-9]*(?:-[a-z0-9]+)+\s*\([^)]+\)/i.test(cleanData);
      // NEW: Check for @agent invocation
      const hasAtAgent = /@[a-z][a-z0-9]*(?:-[a-z0-9]+)+\s+/i.test(cleanData);
      // CRITICAL: Check for Task(description) pattern - this indicates subagent activity
      const hasTaskPattern = /Task\s*\(\s*[^)]{3,}\s*\)/i.test(cleanData);

      if (hasArrow || hasKnownAgent || hasCreateAgent || hasClaudeAgentFormat || hasAtAgent || hasTaskPattern) {
        logger.info(`[DEBUG] PTY data with potential agent pattern:`, {
          terminalId,
          hasArrow,
          hasParenthesis,
          hasKnownAgent,
          hasCreateAgent,
          hasClaudeAgentFormat,
          hasAtAgent,
          hasTaskPattern,
          dataPreview: cleanData.substring(0, 200),
        });
      }

      const events = analyzer.analyze(terminalId, data, options.resumeSessionId);

      // DEBUG: Log if any events were detected
      if (events.length > 0) {
        logger.info(`[DEBUG] PTYStreamAnalyzer detected events:`, {
          terminalId,
          eventCount: events.length,
          eventTypes: events.map(e => e.type),
          events: events.map(e => ({ type: e.type, data: e.data })),
        });
      }
    });

    // Handle PTY exit
    ptyProc.onExit(({ exitCode }) => {
      sendToRenderer('terminal-exit', { id: terminalId, exitCode });

      // Notify main process about terminal exit for agent cleanup
      // This is sent via the internal event, not to renderer
      import('electron').then(({ ipcMain }) => {
        ipcMain.emit('terminal-exited', null, { terminalId });
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
    const terminalId = ++terminalIdCounter;

    // Determine shell based on platform
    const shell = process.platform === 'win32'
      ? process.env.COMSPEC || 'cmd.exe'
      : process.env.SHELL || '/bin/bash';

    logger.info(`Starting plain terminal with shell: ${shell} in ${workingDir}`);

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

export function writeToTerminal(id: number, data: string): void {
  const terminal = terminals.get(id);
  if (terminal) {
    try {
      terminal.pty.write(data);
    } catch (error) {
      logger.error(`Failed to write to terminal ${id}`, error);
    }
  }
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
