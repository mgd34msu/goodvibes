// ============================================================================
// CLAUDE CLI CLIENT - Claude CLI headless mode integration for tag suggestions
// ============================================================================

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Logger } from './logger.js';
import { toggleArchive } from '../database/sessions.js';

const logger = new Logger('ClaudeCliClient');

// ============================================================================
// Types and Constants
// ============================================================================

/**
 * Single tag suggestion from Claude CLI
 */
export interface TagSuggestion {
  name: string;
  confidence: number; // 0-1
  reasoning: string;
  category?: string;
}

/**
 * Context for a single session in batch processing
 */
export interface TagSuggestionContext {
  projectPath?: string;
  recentMessages: Array<{ role: string; content: string }>;
  toolsUsed: string[];
  existingTags: string[];
}

/**
 * Result for a single session with its suggestions
 */
export interface TagSuggestionResult extends TagSuggestion {
  sessionId: string;
}

/**
 * Response structure from Claude CLI with JSON schema
 */
interface ClaudeCliResponse {
  structured_output?: {
    tags: TagSuggestion[];
  };
}

/**
 * Batch response structure from Claude CLI
 */
interface ClaudeCliBatchResponse {
  structured_output?: {
    sessions: Array<{
      sessionId: string;
      tags: TagSuggestion[];
    }>;
  };
}

/**
 * JSON schema for tag suggestions
 * Enforces response structure when using --json-schema
 */
const TAG_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    tags: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          confidence: { type: "number" },
          reasoning: { type: "string" },
          category: { type: "string" }
        },
        required: ["name", "confidence", "reasoning"]
      }
    }
  },
  required: ["tags"]
});

/**
 * JSON schema for batch tag suggestions
 * Used when processing multiple sessions in a single Claude CLI call
 */
const BATCH_TAG_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    sessions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          tags: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                confidence: { type: "number" },
                reasoning: { type: "string" },
                category: { type: "string" }
              },
              required: ["name", "confidence", "reasoning"]
            }
          }
        },
        required: ["sessionId", "tags"]
      }
    }
  },
  required: ["sessions"]
});

/**
 * Timeout for CLI execution (30 seconds)
 */
const CLI_TIMEOUT_MS = 30000;

/**
 * Prefix used to identify tag suggestion sessions
 */
const SESSION_TAGGING_PREFIX = '[session tagging]';

// ============================================================================
// Main API Function
// ============================================================================

/**
 * Generate tag suggestions using Claude CLI in headless mode
 * 
 * This uses the user's existing Claude authentication (Pro/Max subscription)
 * instead of requiring an API key.
 * 
 * @param sessionContext - Formatted session context string
 * @param existingTags - Array of existing tag names in the system
 * @returns Array of tag suggestions with confidence scores
 * @throws Error if Claude CLI is not available or execution fails
 */
export async function generateTagSuggestionsViaCli(
  sessionContext: string,
  existingTags: string[]
): Promise<TagSuggestion[]> {
  const startTime = Date.now();

  // Validate inputs
  if (!sessionContext || !sessionContext.trim()) {
    logger.warn('Empty context provided to generateTagSuggestionsViaCli');
    return [];
  }

  logger.info('Generating tag suggestions via Claude CLI', {
    contextLength: sessionContext.length,
    existingTagCount: existingTags.length,
  });

  // Build the prompt
  const prompt = buildPrompt(sessionContext, existingTags);

  try {
    // Call Claude CLI with structured output
    const response = await callClaudeCli(prompt);
    
    // Parse and validate response
    const suggestions = parseCliResponse(response);

    const duration = Date.now() - startTime;
    logger.info('Tag suggestions generated successfully via CLI', {
      suggestionCount: suggestions.length,
      durationMs: duration,
    });

    return suggestions;
  } catch (err) {
    const duration = Date.now() - startTime;
    logger.error('Failed to generate tag suggestions via CLI', {
      error: err instanceof Error ? err.message : String(err),
      durationMs: duration,
    });
    throw err;
  }
}

/**
 * Generate tag suggestions for multiple sessions in a single Claude CLI call
 * 
 * This batches multiple sessions together to reduce API calls and improve efficiency.
 * Uses the user's existing Claude authentication (Pro/Max subscription).
 * 
 * @param sessions - Array of session contexts with their IDs
 * @returns Map of session IDs to their tag suggestions
 * @throws Error if Claude CLI is not available or execution fails
 */
export async function generateBatchTagSuggestions(
  sessions: Array<{ sessionId: string; context: TagSuggestionContext }>
): Promise<Map<string, TagSuggestion[]>> {
  const startTime = Date.now();

  // Validate inputs
  if (!sessions || sessions.length === 0) {
    logger.warn('Empty sessions array provided to generateBatchTagSuggestions');
    return new Map();
  }

  logger.info('Generating batch tag suggestions via Claude CLI', {
    sessionCount: sessions.length,
  });

  // Build the batch prompt
  const prompt = buildBatchPrompt(sessions);

  try {
    // Call Claude CLI with structured output
    const response = await callClaudeCliBatch(prompt);
    
    // Parse and validate response
    const results = parseBatchCliResponse(response, sessions);

    const duration = Date.now() - startTime;
    logger.info('Batch tag suggestions generated successfully via CLI', {
      sessionCount: results.size,
      durationMs: duration,
    });

    return results;
  } catch (err) {
    const duration = Date.now() - startTime;
    logger.error('Failed to generate batch tag suggestions via CLI', {
      error: err instanceof Error ? err.message : String(err),
      sessionCount: sessions.length,
      durationMs: duration,
    });
    throw err;
  }
}

// ============================================================================
// Prompt Generation
// ============================================================================

/**
 * Build the prompt for Claude CLI
 */
function buildPrompt(sessionContext: string, existingTags: string[]): string {
  return `[session tagging]

Analyze this Claude Code session and suggest relevant tags for categorization.

Existing tags in the system: ${existingTags.length > 0 ? existingTags.join(', ') : 'none'}

Session context:
${sessionContext}

Suggest 3-5 relevant tags. For each tag:
- Use lowercase with hyphens (e.g., "bug-fix", "feature", "refactor")
- Provide confidence 0-1 (higher for existing tags, moderate for new tags)
- Explain your reasoning briefly
- Categorize as: feature, bug, refactor, docs, test, config, or other

Prefer existing tags when appropriate. Only suggest new tags if truly needed.`;
}

/**
 * Build the batch prompt for multiple sessions
 */
function buildBatchPrompt(
  sessions: Array<{ sessionId: string; context: TagSuggestionContext }>
): string {
  const allExistingTags = new Set<string>();
  sessions.forEach(s => s.context.existingTags.forEach(tag => allExistingTags.add(tag)));
  const existingTagsList = Array.from(allExistingTags).join(', ');

  let prompt = `[session tagging]

Analyze these Claude Code sessions and suggest relevant tags for EACH session.

Existing tags in the system: ${existingTagsList || 'none'}

`;

  // Add each session
  sessions.forEach((session, index) => {
    const ctx = session.context;
    prompt += `=== SESSION ${index + 1} (ID: ${session.sessionId}) ===\n`;
    
    if (ctx.projectPath) {
      prompt += `Project: ${ctx.projectPath}\n`;
    }
    
    if (ctx.recentMessages.length > 0) {
      prompt += `Recent messages:\n`;
      ctx.recentMessages.slice(0, 3).forEach(msg => {
        prompt += `  [${msg.role}]: ${msg.content.substring(0, 100)}...\n`;
      });
    }
    
    if (ctx.toolsUsed.length > 0) {
      prompt += `Tools used: ${ctx.toolsUsed.join(', ')}\n`;
    }
    
    prompt += `\n`;
  });

  prompt += `For EACH session, suggest 3-5 relevant tags. For each tag:
- Use lowercase with hyphens (e.g., "bug-fix", "feature", "refactor")
- Provide confidence 0-1 (higher for existing tags, moderate for new tags)
- Explain your reasoning briefly
- Categorize as: feature, bug, refactor, docs, test, config, or other

Prefer existing tags when appropriate. Only suggest new tags if truly needed.

IMPORTANT: Return tags for ALL sessions. Use the EXACT session ID provided.

Example output format:
{
  "sessions": [
    {
      "sessionId": "abc-123-def",
      "tags": [
        { "name": "bug-fix", "confidence": 0.9, "reasoning": "Session focused on fixing a bug", "category": "bug" },
        { "name": "react", "confidence": 0.8, "reasoning": "React components were modified", "category": "feature" }
      ]
    },
    {
      "sessionId": "xyz-456-ghi",
      "tags": [
        { "name": "refactor", "confidence": 0.85, "reasoning": "Code was restructured", "category": "refactor" }
      ]
    }
  ]
}`;

  return prompt;
}

// ============================================================================
// CLI Execution
// ============================================================================

/**
 * Execute Claude CLI for batch processing
 * Returns the raw stdout as string
 */
function callClaudeCliBatch(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Build CLI arguments with batch schema
    const args = [
      '-p', prompt,
      '--model', 'haiku',
      '--output-format', 'json',
      '--json-schema', BATCH_TAG_SCHEMA,
      '--allowedTools', 'Read'
    ];

    logger.debug('Spawning Claude CLI for batch processing', { argsCount: args.length });

    // Spawn the CLI process
    const child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timeoutId: NodeJS.Timeout | null = null;

    // Set up timeout (longer for batch processing)
    const batchTimeout = CLI_TIMEOUT_MS * 2; // 60 seconds for batch
    timeoutId = setTimeout(() => {
      logger.warn('Claude CLI batch timeout, killing process');
      child.kill('SIGTERM');
      reject(new Error(`Claude CLI batch timed out after ${batchTimeout}ms`));
    }, batchTimeout);

    // Collect stdout
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    // Collect stderr
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    // Handle process exit
    child.on('close', (code: number | null) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      if (code !== 0) {
        logger.error('Claude CLI batch failed', { code, stderr: stderr.substring(0, 500) });
        reject(new Error(`Claude CLI batch exited with code ${code}: ${stderr}`));
        return;
      }

      logger.debug('Claude CLI batch completed successfully', { 
        stdoutLength: stdout.length,
        stderrLength: stderr.length 
      });
      resolve(stdout);
    });

    // Handle spawn errors
    child.on('error', (error: Error) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      
      logger.error('Failed to spawn Claude CLI for batch', { error });
      
      if ('code' in error && error.code === 'ENOENT') {
        reject(new Error('Claude CLI not found in PATH. Please ensure Claude Code CLI is installed.'));
      } else {
        reject(error);
      }
    });
  });
}

/**
 * Execute Claude CLI with the given prompt
 * Returns the raw stdout as string
 */
function callClaudeCli(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Build CLI arguments
    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--json-schema', TAG_SCHEMA,
      '--allowedTools', 'Read'
    ];

    logger.debug('Spawning Claude CLI', { argsCount: args.length });

    // Spawn the CLI process
    const child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timeoutId: NodeJS.Timeout | null = null;

    // Set up timeout
    timeoutId = setTimeout(() => {
      logger.warn('Claude CLI timeout, killing process');
      child.kill('SIGTERM');
      reject(new Error(`Claude CLI timed out after ${CLI_TIMEOUT_MS}ms`));
    }, CLI_TIMEOUT_MS);

    // Collect stdout
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    // Collect stderr
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    // Handle process exit
    child.on('close', (code: number | null) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      if (code !== 0) {
        logger.error('Claude CLI failed', { code, stderr: stderr.substring(0, 500) });
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
        return;
      }

      logger.debug('Claude CLI completed successfully', { 
        stdoutLength: stdout.length,
        stderrLength: stderr.length 
      });
      resolve(stdout);
    });

    // Handle spawn errors
    child.on('error', (error: Error) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      
      logger.error('Failed to spawn Claude CLI', { error });
      
      // Provide helpful error message if CLI not found
      if ('code' in error && error.code === 'ENOENT') {
        reject(new Error('Claude CLI not found in PATH. Please ensure Claude Code CLI is installed.'));
      } else {
        reject(error);
      }
    });
  });
}

// ============================================================================
// Response Parsing
// ============================================================================

/**
 * Parse and validate Claude CLI JSON response
 */
function parseCliResponse(responseText: string): TagSuggestion[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(responseText);
  } catch (err) {
    logger.error('Failed to parse Claude CLI response as JSON', { 
      error: err,
      responsePreview: responseText.substring(0, 200) 
    });
    throw new Error('Claude CLI response is not valid JSON');
  }

  // The --json-schema flag puts output in structured_output field
  const response = parsed as ClaudeCliResponse;
  
  if (!response.structured_output?.tags) {
    logger.error('Claude CLI response missing structured_output.tags', { response });
    throw new Error('Claude CLI response missing expected structured_output.tags field');
  }

  const tags = response.structured_output.tags;

  if (!Array.isArray(tags)) {
    logger.error('structured_output.tags is not an array', { tags });
    throw new Error('Claude CLI structured_output.tags must be an array');
  }

  if (tags.length === 0) {
    logger.warn('Claude CLI returned zero suggestions');
    return [];
  }

  if (tags.length > 10) {
    logger.warn(`Claude CLI returned ${tags.length} suggestions, truncating to 10`);
    return tags.slice(0, 10).map(validateSuggestion);
  }

  return tags.map(validateSuggestion);
}

/**
 * Parse and validate batch Claude CLI JSON response
 */
function parseBatchCliResponse(
  responseText: string,
  sessions: Array<{ sessionId: string; context: TagSuggestionContext }>
): Map<string, TagSuggestion[]> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(responseText);
  } catch (err) {
    logger.error('Failed to parse Claude CLI batch response as JSON', { 
      error: err,
      responsePreview: responseText.substring(0, 200) 
    });
    throw new Error('Claude CLI batch response is not valid JSON');
  }

  // The --json-schema flag puts output in structured_output field
  const response = parsed as ClaudeCliBatchResponse;
  
  if (!response.structured_output?.sessions) {
    logger.error('Claude CLI batch response missing structured_output.sessions', { response });
    throw new Error('Claude CLI batch response missing expected structured_output.sessions field');
  }

  const sessionsData = response.structured_output.sessions;

  if (!Array.isArray(sessionsData)) {
    logger.error('structured_output.sessions is not an array', { sessionsData });
    throw new Error('Claude CLI structured_output.sessions must be an array');
  }

  // Build result map
  const results = new Map<string, TagSuggestion[]>();
  
  for (const sessionData of sessionsData) {
    if (typeof sessionData.sessionId !== 'string') {
      logger.warn('Skipping session with invalid sessionId', { sessionData });
      continue;
    }

    if (!Array.isArray(sessionData.tags)) {
      logger.warn(`Session ${sessionData.sessionId} has invalid tags array`, { sessionData });
      results.set(sessionData.sessionId, []);
      continue;
    }

    try {
      const validatedTags = sessionData.tags.map(validateSuggestion);
      results.set(sessionData.sessionId, validatedTags);
      logger.debug(`Parsed ${validatedTags.length} tags for session ${sessionData.sessionId}`);
    } catch (err) {
      logger.warn(`Failed to validate tags for session ${sessionData.sessionId}`, { error: err });
      results.set(sessionData.sessionId, []);
    }
  }

  // Ensure all requested sessions have entries (even if empty)
  for (const session of sessions) {
    if (!results.has(session.sessionId)) {
      logger.warn(`No tags returned for session ${session.sessionId}`);
      results.set(session.sessionId, []);
    }
  }

  return results;
}

/**
 * Validate a single tag suggestion
 */
function validateSuggestion(suggestion: unknown): TagSuggestion {
  if (typeof suggestion !== 'object' || suggestion === null) {
    throw new Error('Suggestion must be an object');
  }

  const s = suggestion as Record<string, unknown>;

  if (typeof s.name !== 'string' || !s.name.trim()) {
    throw new Error('Suggestion name must be a non-empty string');
  }

  if (typeof s.confidence !== 'number' || s.confidence < 0 || s.confidence > 1) {
    throw new Error('Suggestion confidence must be a number between 0 and 1');
  }

  if (typeof s.reasoning !== 'string' || !s.reasoning.trim()) {
    throw new Error('Suggestion reasoning must be a non-empty string');
  }

  return {
    name: s.name.trim(),
    confidence: s.confidence,
    reasoning: s.reasoning.trim(),
    category: typeof s.category === 'string' ? s.category.trim() : undefined,
  };
}

// ============================================================================
// Session Auto-Archiving
// ============================================================================

/**
 * Find and archive the most recent CLI session with [session tagging] prefix
 * This prevents tagging sessions from cluttering the main session list
 */
export async function archiveTaggingSession(): Promise<void> {
  try {
    const claudeDir = path.join(os.homedir(), '.claude', 'projects');
    
    if (!fs.existsSync(claudeDir)) {
      logger.debug('Claude projects directory not found, cannot archive tagging session');
      return;
    }

    let mostRecentTaggingSession: { sessionId: string; filePath: string; mtime: Date } | null = null;

    // Scan all project directories
    const projectDirs = fs.readdirSync(claudeDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => path.join(claudeDir, d.name));

    for (const projectDir of projectDirs) {
      // Get all .jsonl files (session files) in the project directory
      const sessionFiles = fs.readdirSync(projectDir, { withFileTypes: true })
        .filter(f => f.isFile() && f.name.endsWith('.jsonl') && !f.name.startsWith('agent-'))
        .map(f => {
          const filePath = path.join(projectDir, f.name);
          const stats = fs.statSync(filePath);
          return {
            sessionId: f.name.replace('.jsonl', ''),
            filePath,
            mtime: stats.mtime,
          };
        });

      // Check each session for the tagging prefix
      for (const file of sessionFiles) {
        try {
          const content = fs.readFileSync(file.filePath, 'utf-8');
          const lines = content.split('\n').filter(l => l.trim());
          
          // Check first few lines for user message with tagging prefix
          for (const line of lines.slice(0, 5)) {
            try {
              const entry = JSON.parse(line);
              if (entry.type === 'human' || entry.type === 'user') {
                let messageText = '';
                
                // Extract message text
                if (typeof entry.message === 'string') {
                  messageText = entry.message;
                } else if (entry.message?.content) {
                  if (typeof entry.message.content === 'string') {
                    messageText = entry.message.content;
                  } else if (Array.isArray(entry.message.content)) {
                    const textBlock = entry.message.content.find((b: { type: string }) => b.type === 'text');
                    if (textBlock?.text) {
                      messageText = textBlock.text;
                    }
                  }
                }

                // Check if this is a tagging session
                if (messageText.includes(SESSION_TAGGING_PREFIX)) {
                  if (!mostRecentTaggingSession || file.mtime > mostRecentTaggingSession.mtime) {
                    mostRecentTaggingSession = file;
                  }
                  break;
                }
              }
            } catch (err) {
              // Skip invalid JSON lines
              continue;
            }
          }
        } catch (err) {
          // Skip files we can't read
          logger.debug('Could not read session file for archiving', {
            file: file.filePath,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
    }

    // Archive the most recent tagging session if found
    if (mostRecentTaggingSession) {
      logger.info('Archiving tag suggestion session', {
        sessionId: mostRecentTaggingSession.sessionId,
        mtime: mostRecentTaggingSession.mtime
      });
      
      toggleArchive(mostRecentTaggingSession.sessionId);
      
      logger.info('Successfully archived tag suggestion session', {
        sessionId: mostRecentTaggingSession.sessionId
      });
    } else {
      logger.debug('No recent tagging session found to archive');
    }
  } catch (err) {
    logger.error('Failed to archive tagging session', {
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
