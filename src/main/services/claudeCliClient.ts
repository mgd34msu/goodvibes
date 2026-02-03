// ============================================================================
// CLAUDE CLI CLIENT - Claude CLI headless mode integration for tag suggestions
// ============================================================================

import { spawn } from 'child_process';
import { Logger } from './logger.js';

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
 * Response structure from Claude CLI with JSON schema
 */
interface ClaudeCliResponse {
  structured_output?: {
    tags: TagSuggestion[];
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
 * Timeout for CLI execution (30 seconds)
 */
const CLI_TIMEOUT_MS = 30000;

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

// ============================================================================
// Prompt Generation
// ============================================================================

/**
 * Build the prompt for Claude CLI
 */
function buildPrompt(sessionContext: string, existingTags: string[]): string {
  return `Analyze this Claude Code session and suggest relevant tags for categorization.

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

// ============================================================================
// CLI Execution
// ============================================================================

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
