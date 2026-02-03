// ============================================================================
// HOOKS SERVICE - Built-in Hook Scripts
// ============================================================================

import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { Logger } from '../logger.js';
import type { HookConfig, HookEventType } from './types.js';

const logger = new Logger('BuiltinHooks');

/**
 * Hook creation input type for built-in hooks
 */
export type BuiltinHookConfig = Omit<
  HookConfig,
  'id' | 'executionCount' | 'lastExecuted' | 'lastResult' | 'createdAt' | 'updatedAt'
>;

/**
 * Get the GoodVibes hooks directory path
 */
export function getGoodvibesHooksDir(): string {
  return path.join(os.homedir(), '.goodvibes', 'hooks');
}

/**
 * Get built-in GoodVibes hook configurations
 */
export function getBuiltInHooks(): BuiltinHookConfig[] {
  const goodvibesHooksDir = getGoodvibesHooksDir();

  return [
    {
      name: 'GoodVibes Tool Tracker',
      eventType: 'PostToolUse' as HookEventType,
      matcher: '*',
      command: `node "${path.join(goodvibesHooksDir, 'track-tool.js')}"`,
      timeout: 5000,
      enabled: false,
      scope: 'user' as const,
      projectPath: null,
      hookType: 'command' as const,
      prompt: null,
    },
    {
      name: 'GoodVibes Session Start',
      eventType: 'SessionStart' as HookEventType,
      matcher: '*',
      command: `node "${path.join(goodvibesHooksDir, 'session-start.js')}"`,
      timeout: 5000,
      enabled: false,
      scope: 'user' as const,
      projectPath: null,
      hookType: 'command' as const,
      prompt: null,
    },
    {
      name: 'GoodVibes Session End',
      eventType: 'SessionEnd' as HookEventType,
      matcher: '*',
      command: `node "${path.join(goodvibesHooksDir, 'session-end.js')}"`,
      timeout: 5000,
      enabled: false,
      scope: 'user' as const,
      projectPath: null,
      hookType: 'command' as const,
      prompt: null,
    },
  ];
}

/**
 * Install built-in hook scripts to the GoodVibes hooks directory
 */
export async function installBuiltInHookScripts(): Promise<void> {
  const hooksDir = getGoodvibesHooksDir();

  if (!existsSync(hooksDir)) {
    await fs.mkdir(hooksDir, { recursive: true });
  }

  // Track tool usage script
  const trackToolScript = `#!/usr/bin/env node
// GoodVibes Tool Tracker Hook
// Records tool usage to GoodVibes for analytics

const http = require('http');

const data = {
  event: process.env.GOODVIBES_HOOK_EVENT,
  tool: process.env.GOODVIBES_HOOK_TOOL,
  input: process.env.GOODVIBES_HOOK_INPUT,
  result: process.env.GOODVIBES_HOOK_RESULT,
  sessionId: process.env.GOODVIBES_SESSION_ID,
  projectPath: process.env.GOODVIBES_PROJECT_PATH,
  timestamp: process.env.GOODVIBES_TIMESTAMP,
};

// Log to local GoodVibes server (if running)
const req = http.request({
  hostname: 'localhost',
  port: 23847,
  path: '/api/hooks/tool-usage',
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  timeout: 2000,
}, (res) => {
  process.exit(0);
});

req.on('error', () => process.exit(0));
req.write(JSON.stringify(data));
req.end();
`;

  // Session start script
  const sessionStartScript = `#!/usr/bin/env node
// GoodVibes Session Start Hook
// Notifies GoodVibes when a new session starts

const http = require('http');

const data = {
  event: 'SessionStart',
  sessionId: process.env.GOODVIBES_SESSION_ID,
  projectPath: process.env.GOODVIBES_PROJECT_PATH,
  timestamp: process.env.GOODVIBES_TIMESTAMP,
};

const req = http.request({
  hostname: 'localhost',
  port: 23847,
  path: '/api/hooks/session-start',
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  timeout: 2000,
}, () => process.exit(0));

req.on('error', () => process.exit(0));
req.write(JSON.stringify(data));
req.end();
`;

  // Session end script
  const sessionEndScript = `#!/usr/bin/env node
// GoodVibes Session End Hook
// Notifies GoodVibes when a session ends

const http = require('http');

const data = {
  event: 'SessionEnd',
  sessionId: process.env.GOODVIBES_SESSION_ID,
  projectPath: process.env.GOODVIBES_PROJECT_PATH,
  timestamp: process.env.GOODVIBES_TIMESTAMP,
};

const req = http.request({
  hostname: 'localhost',
  port: 23847,
  path: '/api/hooks/session-end',
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  timeout: 2000,
}, () => process.exit(0));

req.on('error', () => process.exit(0));
req.write(JSON.stringify(data));
req.end();
`;

  await fs.writeFile(path.join(hooksDir, 'track-tool.js'), trackToolScript, 'utf-8');
  await fs.writeFile(path.join(hooksDir, 'session-start.js'), sessionStartScript, 'utf-8');
  await fs.writeFile(path.join(hooksDir, 'session-end.js'), sessionEndScript, 'utf-8');

  logger.info(`Installed built-in hook scripts to: ${hooksDir}`);
}
