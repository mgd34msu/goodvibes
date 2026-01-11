# PowerShell script to recalculate tool usage
# This script reads session files and updates the tool_usage table

$dbPath = "$env:APPDATA\clausitron\clausitron.db"
$claudeDir = "$env:USERPROFILE\.claude\projects"

Write-Host "Database: $dbPath"
Write-Host "Claude sessions dir: $claudeDir"

# Create a Node.js script inline that doesn't use better-sqlite3
$nodeScript = @'
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const dbPath = process.argv[2];
const claudeDir = process.argv[3];

// Tool parsing functions
function parseMcpCliTool(toolRef) {
  if (!toolRef || typeof toolRef !== 'string') return null;
  const parts = toolRef.split('/');
  if (parts.length !== 2) return `mcp-cli: ${toolRef}`;
  const [server, tool] = parts;
  if (!server || !tool) return `mcp-cli: ${toolRef}`;
  if (server.toLowerCase().includes('goodvibes')) return `goodvibes - ${tool}`;
  return `mcp:${server} - ${tool}`;
}

function parseBashCommand(command) {
  if (!command || typeof command !== 'string') return ['Bash'];

  const mcpMatch = command.match(/mcp-cli\s+(?:call|info)\s+([^\s'"]+)/);
  const mcpOtherMatch = command.match(/^mcp-cli\s+(tools|servers|grep|resources|read)\b/i);
  if (mcpOtherMatch) return [`mcp-cli ${mcpOtherMatch[1]}`];
  if (mcpMatch && mcpMatch[1]) {
    const tool = parseMcpCliTool(mcpMatch[1]);
    if (tool) return [tool];
  }

  const cleanedCommand = command
    .replace(/^cd\s+\/d\s+"[^"]+"\s*&&\s*/i, '')
    .replace(/^cd\s+\/d\s+[^\s]+\s*&&\s*/i, '')
    .replace(/^cd\s+"[^"]+"\s*&&\s*/i, '')
    .replace(/^cd\s+[^\s]+\s*&&\s*/i, '')
    .trim();

  const patterns = [
    [/^git\s+(add|commit|push|pull|fetch|merge|rebase|checkout|branch|status|diff|log|stash|reset|cherry-pick|clone|init|tag|remote)/i, m => `git ${m[1]}`],
    [/^git\s+/i, 'git'],
    [/^npm\s+(install|run|test|build|start|publish|update|outdated|audit|ci|init|link|pack|uninstall)/i, m => `npm ${m[1]}`],
    [/^npm\s+/i, 'npm'],
    [/^pnpm\s+(install|run|test|build|add|remove|update)/i, m => `pnpm ${m[1]}`],
    [/^pnpm\s+/i, 'pnpm'],
    [/^yarn\s+(add|remove|install|run|build|test|start)/i, m => `yarn ${m[1]}`],
    [/^yarn\s+/i, 'yarn'],
    [/^bun\s+(install|run|test|build|add|remove)/i, m => `bun ${m[1]}`],
    [/^bun\s+/i, 'bun'],
    [/^(vitest|jest|mocha|playwright|cypress)/i, m => m[1].toLowerCase()],
    [/^(tsc|typescript|eslint|prettier|biome)/i, m => m[1].toLowerCase()],
    [/^(vite|webpack|rollup|esbuild|turbo)/i, m => m[1].toLowerCase()],
    [/^docker(-compose)?\s+(build|run|exec|ps|logs|pull|push|start|stop|up|down)/i, m => `docker ${m[2]}`],
    [/^docker(-compose)?\s+/i, 'docker'],
    [/^kubectl\s+(get|apply|delete|describe|logs|exec|port-forward)/i, m => `kubectl ${m[1]}`],
    [/^kubectl\s+/i, 'kubectl'],
    [/^(curl|wget|gh|az|aws|gcloud|terraform|pulumi)/i, m => m[1].toLowerCase()],
    [/^(python|python3|node|deno|ruby|go|cargo|rustc)/i, m => m[1].toLowerCase()],
    [/^(powershell|pwsh|cmd)/i, m => m[1].toLowerCase()],
    [/^(mkdir|rm|rmdir|mv|cp|touch|chmod|chown)/i, m => m[1].toLowerCase()],
    [/^(cat|head|tail|less|more|grep|find|ls|dir)/i, m => m[1].toLowerCase()],
    [/^(taskkill|tasklist|netstat|ipconfig|ping)/i, m => m[1].toLowerCase()],
    [/^npx\s+(\S+)/i, m => `npx ${m[1]}`],
    [/^(rd|del|copy|move|type|where|attrib|icacls)/i, m => m[1].toLowerCase()],
    [/^(echo|set|setx|cls|exit|pause)/i, m => m[1].toLowerCase()],
    [/^sqlite3?\s+/i, 'sqlite'],
    [/^(wc|timeout|sleep|pkill|kill)\b/i, m => m[1].toLowerCase()],
    [/^command\s+-v\s+/i, 'command'],
  ];

  for (const [pattern, handler] of patterns) {
    const match = cleanedCommand.match(pattern);
    if (match) {
      return [typeof handler === 'function' ? handler(match) : handler];
    }
  }
  return ['Bash'];
}

function resolveToolNames(name, input) {
  if (name === 'Bash' && input?.command) return parseBashCommand(input.command);
  return [name];
}

function extractToolUsage(entry, toolUsage) {
  if (entry.type === 'tool_use' || entry.tool_use) {
    const tool = entry.tool_use || entry;
    if (tool.name) {
      for (const n of resolveToolNames(tool.name, tool.input)) {
        toolUsage.set(n, (toolUsage.get(n) || 0) + 1);
      }
    }
  }
  if (entry.message?.content && Array.isArray(entry.message.content)) {
    for (const block of entry.message.content) {
      if (block.type === 'tool_use' && block.name) {
        for (const n of resolveToolNames(block.name, block.input)) {
          toolUsage.set(n, (toolUsage.get(n) || 0) + 1);
        }
      }
    }
  }
}

function processSession(filePath) {
  const toolUsage = new Map();
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n').filter(l => l.trim())) {
      try {
        extractToolUsage(JSON.parse(line), toolUsage);
      } catch (e) {}
    }
  } catch (e) {}
  return toolUsage;
}

// Get sessions from DB
const result = execSync(`sqlite3 "${dbPath}" "SELECT id || '|' || file_path FROM sessions WHERE file_path IS NOT NULL"`, { encoding: 'utf-8' });
const sessions = result.trim().split('\n').filter(l => l).map(l => {
  const [id, ...pathParts] = l.split('|');
  return { id, filePath: pathParts.join('|') };
});

console.log(`Processing ${sessions.length} sessions...`);

let processed = 0;
const allToolUsage = [];

for (const session of sessions) {
  if (!fs.existsSync(session.filePath)) continue;

  const toolUsage = processSession(session.filePath);
  if (toolUsage.size > 0) {
    for (const [name, count] of toolUsage) {
      allToolUsage.push({ sessionId: session.id, toolName: name, count });
    }
    processed++;
  }
}

console.log(`Processed ${processed} sessions with tool usage`);

// Clear existing and insert new
execSync(`sqlite3 "${dbPath}" "DELETE FROM tool_usage"`, { encoding: 'utf-8' });

// Insert in batches using VALUES
const batchSize = 100;
for (let i = 0; i < allToolUsage.length; i += batchSize) {
  const batch = allToolUsage.slice(i, i + batchSize);
  const values = batch.map(r =>
    `('${r.sessionId.replace(/'/g, "''")}', '${r.toolName.replace(/'/g, "''")}', ${r.count})`
  ).join(',');
  if (values) {
    execSync(`sqlite3 "${dbPath}" "INSERT INTO tool_usage (session_id, tool_name, count) VALUES ${values}"`, { encoding: 'utf-8' });
  }
  if ((i + batchSize) % 1000 === 0) {
    console.log(`Inserted ${Math.min(i + batchSize, allToolUsage.length)}/${allToolUsage.length} records...`);
  }
}

console.log(`\nInserted ${allToolUsage.length} tool usage records`);

// Show results
const stats = execSync(`sqlite3 "${dbPath}" "SELECT tool_name, SUM(count) as total FROM tool_usage GROUP BY tool_name ORDER BY total DESC LIMIT 30"`, { encoding: 'utf-8' });
console.log('\nTop 30 tools:');
console.log(stats);
'@

# Run the Node.js script
$nodeScript | node - "$dbPath" "$claudeDir"
