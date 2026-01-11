// ============================================================================
// SESSION MANAGER SERVICE
// ============================================================================

import fs from 'fs/promises';
import { existsSync, watchFile, unwatchFile } from 'fs';
import path from 'path';
import os from 'os';
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
} from '../database/index.js';

// ============================================================================
// INLINE TOOL PARSER (avoids build/bundling issues with shared module)
// ============================================================================

function parseMcpCliTool(toolRef: string): string | null {
  if (!toolRef || typeof toolRef !== 'string') {
    return null;
  }
  const parts = toolRef.split('/');
  if (parts.length !== 2) {
    return `mcp-cli: ${toolRef}`;
  }
  const server = parts[0];
  const tool = parts[1];
  if (!server || !tool) {
    return `mcp-cli: ${toolRef}`;
  }
  const isGoodvibes = server.toLowerCase().includes('goodvibes');
  if (isGoodvibes) {
    return `goodvibes - ${tool}`;
  }
  return `mcp:${server} - ${tool}`;
}

function parseBashCommand(command: string): string[] {
  if (!command || typeof command !== 'string') {
    logger.debug('[TOOL_PARSE] No command or not string', { command });
    return ['Bash'];
  }
  const tools: string[] = [];
  logger.debug('[TOOL_PARSE] Parsing command', { command: command.substring(0, 100) });

  // Check for mcp-cli calls first (highest priority)
  const mcpMatch = command.match(/mcp-cli\s+(?:call|info)\s+([^\s'"]+)/);
  // Also match mcp-cli tools, servers, grep, resources, read
  const mcpOtherMatch = command.match(/^mcp-cli\s+(tools|servers|grep|resources|read)\b/i);
  if (mcpOtherMatch) {
    return [`mcp-cli ${mcpOtherMatch[1]}`];
  }
  if (mcpMatch && mcpMatch[1]) {
    const mcpTool = parseMcpCliTool(mcpMatch[1]);
    if (mcpTool) {
      tools.push(mcpTool);
    }
  }
  if (tools.length > 0) {
    return tools;
  }

  // Extract the first command (handle cd prefix - including Windows cd /d)
  const cleanedCommand = command
    .replace(/^cd\s+\/d\s+"[^"]+"\s*&&\s*/i, '')  // Windows: cd /d "path" &&
    .replace(/^cd\s+\/d\s+[^\s]+\s*&&\s*/i, '')   // Windows: cd /d path &&
    .replace(/^cd\s+"[^"]+"\s*&&\s*/i, '')        // Unix: cd "path" &&
    .replace(/^cd\s+[^\s]+\s*&&\s*/i, '')         // Unix: cd path &&
    .trim();

  const commandPatterns: Array<{ pattern: RegExp; name: string | ((match: RegExpMatchArray) => string) }> = [
    { pattern: /^git\s+(add|commit|push|pull|fetch|merge|rebase|checkout|branch|status|diff|log|stash|reset|cherry-pick|clone|init|tag|remote)/i, name: (m) => `git ${m[1] ?? ''}` },
    { pattern: /^git\s+/i, name: 'git' },
    { pattern: /^npm\s+(install|run|test|build|start|publish|update|outdated|audit|ci|init|link|pack|uninstall)/i, name: (m) => `npm ${m[1] ?? ''}` },
    { pattern: /^npm\s+/i, name: 'npm' },
    { pattern: /^pnpm\s+(install|run|test|build|add|remove|update)/i, name: (m) => `pnpm ${m[1] ?? ''}` },
    { pattern: /^pnpm\s+/i, name: 'pnpm' },
    { pattern: /^yarn\s+(add|remove|install|run|build|test|start)/i, name: (m) => `yarn ${m[1] ?? ''}` },
    { pattern: /^yarn\s+/i, name: 'yarn' },
    { pattern: /^bun\s+(install|run|test|build|add|remove)/i, name: (m) => `bun ${m[1] ?? ''}` },
    { pattern: /^bun\s+/i, name: 'bun' },
    { pattern: /^(vitest|jest|mocha|playwright|cypress)/i, name: (m) => (m[1] ?? 'unknown').toLowerCase() },
    { pattern: /^(tsc|typescript|eslint|prettier|biome)/i, name: (m) => (m[1] ?? 'unknown').toLowerCase() },
    { pattern: /^(vite|webpack|rollup|esbuild|turbo)/i, name: (m) => (m[1] ?? 'unknown').toLowerCase() },
    { pattern: /^docker(-compose)?\s+(build|run|exec|ps|logs|pull|push|start|stop|up|down)/i, name: (m) => `docker ${m[2] ?? ''}` },
    { pattern: /^docker(-compose)?\s+/i, name: 'docker' },
    { pattern: /^kubectl\s+(get|apply|delete|describe|logs|exec|port-forward)/i, name: (m) => `kubectl ${m[1] ?? ''}` },
    { pattern: /^kubectl\s+/i, name: 'kubectl' },
    { pattern: /^(curl|wget|gh|az|aws|gcloud|terraform|pulumi)/i, name: (m) => (m[1] ?? 'unknown').toLowerCase() },
    { pattern: /^(python|python3|node|deno|bun|ruby|go|cargo|rustc)/i, name: (m) => (m[1] ?? 'unknown').toLowerCase() },
    { pattern: /^(powershell|pwsh|cmd)/i, name: (m) => (m[1] ?? 'unknown').toLowerCase() },
    { pattern: /^(mkdir|rm|rmdir|mv|cp|touch|chmod|chown)/i, name: (m) => (m[1] ?? 'unknown').toLowerCase() },
    { pattern: /^(cat|head|tail|less|more|grep|find|ls|dir)/i, name: (m) => (m[1] ?? 'unknown').toLowerCase() },
    { pattern: /^(taskkill|tasklist|netstat|ipconfig|ping)/i, name: (m) => (m[1] ?? 'unknown').toLowerCase() },
    // npx commands (must be before bun since bun pattern might also match)
    { pattern: /^npx\s+(\S+)/i, name: (m) => `npx ${m[1] ?? ''}` },
    // Windows-specific commands
    { pattern: /^(rd|del|copy|move|type|where|attrib|icacls)/i, name: (m) => (m[1] ?? 'unknown').toLowerCase() },
    { pattern: /^(echo|set|setx|cls|exit|pause)/i, name: (m) => (m[1] ?? 'unknown').toLowerCase() },
    // SQLite
    { pattern: /^sqlite3?\s+/i, name: 'sqlite' },
    // Shell utilities
    { pattern: /^(wc|timeout|sleep|pkill|kill)\b/i, name: (m) => (m[1] ?? 'unknown').toLowerCase() },
    // Command check
    { pattern: /^command\s+-v\s+/i, name: 'command' },
  ];

  for (const { pattern, name } of commandPatterns) {
    const match = cleanedCommand.match(pattern);
    if (match) {
      const toolName = typeof name === 'function' ? name(match) : name;
      tools.push(toolName);
      break;
    }
  }
  return tools.length > 0 ? tools : ['Bash'];
}

function resolveToolNames(toolName: string, toolInput: Record<string, unknown> | null): string[] {
  if (toolName === 'Bash' && toolInput && typeof toolInput.command === 'string') {
    return parseBashCommand(toolInput.command);
  }
  return [toolName];
}
import { sendToRenderer } from '../window.js';
import { Logger } from './logger.js';
import {
  SESSION_SCAN_INTERVAL_MS,
  NEW_SESSION_THRESHOLD_MS,
  LIVE_SESSION_THRESHOLD_MS,
  SESSION_FILE_WATCH_INTERVAL_MS,
  LIVE_SESSION_CHECK_THRESHOLD_MS,
  MODEL_PRICING,
  CACHE_WRITE_MULTIPLIER,
  CACHE_READ_MULTIPLIER,
  DEFAULT_INPUT_PRICE,
  DEFAULT_OUTPUT_PRICE,
} from '../../shared/constants.js';
import type { Session, SessionMessage } from '../../shared/types/index.js';

const logger = new Logger('SessionManager');

type StatusCallback = (status: string, message?: string, progress?: { current: number; total: number }) => void;

let sessionManager: SessionManagerInstance | null = null;

// ============================================================================
// SESSION MANAGER CLASS
// ============================================================================

class SessionManagerInstance {
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

  private async findSessionFiles(dir: string): Promise<{ path: string; mtime: number }[]> {
    const files: { path: string; mtime: number }[] = [];

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

    // Check if we need to update this session (unless force reparse is requested)
    const existingSession = getSession(filename);

    // Force reparse if the session exists but has no token data (legacy sessions
    // scanned before token extraction was implemented). This ensures all sessions
    // eventually get their token data populated.
    const needsTokenReparse = existingSession && existingSession.tokenCount === 0 && existingSession.messageCount > 0;

    if (!forceReparse && !needsTokenReparse && existingSession?.fileMtime === mtime) {
      return; // Session hasn't changed and has valid token data
    }

    const { messages, tokenStats, costUSD, model, toolUsage } = await this.parseSessionFileWithStats(filePath);

    // Calculate session stats
    let startTime: string | null = null;
    let endTime: string | null = null;

    for (const msg of messages) {
      if (msg.timestamp) {
        if (!startTime || msg.timestamp < startTime) startTime = msg.timestamp;
        if (!endTime || msg.timestamp > endTime) endTime = msg.timestamp;
      }
    }

    // Calculate total tokens (including cache tokens)
    const totalTokens = tokenStats.inputTokens + tokenStats.outputTokens +
      tokenStats.cacheWriteTokens + tokenStats.cacheReadTokens;

    // Use actual cost from JSONL if available, otherwise calculate based on model
    const totalCost = costUSD > 0 ? costUSD : this.calculateCost(tokenStats, model);

    // Upsert session with token breakdown
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

    // Track tool usage for analytics (clear existing data first to avoid duplicates on re-parse)
    clearSessionToolUsage(filename);
    for (const [toolName, count] of toolUsage) {
      trackToolUsage(filename, toolName, count);
    }
  }

  private async parseSessionFileWithStats(filePath: string): Promise<{
    messages: Partial<SessionMessage>[];
    tokenStats: {
      inputTokens: number;
      outputTokens: number;
      cacheWriteTokens: number;
      cacheReadTokens: number;
    };
    costUSD: number;
    model: string | null;
    toolUsage: Map<string, number>;
  }> {
    const messages: Partial<SessionMessage>[] = [];
    let tokenStats = {
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    };
    let costUSD = 0;
    let model: string | null = null;
    const toolUsage = new Map<string, number>();

    try {
      const content = await fs.readFile(filePath, 'utf-8');

      // Use regex-based token extraction for robustness (like the JS version)
      // This finds all token counts regardless of JSON structure
      const sumTokens = (regex: RegExp): number => {
        const matches = content.match(regex) || [];
        return matches.reduce((acc, m) => {
          const numMatch = m.match(/\d+/);
          return acc + (numMatch ? parseInt(numMatch[0], 10) : 0);
        }, 0);
      };

      tokenStats = {
        inputTokens: sumTokens(/"input_tokens"\s*:\s*\d+/g),
        outputTokens: sumTokens(/"output_tokens"\s*:\s*\d+/g),
        cacheWriteTokens: sumTokens(/"cache_creation_input_tokens"\s*:\s*\d+/g),
        cacheReadTokens: sumTokens(/"cache_read_input_tokens"\s*:\s*\d+/g),
      };

      // Extract model name (use the first model found in the session)
      const modelMatch = content.match(/"model"\s*:\s*"([^"]+)"/);
      if (modelMatch) {
        model = modelMatch[1] ?? null;
      }

      // Extract cost using regex as well for robustness
      const costMatches = content.match(/"costUSD"\s*:\s*[\d.]+/g) || [];
      costUSD = costMatches.reduce((acc, m) => {
        const numMatch = m.match(/[\d.]+$/);
        return acc + (numMatch ? parseFloat(numMatch[0]) : 0);
      }, 0);

      // Parse messages line by line
      const lines = content.trim().split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const parsed = this.parseEntry(entry);
          if (parsed) {
            messages.push(parsed);
          }

          // Extract tool usage from tool_use entries
          this.extractToolUsage(entry, toolUsage);
        } catch (error) {
          // Skip malformed JSON lines - this is expected for partially written files
          logger.debug('Skipped malformed JSON line in session file', {
            filePath,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }
    } catch (error) {
      logger.error(`Failed to parse session file: ${filePath}`, error);
    }

    return { messages, tokenStats, costUSD, model, toolUsage };
  }

  /**
   * Extract tool usage from a session entry and update the toolUsage map.
   * Handles nested tool_use in message.content arrays and direct tool_use entries.
   */
  private extractToolUsage(entry: any, toolUsage: Map<string, number>): void {
    // Check for direct tool_use entry
    if (entry.type === 'tool_use' || entry.tool_use) {
      const tool = entry.tool_use || entry;
      const toolName = tool.name;
      const toolInput = tool.input;

      if (toolName) {
        const resolvedNames = resolveToolNames(toolName, toolInput);
        for (const name of resolvedNames) {
          toolUsage.set(name, (toolUsage.get(name) || 0) + 1);
        }
      }
    }

    // Check for tool_use in message.content array
    if (entry.message?.content && Array.isArray(entry.message.content)) {
      for (const block of entry.message.content) {
        if (block.type === 'tool_use' && block.name) {
          const resolvedNames = resolveToolNames(block.name, block.input);
          for (const name of resolvedNames) {
            toolUsage.set(name, (toolUsage.get(name) || 0) + 1);
          }
        }
      }
    }
  }

  private async parseSessionFile(filePath: string): Promise<Partial<SessionMessage>[]> {
    const { messages } = await this.parseSessionFileWithStats(filePath);
    return messages;
  }

  private parseEntry(entry: any): Partial<SessionMessage> | null {
    let role = entry.type || entry.role || 'unknown';
    let content = '';
    let tokenCount = 0;

    // Extract token count from usage data
    if (entry.usage) {
      tokenCount = (entry.usage.input_tokens ?? 0) + (entry.usage.output_tokens ?? 0);
    }

    // Handle different entry types
    if (entry.type === 'thinking' || entry.thinking) {
      role = 'thinking';
      content = entry.thinking || entry.content || '';
    } else if (entry.type === 'tool_use' || entry.tool_use) {
      role = 'tool';
      const tool = entry.tool_use || entry;
      content = `[Tool: ${tool.name || 'unknown'}]\n${JSON.stringify(tool.input || {}, null, 2)}`;
    } else if (entry.type === 'tool_result' || entry.tool_result) {
      role = 'tool_result';
      const result = entry.tool_result || entry;
      content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content || result, null, 2);
    } else if (entry.message !== undefined) {
      content = this.extractContent(entry.message);
    } else if (entry.content) {
      content = typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content);
    }

    if (!content.trim()) return null;

    return {
      role,
      content,
      timestamp: entry.timestamp,
      tokenCount,
    };
  }

  private extractContent(message: any): string {
    if (typeof message === 'string') return message;

    if (Array.isArray(message)) {
      return message
        .map(block => {
          if (typeof block === 'string') return block;
          if (block.type === 'text') return block.text || '';
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }

    if (typeof message === 'object') {
      if (message.content) return this.extractContent(message.content);
      if (message.text) return message.text;
    }

    return '';
  }

  /**
   * Calculates the cost of a session based on token usage and model.
   * Uses model-specific pricing and proper cache token multipliers.
   *
   * Pricing source: https://platform.claude.com/docs/en/about-claude/pricing
   */
  private calculateCost(
    tokenStats: { inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number },
    model: string | null
  ): number {
    // Normalize model name to match our pricing keys
    // e.g., "claude-opus-4-5-20251101" -> "claude-opus-4-5"
    const normalizedModel = model
      ? model.replace(/-\d{8}$/, '').replace(/_/g, '-')
      : null;

    // Get pricing for this model, fall back to defaults
    const pricing = (normalizedModel && MODEL_PRICING[normalizedModel]) || {
      input: DEFAULT_INPUT_PRICE,
      output: DEFAULT_OUTPUT_PRICE,
    };

    // Calculate costs per token type
    const inputCost = (tokenStats.inputTokens * pricing.input) / 1_000_000;
    const outputCost = (tokenStats.outputTokens * pricing.output) / 1_000_000;

    // Cache write tokens cost 1.25x base input price
    const cacheWriteCost = (tokenStats.cacheWriteTokens * pricing.input * CACHE_WRITE_MULTIPLIER) / 1_000_000;

    // Cache read tokens cost 0.1x base input price
    const cacheReadCost = (tokenStats.cacheReadTokens * pricing.input * CACHE_READ_MULTIPLIER) / 1_000_000;

    return inputCost + outputCost + cacheWriteCost + cacheReadCost;
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

          // Check if recently modified
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

    // Log activity for session detection
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
          const messages = await this.parseSessionFile(filePath);

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
    // First try database
    const dbMessages = getSessionMessages(sessionId);
    if (dbMessages.length > 0) {
      return dbMessages;
    }

    // If no messages in database, try to read from file directly
    const session = getSession(sessionId);
    if (session?.filePath && existsSync(session.filePath)) {
      try {
        const parsedMessages = await this.parseSessionFile(session.filePath);
        // Store for future queries
        if (parsedMessages.length > 0) {
          storeMessages(sessionId, parsedMessages);
        }
        // Return as SessionMessage with required fields
        return parsedMessages.map((msg, index) => ({
          id: index,
          sessionId,
          messageIndex: index,
          role: msg.role as any ?? 'unknown',
          content: msg.content ?? '',
          timestamp: msg.timestamp ?? null,
          tokenCount: msg.tokenCount ?? 0,
          toolName: msg.toolName ?? null,
          toolInput: msg.toolInput ?? null,
          toolResult: msg.toolResult ?? null,
          createdAt: new Date().toISOString(),
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
    // Return sessions modified within the threshold
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
          // Skip malformed JSON lines - this is expected for partially written files
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
      // Force reparse to ensure token data is recalculated
      await this.processSessionFile(session.filePath, stats.mtimeMs, true);
      return getSession(sessionId);
    } catch (error) {
      logger.error(`Failed to refresh session tokens for ${sessionId}`, error);
      return session;
    }
  }

  /**
   * Recalculates costs for all sessions using updated pricing.
   * Forces reparse of all sessions with valid file paths.
   */
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

    // Check if file was modified in the last 30 seconds using the cached mtime from session
    // This avoids synchronous file operations
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

// ============================================================================
// EXPORTS
// ============================================================================

export function initSessionManager(statusCallback: StatusCallback): void {
  sessionManager = new SessionManagerInstance(statusCallback);
}

export function getSessionManager(): SessionManagerInstance | null {
  return sessionManager;
}
