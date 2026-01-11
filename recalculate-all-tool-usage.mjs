#!/usr/bin/env node
// Recalculate tool_usage for ALL sessions using the corrected parsing logic
import fs from 'fs/promises';
import { execSync } from 'child_process';
import path from 'path';
import { existsSync } from 'fs';

const DB_PATH = path.join(process.env.APPDATA, 'clausitron', 'clausitron.db');

function sqlite(query) {
  try {
    return execSync(`sqlite3 "${DB_PATH}" "${query.replace(/"/g, '\\"')}"`, { encoding: 'utf-8' }).trim();
  } catch (e) {
    console.error('SQLite error:', e.message);
    return '';
  }
}

function sqliteRun(query) {
  try {
    execSync(`sqlite3 "${DB_PATH}" "${query.replace(/"/g, '\\"')}"`, { encoding: 'utf-8' });
    return true;
  } catch (e) {
    console.error('SQLite error:', e.message);
    return false;
  }
}

// Parsing functions (from built output)
function parseMcpCliTool(t) {
  if (!t || typeof t != "string") return null;
  const e = t.split("/");
  if (e.length !== 2) return `mcp-cli: ${t}`;
  const s = e[0], n = e[1];
  return !s || !n ? `mcp-cli: ${t}` : s.toLowerCase().includes("goodvibes") ? `goodvibes - ${n}` : `mcp:${s} - ${n}`;
}

function parseBashCommand(t) {
  if (!t || typeof t != "string") return ["Bash"];
  const e = [];
  const s = t.match(/mcp-cli\s+(?:call|info)\s+([^\s'"]+)/);
  if (s && s[1]) {
    const a = parseMcpCliTool(s[1]);
    a && e.push(a);
  }
  if (e.length > 0) return e;

  const n = t.replace(/^cd\s+"[^"]+"\s*&&\s*/i, "").replace(/^cd\s+[^\s]+\s*&&\s*/i, "").trim();
  const r = [
    { pattern: /^git\s+(add|commit|push|pull|fetch|merge|rebase|checkout|branch|status|diff|log|stash|reset|cherry-pick|clone|init|tag|remote)/i, name: (a) => `git ${a[1] ?? ""}` },
    { pattern: /^git\s+/i, name: "git" },
    { pattern: /^npm\s+(install|run|test|build|start|publish|update|outdated|audit|ci|init|link|pack)/i, name: (a) => `npm ${a[1] ?? ""}` },
    { pattern: /^npm\s+/i, name: "npm" },
    { pattern: /^pnpm\s+(install|run|test|build|add|remove|update)/i, name: (a) => `pnpm ${a[1] ?? ""}` },
    { pattern: /^pnpm\s+/i, name: "pnpm" },
    { pattern: /^yarn\s+(add|remove|install|run|build|test|start)/i, name: (a) => `yarn ${a[1] ?? ""}` },
    { pattern: /^yarn\s+/i, name: "yarn" },
    { pattern: /^bun\s+(install|run|test|build|add|remove)/i, name: (a) => `bun ${a[1] ?? ""}` },
    { pattern: /^bun\s+/i, name: "bun" },
    { pattern: /^(vitest|jest|mocha|playwright|cypress)/i, name: (a) => (a[1] ?? "unknown").toLowerCase() },
    { pattern: /^(tsc|typescript|eslint|prettier|biome)/i, name: (a) => (a[1] ?? "unknown").toLowerCase() },
    { pattern: /^(vite|webpack|rollup|esbuild|turbo)/i, name: (a) => (a[1] ?? "unknown").toLowerCase() },
    { pattern: /^docker(-compose)?\s+(build|run|exec|ps|logs|pull|push|start|stop|up|down)/i, name: (a) => `docker ${a[2] ?? ""}` },
    { pattern: /^docker(-compose)?\s+/i, name: "docker" },
    { pattern: /^kubectl\s+(get|apply|delete|describe|logs|exec|port-forward)/i, name: (a) => `kubectl ${a[1] ?? ""}` },
    { pattern: /^kubectl\s+/i, name: "kubectl" },
    { pattern: /^(curl|wget|gh|az|aws|gcloud|terraform|pulumi)/i, name: (a) => (a[1] ?? "unknown").toLowerCase() },
    { pattern: /^(python|python3|node|deno|ruby|go|cargo|rustc)/i, name: (a) => (a[1] ?? "unknown").toLowerCase() },
    { pattern: /^(powershell|pwsh|cmd)/i, name: (a) => (a[1] ?? "unknown").toLowerCase() },
    { pattern: /^(mkdir|rm|rmdir|mv|cp|touch|chmod|chown)/i, name: (a) => (a[1] ?? "unknown").toLowerCase() },
    { pattern: /^(cat|head|tail|less|more|grep|find|ls|dir)/i, name: (a) => (a[1] ?? "unknown").toLowerCase() },
    { pattern: /^(taskkill|tasklist|netstat|ipconfig|ping)/i, name: (a) => (a[1] ?? "unknown").toLowerCase() },
  ];

  for (const { pattern: a, name: i } of r) {
    const c = n.match(a);
    if (c) {
      const l = typeof i == "function" ? i(c) : i;
      e.push(l);
      break;
    }
  }
  return e.length > 0 ? e : ["Bash"];
}

function resolveToolNames(t, e) {
  return t === "Bash" && e && typeof e.command == "string" ? parseBashCommand(e.command) : [t];
}

function extractToolUsage(entry, toolUsage) {
  if (entry.type === "tool_use" || entry.tool_use) {
    const tool = entry.tool_use || entry;
    const toolName = tool.name;
    const toolInput = tool.input;
    if (toolName) {
      const resolvedNames = resolveToolNames(toolName, toolInput);
      for (const name of resolvedNames)
        toolUsage.set(name, (toolUsage.get(name) || 0) + 1);
    }
  }
  if (entry.message?.content && Array.isArray(entry.message.content)) {
    for (const block of entry.message.content) {
      if (block.type === "tool_use" && block.name) {
        const resolvedNames = resolveToolNames(block.name, block.input);
        for (const name of resolvedNames)
          toolUsage.set(name, (toolUsage.get(name) || 0) + 1);
      }
    }
  }
}

async function parseSessionFile(filePath) {
  const toolUsage = new Map();
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        extractToolUsage(entry, toolUsage);
      } catch (e) { /* skip malformed */ }
    }
  } catch (e) {
    // File read error
  }
  return toolUsage;
}

async function main() {
  console.log('='.repeat(60));
  console.log('RECALCULATING TOOL USAGE FOR ALL SESSIONS');
  console.log('='.repeat(60));

  // Get all sessions with file paths
  const sessionsResult = sqlite("SELECT id, file_path FROM sessions WHERE file_path IS NOT NULL;");
  if (!sessionsResult) {
    console.log('No sessions found');
    return;
  }

  // Handle Windows \r\n line endings
  const sessions = sessionsResult.split(/\r?\n/).filter(l => l.trim()).map(line => {
    const cleanLine = line.replace(/\r$/, '').trim();
    const pipeIdx = cleanLine.indexOf('|');
    if (pipeIdx < 0) return null;
    const id = cleanLine.substring(0, pipeIdx);
    const filePath = cleanLine.substring(pipeIdx + 1);
    return { id, filePath };
  }).filter(s => s !== null);

  console.log(`Found ${sessions.length} sessions with file paths`);

  // Clear ALL existing tool_usage data
  console.log('\nClearing existing tool_usage data...');
  sqliteRun("DELETE FROM tool_usage;");
  console.log('Cleared');

  // Process each session
  let processed = 0;
  let skipped = 0;
  let errors = 0;
  const startTime = Date.now();

  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];

    if (i % 100 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`Progress: ${i}/${sessions.length} (${elapsed}s elapsed)`);
    }

    // Normalize path separators for cross-platform compatibility
    const normalizedPath = session.filePath.replace(/\\/g, '/');
    if (!normalizedPath || !existsSync(normalizedPath)) {
      skipped++;
      continue;
    }

    try {
      const toolUsage = await parseSessionFile(normalizedPath);

      if (toolUsage.size > 0) {
        // Build a single INSERT statement with multiple VALUES for efficiency
        for (const [toolName, count] of toolUsage) {
          const escapedName = toolName.replace(/'/g, "''");
          const escapedId = session.id.replace(/'/g, "''");
          sqliteRun(`INSERT INTO tool_usage (session_id, tool_name, count) VALUES ('${escapedId}', '${escapedName}', ${count});`);
        }
        processed++;
      } else {
        skipped++;
      }
    } catch (e) {
      errors++;
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n' + '='.repeat(60));
  console.log('RECALCULATION COMPLETE');
  console.log('='.repeat(60));
  console.log(`Total sessions: ${sessions.length}`);
  console.log(`Processed: ${processed}`);
  console.log(`Skipped (no file/no tools): ${skipped}`);
  console.log(`Errors: ${errors}`);
  console.log(`Time: ${totalTime}s`);

  // Show sample of new tool usage
  console.log('\n' + '='.repeat(60));
  console.log('TOP 20 TOOLS AFTER RECALCULATION');
  console.log('='.repeat(60));
  const topTools = sqlite("SELECT tool_name, SUM(count) as total FROM tool_usage GROUP BY tool_name ORDER BY total DESC LIMIT 20;");
  console.log(topTools);
}

main().catch(console.error);
