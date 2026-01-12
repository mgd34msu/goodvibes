// ============================================================================
// SESSION MANAGER SERVICE
// ============================================================================

import fs from 'fs/promises';
import { existsSync, watchFile, unwatchFile } from 'fs';
import path from 'path';
import os from 'os';
import { formatTimestamp } from '../../../shared/dateUtils.js';
import {
  upsertSession,
  storeMessages,
  getSession,
  getAllSessions,
  getSessionMessages,
  getAnalytics,
  logActivity,
  trackToolUsage,
  clearSessionToolUsage,
} from '../../database/index.js';
import { sendToRenderer } from '../../window.js';
import { Logger } from '../logger.js';
import {
  SESSION_SCAN_INTERVAL_MS,
  NEW_SESSION_THRESHOLD_MS,
  LIVE_SESSION_THRESHOLD_MS,
  SESSION_FILE_WATCH_INTERVAL_MS,
  LIVE_SESSION_CHECK_THRESHOLD_MS,
} from '../../../shared/constants.js';
import type { Session, SessionMessage, StatusCallback, SessionFile } from './types.js';
import { parseSessionFileWithStats } from './parser.js';
import { calculateCost } from './cost.js';

const logger = new Logger('SessionManager');

// ============================================================================
// SESSION MANAGER CLASS
// ============================================================================

export class SessionManagerInstance {
  private claudeDir: string;
  private statusCallback: StatusCallback;
  private watchedSessions = new Map<string, boolean>();
  private knownSessionFiles = new Set<string>();
  private sessionWatchInterval: NodeJS.Timeout | null = null;

  constructor(statusCallback: StatusCallback) {
    this.claudeDir = path.join(os.homedir(), '.claude', 'projects');
    this.statusCallback = statusCallback;
  }

  async init(): Promise<void> {
    logger.info('Initializing session manager...');

    if (!existsSync(this.claudeDir)) {
      logger.warn(`Claude directory not found: ${this.claudeDir}`);
      this.statusCallback('complete', 'No sessions found');
      return;
    }

    try {
      await this.scanSessions();
      this.startSessionWatching();
      logger.info('Session manager initialized');
    } catch (error) {
      logger.error('Failed to initialize session manager', error);
      this.statusCallback('error', 'Failed to scan sessions');
    }
  }

  private async scanSessions(): Promise<void> {
    this.statusCallback('scanning', 'Scanning for sessions...');

    const files = await this.findSessionFiles(this.claudeDir);
    const total = files.length;

    logger.info(`Found ${total} session files`);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      this.statusCallback('scanning', `Processing ${path.basename(file.path)}`, { current: i + 1, total });

      try {
        await this.processSessionFile(file.path, file.mtime);
        this.knownSessionFiles.add(file.path);
      } catch (error) {
        logger.error(`Failed to process session file: ${file.path}`, error);
      }
    }

    this.statusCallback('complete', `Scanned ${total} sessions`);
  }

  private async findSessionFiles(dir: string): Promise<SessionFile[]> {
    const files: SessionFile[] = [];

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          const subFiles = await this.findSessionFiles(fullPath);
          files.push(...subFiles);
        } else if (entry.name.endsWith('.jsonl')) {
          try {
            const stats = await fs.stat(fullPath);
            files.push({ path: fullPath, mtime: stats.mtimeMs });
          } catch (error) {
            logger.debug('Could not stat session file', {
              filePath: fullPath,
              error: error instanceof Error ? error.message : 'Unknown error'
            });
          }
        }
      }
    } catch (error) {
      logger.debug('Could not read directory', {
        dir,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }

    return files.sort((a, b) => b.mtime - a.mtime);
  }

  private async processSessionFile(filePath: string, mtime: number, forceReparse: boolean = false): Promise<void> {
    const filename = path.basename(filePath, '.jsonl');
    const projectName = path.basename(path.dirname(filePath));

    const existingSession = getSession(filename);

    // Force reparse if session has no token data
    const needsTokenReparse = existingSession && existingSession.tokenCount === 0 && existingSession.messageCount > 0;

    if (!forceReparse && !needsTokenReparse && existingSession?.fileMtime === mtime) {
      return;
    }

    const { messages, tokenStats, costUSD, model, toolUsage } = await parseSessionFileWithStats(filePath);

    // Calculate session stats
    let startTime: string | null = null;
    let endTime: string | null = null;

    for (const msg of messages) {
      if (msg.timestamp) {
        if (!startTime || msg.timestamp < startTime) startTime = msg.timestamp;
        if (!endTime || msg.timestamp > endTime) endTime = msg.timestamp;
      }
    }

    // Calculate total tokens
    const totalTokens = tokenStats.inputTokens + tokenStats.outputTokens +
      tokenStats.cacheWriteTokens + tokenStats.cacheReadTokens;

    // Use actual cost from JSONL if available, otherwise calculate
    const totalCost = costUSD > 0 ? costUSD : calculateCost(tokenStats, model);

    // Upsert session
    upsertSession({
      id: filename,
      projectName,
      filePath,
      startTime,
      endTime,
      messageCount: messages.length,
      tokenCount: totalTokens,
      cost: totalCost,
      status: 'completed',
      fileMtime: mtime,
      inputTokens: tokenStats.inputTokens,
      outputTokens: tokenStats.outputTokens,
      cacheWriteTokens: tokenStats.cacheWriteTokens,
      cacheReadTokens: tokenStats.cacheReadTokens,
    });

    // Store messages
    storeMessages(filename, messages);

    // Track tool usage
    clearSessionToolUsage(filename);
    for (const [toolName, count] of toolUsage) {
      trackToolUsage(filename, toolName, count);
    }
  }

  // ============================================================================
  // SESSION WATCHING
  // ============================================================================

  private startSessionWatching(): void {
    if (this.sessionWatchInterval) return;

    this.sessionWatchInterval = setInterval(() => {
      this.scanForNewSessions();
    }, SESSION_SCAN_INTERVAL_MS);
  }

  private async scanForNewSessions(): Promise<void> {
    if (!existsSync(this.claudeDir)) return;

    try {
      const files = await this.findSessionFiles(this.claudeDir);

      for (const file of files) {
        if (!this.knownSessionFiles.has(file.path)) {
          this.knownSessionFiles.add(file.path);

          const age = Date.now() - file.mtime;
          if (age < NEW_SESSION_THRESHOLD_MS) {
            this.notifyNewSession(file.path);
            this.startWatchingSessionFile(file.path);
          }
        }
      }
    } catch (error) {
      logger.error('Error scanning for new sessions', error);
    }
  }

  private notifyNewSession(filePath: string): void {
    const projectName = path.basename(path.dirname(filePath));
    const filename = path.basename(filePath, '.jsonl');
    const isAgent = filename.startsWith('agent-');

    logActivity(
      'session_detected',
      filename,
      `New ${isAgent ? 'subagent' : 'user'} session detected: ${filename}`,
      { projectName, filePath, isAgent }
    );

    sendToRenderer('session-detected', {
      path: filePath,
      projectName,
      sessionType: isAgent ? 'subagent' : 'user',
      sessionId: filename,
      timestamp: Date.now(),
    });
  }

  private startWatchingSessionFile(filePath: string): void {
    if (this.watchedSessions.has(filePath)) return;

    let lastSize = 0;

    watchFile(filePath, { interval: SESSION_FILE_WATCH_INTERVAL_MS }, async () => {
      try {
        const stats = await fs.stat(filePath);
        if (stats.size !== lastSize) {
          lastSize = stats.size;
          const { messages } = await parseSessionFileWithStats(filePath);

          sendToRenderer('subagent-session-update', {
            path: filePath,
            messages,
            isLive: true,
          });
        }
      } catch (error) {
        logger.debug('Session file watch error (file may have been deleted)', {
          filePath,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    this.watchedSessions.set(filePath, true);
  }

  stopWatching(): void {
    if (this.sessionWatchInterval) {
      clearInterval(this.sessionWatchInterval);
      this.sessionWatchInterval = null;
    }

    for (const [filePath] of this.watchedSessions) {
      try {
        unwatchFile(filePath);
      } catch (error) {
        logger.debug('Could not unwatch session file', {
          filePath,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }
    this.watchedSessions.clear();
  }

  // ============================================================================
  // PUBLIC API
  // ============================================================================

  getAllSessions(): Session[] {
    return getAllSessions();
  }

  getSession(sessionId: string): Session | null {
    return getSession(sessionId);
  }

  async getSessionMessages(sessionId: string): Promise<SessionMessage[]> {
    const dbMessages = getSessionMessages(sessionId);
    if (dbMessages.length > 0) {
      return dbMessages;
    }

    const session = getSession(sessionId);
    if (session?.filePath && existsSync(session.filePath)) {
      try {
        const { messages: parsedMessages } = await parseSessionFileWithStats(session.filePath);
        if (parsedMessages.length > 0) {
          storeMessages(sessionId, parsedMessages);
        }
        return parsedMessages.map((msg, index) => ({
          id: index,
          sessionId,
          messageIndex: index,
          role: msg.role ?? 'unknown',
          content: msg.content ?? '',
          timestamp: msg.timestamp ?? null,
          tokenCount: msg.tokenCount ?? 0,
          toolName: msg.toolName ?? null,
          toolInput: msg.toolInput ?? null,
          toolResult: msg.toolResult ?? null,
          createdAt: formatTimestamp(),
        }));
      } catch (error) {
        logger.error(`Failed to read messages from file for session ${sessionId}`, error);
      }
    }

    return [];
  }

  getAnalytics() {
    return getAnalytics();
  }

  getLiveSessions(): Session[] {
    const threshold = Date.now() - LIVE_SESSION_THRESHOLD_MS;
    return this.getAllSessions().filter(s => {
      if (!s.endTime) return false;
      return new Date(s.endTime).getTime() > threshold;
    });
  }

  async getSessionRawEntries(sessionId: string): Promise<unknown[]> {
    const session = getSession(sessionId);
    if (!session?.filePath || !existsSync(session.filePath)) {
      return [];
    }

    try {
      const content = await fs.readFile(session.filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.trim());
      const entries: unknown[] = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          entries.push(entry);
        } catch (error) {
          logger.debug('Skipped malformed JSON line in raw entries', {
            sessionId,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }

      return entries;
    } catch (error) {
      logger.error(`Failed to read raw entries for session ${sessionId}`, error);
      return [];
    }
  }

  async refreshSessionTokens(sessionId: string): Promise<Session | null> {
    const session = getSession(sessionId);
    if (!session?.filePath || !existsSync(session.filePath)) {
      return session;
    }

    try {
      const stats = await fs.stat(session.filePath);
      await this.processSessionFile(session.filePath, stats.mtimeMs, true);
      return getSession(sessionId);
    } catch (error) {
      logger.error(`Failed to refresh session tokens for ${sessionId}`, error);
      return session;
    }
  }

  async recalculateAllCosts(): Promise<number> {
    const sessions = getAllSessions();
    let count = 0;

    logger.info(`Starting cost recalculation for ${sessions.length} sessions`);

    for (const session of sessions) {
      if (session.filePath && existsSync(session.filePath)) {
        try {
          const stats = await fs.stat(session.filePath);
          await this.processSessionFile(session.filePath, stats.mtimeMs, true);
          count++;
        } catch (error) {
          logger.error(`Failed to recalculate costs for session ${session.id}`, error);
        }
      }
    }

    logger.info(`Completed cost recalculation for ${count} sessions`);
    return count;
  }

  isSessionLive(sessionId: string): boolean {
    const session = getSession(sessionId);
    if (!session?.filePath || !existsSync(session.filePath)) {
      return false;
    }

    if (session.fileMtime) {
      return Date.now() - session.fileMtime < LIVE_SESSION_CHECK_THRESHOLD_MS;
    }
    return false;
  }

  async isSessionLiveAsync(sessionId: string): Promise<boolean> {
    const session = getSession(sessionId);
    if (!session?.filePath || !existsSync(session.filePath)) {
      return false;
    }

    try {
      const stats = await fs.stat(session.filePath);
      return Date.now() - stats.mtimeMs < LIVE_SESSION_CHECK_THRESHOLD_MS;
    } catch (error) {
      logger.debug('Could not stat session file for live check', {
        sessionId,
        filePath: session.filePath,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return false;
    }
  }
}
