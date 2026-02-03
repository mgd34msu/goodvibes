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
  getKnownSessionPaths,
  getKnownSessionPathsWithMtime,
  clearDetailedToolUsage,
  batchRecordDetailedToolUsage,
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
  private readonly SESSION_UPDATE_THROTTLE_MS = 250; // Max 4 updates/sec
  private claudeDir: string;
  private statusCallback: StatusCallback;
  private watchedSessions = new Map<string, boolean>();
  private knownSessionFiles = new Set<string>();
  private sessionWatchInterval: NodeJS.Timeout | null = null;
  private lastUpdateTime = new Map<string, number>();

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

    // Process files in batches for better throughput
    const BATCH_SIZE = 10;
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      this.statusCallback('scanning', `Processing batch ${Math.floor(i / BATCH_SIZE) + 1}`, { current: i + 1, total });

      await Promise.all(
        batch.map(file =>
          this.processSessionFile(file.path, file.mtime)
            .then(() => {
              this.knownSessionFiles.add(file.path);
            })
            .catch(err => {
              logger.error(`Failed to process: ${file.path}`, err);
            })
        )
      );
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

    const { messages, tokenStats, costUSD, model, toolUsage, detailedToolUsage } = await parseSessionFileWithStats(filePath);

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
    // Pass startTime to use historical pricing from when the session started
    const totalCost = costUSD > 0 ? costUSD : await calculateCost(tokenStats, model, startTime || undefined);

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

    // Record detailed tool usage with token attribution
    clearDetailedToolUsage(filename);
    if (detailedToolUsage.length > 0) {
      batchRecordDetailedToolUsage(
        detailedToolUsage.map(usage => ({
          sessionId: filename,
          toolName: usage.toolName,
          toolInput: usage.toolInput,
          toolResultPreview: usage.toolResultPreview,
          success: usage.success,
          durationMs: usage.durationMs,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          cacheReadTokens: usage.cacheReadTokens,
          tokenCost: usage.tokenCost,
          costUsd: usage.costUsd,
          messageId: usage.messageId,
          requestId: usage.requestId,
          entryHash: usage.entryHash,
          toolIndex: usage.toolIndex,
          model: usage.model,
          timestamp: usage.timestamp,
        }))
      );
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

  private cleanupDeletedSessions(): void {
    for (const [filePath] of this.watchedSessions) {
      if (!existsSync(filePath)) {
        try {
          unwatchFile(filePath);
        } catch (e) {
          // File may already be unwatched
        }
        this.watchedSessions.delete(filePath);
        this.knownSessionFiles.delete(filePath);
        logger.debug('Cleaned up deleted session file', { filePath });
      }
    }
  }

  private async scanForNewSessions(): Promise<void> {
    if (!existsSync(this.claudeDir)) return;

    // Cleanup deleted sessions before scanning for new ones
    this.cleanupDeletedSessions();

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

  private startWatchingSessionFile(filePath: string, sessionId?: string): void {
    if (this.watchedSessions.has(filePath)) {
      logger.debug('Session file already being watched', { filePath, sessionId });
      return;
    }

    logger.info('Starting file watcher for session', { filePath, sessionId });
    let lastSize = 0;

    watchFile(filePath, { interval: SESSION_FILE_WATCH_INTERVAL_MS }, async () => {
      try {
        // Check if file still exists
        if (!existsSync(filePath)) {
          logger.debug('Session file deleted, cleaning up watcher', { filePath, sessionId });
          unwatchFile(filePath);
          this.watchedSessions.delete(filePath);
          this.knownSessionFiles.delete(filePath);
          this.lastUpdateTime.delete(filePath);
          return;
        }

        const stats = await fs.stat(filePath);
        if (stats.size !== lastSize) {
          // Throttle updates to max 4 per second
          const now = Date.now();
          const lastUpdate = this.lastUpdateTime.get(filePath) || 0;
          if (now - lastUpdate < this.SESSION_UPDATE_THROTTLE_MS) {
            logger.debug('Session update throttled', { filePath, sessionId, timeSinceLastUpdate: now - lastUpdate });
            return;
          }
          
          logger.debug('Session file changed', { filePath, sessionId, oldSize: lastSize, newSize: stats.size });
          lastSize = stats.size;
          this.lastUpdateTime.set(filePath, now);
          const { messages } = await parseSessionFileWithStats(filePath);

          logger.debug('Sending session update event', { filePath, sessionId, messageCount: messages.length });
          sendToRenderer('subagent-session-update', {
            path: filePath,
            sessionId,
            messages,
            isLive: true,
          });
        }
      } catch (error) {
        logger.debug('Session file watch error (file may have been deleted)', {
          filePath,
          error: error instanceof Error ? error.message : 'Unknown error'
        });

        // If error occurred, check if file was deleted and cleanup
        if (!existsSync(filePath)) {
          try {
            unwatchFile(filePath);
            this.watchedSessions.delete(filePath);
            this.knownSessionFiles.delete(filePath);
            this.lastUpdateTime.delete(filePath);
            logger.debug('Cleaned up watcher for deleted file after error', { filePath, sessionId });
          } catch (cleanupError) {
            // Ignore cleanup errors
          }
        }
      }
    });

    this.watchedSessions.set(filePath, true);
  }

  /**
   * Start watching a session for file changes.
   * Returns the file path being watched, or null if session not found.
   */
  watchSession(sessionId: string): string | null {
    const session = getSession(sessionId);
    if (!session?.filePath || !existsSync(session.filePath)) {
      return null;
    }
    this.startWatchingSessionFile(session.filePath, sessionId);
    return session.filePath;
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

  /**
   * Force a full rescan of all session files.
   * This picks up new sessions that started after the app opened.
   */
  async rescanSessions(): Promise<void> {
    await this.scanSessions();
  }

  /**
   * Scan for new sessions AND detect resumed sessions via mtime comparison.
   * Returns { newCount, updatedCount } for UI feedback.
   */
  public async refreshSessions(): Promise<{ newCount: number; updatedCount: number }> {
    if (!existsSync(this.claudeDir)) return { newCount: 0, updatedCount: 0 };

    try {
      // Get known paths WITH mtimes (not just paths)
      const knownPathsWithMtime = getKnownSessionPathsWithMtime();
      
      // Find all session files in directory
      const allFiles = await this.findSessionFiles(this.claudeDir);
      
      // Separate into new files and modified files
      const newFiles: typeof allFiles = [];
      const modifiedFiles: typeof allFiles = [];
      
      for (const file of allFiles) {
        const knownMtime = knownPathsWithMtime.get(file.path);
        if (knownMtime === undefined) {
          // New file - not in database
          newFiles.push(file);
        } else if (knownMtime !== file.mtime) {
          // Modified file - mtime differs from database
          modifiedFiles.push(file);
        }
        // else: unchanged - skip
      }
      
      let newCount = 0;
      let updatedCount = 0;
      
      // Process new files
      for (const file of newFiles) {
        try {
          await this.processSessionFile(file.path, file.mtime);
          this.knownSessionFiles.add(file.path);
          newCount++;
          
          // Start watching if recent
          const age = Date.now() - file.mtime;
          if (age < NEW_SESSION_THRESHOLD_MS) {
            this.notifyNewSession(file.path);
            this.startWatchingSessionFile(file.path);
          }
        } catch (error) {
          logger.error(`Failed to process new session file: ${file.path}`, error);
        }
      }
      
      // Process modified (resumed) files
      for (const file of modifiedFiles) {
        try {
          await this.processSessionFile(file.path, file.mtime);
          updatedCount++;
          logger.info(`Updated resumed session: ${file.path}`);
        } catch (error) {
          logger.error(`Failed to update resumed session: ${file.path}`, error);
        }
      }
      
      if (newCount > 0 || updatedCount > 0) {
        logger.info(`Session refresh: ${newCount} new, ${updatedCount} updated`);
      }
      
      return { newCount, updatedCount };
    } catch (error) {
      logger.error('Error refreshing sessions', error);
      return { newCount: 0, updatedCount: 0 };
    }
  }

  /**
   * Incrementally scan for NEW sessions only - does not re-process existing sessions.
   * Uses database to check which files have already been processed.
   * Returns the count of new sessions found.
   * @deprecated Use refreshSessions() instead for detecting both new and resumed sessions.
   */
  public async scanNewSessionsOnly(): Promise<number> {
    const { newCount } = await this.refreshSessions();
    return newCount;
  }

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

  async getSessionRawEntries(sessionId: string, afterIndex?: number): Promise<unknown[]> {
    const session = getSession(sessionId);
    if (!session?.filePath || !existsSync(session.filePath)) {
      return [];
    }

    try {
      const content = await fs.readFile(session.filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.trim());
      const entries: unknown[] = [];

      // If afterIndex provided, skip entries up to that index (for incremental fetching)
      const startIndex = afterIndex !== undefined && afterIndex >= 0 ? afterIndex : 0;

      for (let i = startIndex; i < lines.length; i++) {
        const line = lines[i];
        try {
          const entry = JSON.parse(line);
          entries.push(entry);
        } catch (error) {
          logger.debug('Skipped malformed JSON line in raw entries', {
            sessionId,
            lineIndex: i,
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
