// ============================================================================
// HOOK SCRIPTS - Script Generation
// ============================================================================
//
// This module generates the Node.js hook scripts that Claude executes.
// Each hook script reads JSON from stdin, forwards to GoodVibes's HTTP server,
// and returns the decision to Claude in the correct format.
//
// ============================================================================

import { HOOK_SERVER_PORT } from '../hookServer.js';
import type { ExtendedHookEventType, HookCategory } from './types.js';

// ============================================================================
// HOOK CATEGORY DETECTION
// ============================================================================

/**
 * Determine the hook category for a given event type.
 * The category determines the response format expected by Claude.
 */
export function getHookCategory(eventType: ExtendedHookEventType): HookCategory {
  switch (eventType) {
    case 'PreToolUse':
      return 'PreToolUse';
    case 'UserPromptSubmit':
      return 'UserPromptSubmit';
    case 'PostToolUse':
      return 'PostToolUse';
    // All other hooks are "stop" hooks that can prevent continuation
    case 'SessionStart':
    case 'SessionEnd':
    case 'SubagentStart':
    case 'SubagentStop':
    case 'Stop':
    case 'Notification':
    case 'PreCompact':
    case 'PermissionRequest':
    case 'PostToolUseFailure':
    default:
      return 'Stop';
  }
}

/**
 * Convert event type to kebab-case file name (without extension)
 */
export function eventTypeToFileName(eventType: ExtendedHookEventType): string {
  return eventType.replace(/([A-Z])/g, '-$1').toLowerCase().slice(1);
}

// ============================================================================
// SCRIPT GENERATION
// ============================================================================

/**
 * Generate the hook script content for a given event type
 */
export function generateHookScript(eventType: ExtendedHookEventType): string {
  const fileName = eventTypeToFileName(eventType);
  const hookCategory = getHookCategory(eventType);

  return `#!/usr/bin/env node
// ============================================================================
// GoodVibes Hook Script: ${eventType}
// Generated automatically - do not edit manually
// ============================================================================
//
// This script is executed by Claude Code for the ${eventType} hook event.
// It reads JSON from stdin, forwards to GoodVibes's HTTP server,
// and returns the decision to Claude in the CORRECT format.
//
// Hook Category: ${hookCategory}
//
// ============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Configuration
const GOODVIBES_PORT = ${HOOK_SERVER_PORT};
const GOODVIBES_HOST = '127.0.0.1';
const TIMEOUT_MS = 5000;
const HOOK_EVENT_NAME = '${eventType}';
const HOOK_CATEGORY = '${hookCategory}';
const LOG_FILE = path.join(os.homedir(), '.goodvibes', 'hooks.log');

// Log function - writes to file for debugging
function logToFile(message) {
  try {
    const timestamp = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, \`[\${timestamp}] [\${HOOK_EVENT_NAME}] \${message}\\n\`);
  } catch (e) {
    // Log file write errors are intentionally suppressed to prevent infinite recursion
    // and to ensure hook execution continues even if logging fails (e.g., disk full, permissions)
    // The error is written to stderr as a last resort for debugging
    console.error('[GoodVibes] Log write failed:', e.message);
  }
}

logToFile('Hook script started');

/**
 * Format response for Claude based on hook category.
 * Claude expects different JSON schemas for different hook types.
 */
function formatResponseForClaude(serverResponse) {
  const decision = serverResponse.decision || 'allow';
  const blocked = decision === 'block' || decision === 'deny';

  switch (HOOK_CATEGORY) {
    case 'PreToolUse':
      // Schema: { hookEventName, permissionDecision, permissionDecisionReason?, updatedInput? }
      const preToolResponse = {
        hookEventName: HOOK_EVENT_NAME,
        permissionDecision: blocked ? 'deny' : 'allow',
      };
      if (serverResponse.message) {
        preToolResponse.permissionDecisionReason = serverResponse.message;
      }
      if (serverResponse.modified_input) {
        preToolResponse.updatedInput = serverResponse.modified_input;
      }
      return preToolResponse;

    case 'UserPromptSubmit':
      // Schema: { hookEventName, additionalContext (required) }
      return {
        hookEventName: HOOK_EVENT_NAME,
        additionalContext: serverResponse.inject_context || '',
      };

    case 'PostToolUse':
      // Schema: { hookEventName, additionalContext? }
      const postToolResponse = {
        hookEventName: HOOK_EVENT_NAME,
      };
      if (serverResponse.inject_context) {
        postToolResponse.additionalContext = serverResponse.inject_context;
      }
      return postToolResponse;

    case 'Stop':
    default:
      // Schema: { continue: boolean, stopReason? }
      // Stop hooks use "continue" to indicate whether to proceed
      const stopResponse = {
        continue: !blocked,
      };
      if (blocked && serverResponse.message) {
        stopResponse.stopReason = serverResponse.message;
      }
      // For session/agent start hooks, we can inject context via additionalContext
      if (serverResponse.inject_context) {
        stopResponse.additionalContext = serverResponse.inject_context;
      }
      return stopResponse;
  }
}

/**
 * Get the default allow response for this hook category
 */
function getDefaultAllowResponse() {
  switch (HOOK_CATEGORY) {
    case 'PreToolUse':
      return { hookEventName: HOOK_EVENT_NAME, permissionDecision: 'allow' };
    case 'UserPromptSubmit':
      return { hookEventName: HOOK_EVENT_NAME, additionalContext: '' };
    case 'PostToolUse':
      return { hookEventName: HOOK_EVENT_NAME };
    case 'Stop':
    default:
      return { continue: true };
  }
}

// Read JSON from stdin (how Claude passes hook data)
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});

process.stdin.on('end', async () => {
  try {
    logToFile('Received input: ' + input.substring(0, 500));

    // Parse the input from Claude
    const hookData = input.trim() ? JSON.parse(input) : {};
    logToFile('Parsed hook data, keys: ' + Object.keys(hookData).join(', '));

    // Forward to GoodVibes's HTTP server
    logToFile('Posting to GoodVibes...');
    const response = await postToGoodVibes('/api/hooks/${fileName}', {
      hook_event_name: '${eventType}',
      ...hookData,
      timestamp: Date.now(),
    });
    logToFile('GoodVibes response: ' + JSON.stringify(response));

    // Format and output the response in Claude's expected format
    const claudeResponse = formatResponseForClaude(response);
    logToFile('Sending to Claude: ' + JSON.stringify(claudeResponse));
    console.log(JSON.stringify(claudeResponse));

    // Exit with code 2 if blocked/denied, 0 otherwise
    const blocked = response.decision === 'block' || response.decision === 'deny';
    logToFile('Exiting with code: ' + (blocked ? 2 : 0));
    process.exit(blocked ? 2 : 0);

  } catch (err) {
    // On error, fail open (allow the action) to ensure GoodVibes issues don't block Claude
    // This is intentional: we prioritize Claude's functionality over hook enforcement
    // The error is logged both to file and stderr for debugging
    logToFile('ERROR (failing open to allow action): ' + err.message);
    console.error('[GoodVibes] Hook error (failing open):', err.message);
    console.log(JSON.stringify(getDefaultAllowResponse()));
    process.exit(0);
  }
});

// Handle stdin errors
process.stdin.on('error', (err) => {
  console.error('[GoodVibes] stdin error:', err.message);
  console.log(JSON.stringify(getDefaultAllowResponse()));
  process.exit(0);
});

/**
 * POST data to GoodVibes's HTTP server
 */
function postToGoodVibes(path, data) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data);

    const req = http.request({
      hostname: GOODVIBES_HOST,
      port: GOODVIBES_PORT,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          // JSON parse failure: server returned invalid response, fail open to allow the action
          // This could happen if server returns HTML error page, empty response, etc.
          logToFile('WARNING: Failed to parse server response as JSON (failing open): ' + e.message);
          resolve({ decision: 'allow' });
        }
      });
    });

    req.on('error', (err) => {
      // Connection error: GoodVibes server may not be running or is unreachable
      // Fail open to allow the action so Claude continues to work
      logToFile('WARNING: HTTP request error (failing open): ' + err.message);
      resolve({ decision: 'allow' });
    });

    req.on('timeout', () => {
      req.destroy();
      // Request timed out: GoodVibes server may be slow or unresponsive
      // Fail open to prevent blocking Claude indefinitely
      logToFile('WARNING: HTTP request timed out after ' + TIMEOUT_MS + 'ms (failing open)');
      resolve({ decision: 'allow' });
    });

    req.write(postData);
    req.end();
  });
}
`;
}
