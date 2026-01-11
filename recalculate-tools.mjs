// Script to recalculate tool usage for all sessions
// Run with: node recalculate-tools.mjs

import Database from 'better-sqlite3';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const appDataPath = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const dbPath = path.join(appDataPath, 'clausitron', 'clausitron.db');

console.log(`Database path: ${dbPath}`);

// Tool parsing functions (copied from sessionManager.ts)
function parseMcpCliTool(toolRef) {
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

function parseBashCommand(command) {
  if (!command || typeof command !== 'string') {
    return ['Bash'];
  }
  const tools = [];

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

  const commandPatterns = [
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
    { pattern: /^(python|python3|node|deno|ruby|go|cargo|rustc)/i, name: (m) => (m[1] ?? 'unknown').toLowerCase() },
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

function resolveToolNames(toolName, toolInput) {
  if (toolName === 'Bash' && toolInput && typeof toolInput.command === 'string') {
    return parseBashCommand(toolInput.command);
  }
  return [toolName];
}

function extractToolUsage(entry, toolUsage) {
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

async function processSessionFile(filePath) {
  const toolUsage = new Map();

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.trim());

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        extractToolUsage(entry, toolUsage);
      } catch (e) {
        // Skip malformed JSON lines
      }
    }
  } catch (error) {
    console.error(`Failed to process ${filePath}:`, error.message);
  }

  return toolUsage;
}

async function main() {
  const db = new Database(dbPath);

  // Get all sessions with file paths
  const sessions = db.prepare(`
    SELECT id, file_path
    FROM sessions
    WHERE file_path IS NOT NULL
  `).all();

  console.log(`Found ${sessions.length} sessions to process`);

  // Prepare statements
  const clearStmt = db.prepare('DELETE FROM tool_usage WHERE session_id = ?');
  const insertStmt = db.prepare('INSERT INTO tool_usage (session_id, tool_name, count) VALUES (?, ?, ?)');

  let processed = 0;
  let skipped = 0;

  for (const session of sessions) {
    try {
      // Check if file exists
      await fs.access(session.file_path);

      // Process session file
      const toolUsage = await processSessionFile(session.file_path);

      if (toolUsage.size > 0) {
        // Clear existing tool usage
        clearStmt.run(session.id);

        // Insert new tool usage
        for (const [toolName, count] of toolUsage) {
          insertStmt.run(session.id, toolName, count);
        }

        processed++;
        if (processed % 50 === 0) {
          console.log(`Processed ${processed}/${sessions.length} sessions...`);
        }
      }
    } catch (error) {
      skipped++;
    }
  }

  console.log(`\nComplete! Processed ${processed} sessions, skipped ${skipped} (file not found)`);

  // Show results
  const results = db.prepare(`
    SELECT tool_name, SUM(count) as total
    FROM tool_usage
    GROUP BY tool_name
    ORDER BY total DESC
    LIMIT 30
  `).all();

  console.log('\nTop 30 tools by usage:');
  console.log('='.repeat(50));
  for (const row of results) {
    console.log(`${row.tool_name.padEnd(30)} ${row.total}`);
  }

  // Check if Bash is still high
  const bashCount = db.prepare(`
    SELECT SUM(count) as total FROM tool_usage WHERE tool_name = 'Bash'
  `).get();

  console.log(`\nRemaining unresolved 'Bash' entries: ${bashCount?.total || 0}`);

  db.close();
}

main().catch(console.error);
