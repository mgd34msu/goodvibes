const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Get all sessions with Bash entries
const dbPath = path.join(process.env.APPDATA, 'clausitron', 'clausitron.db');
const db = new Database(dbPath);

const sessions = db.prepare(`
  SELECT DISTINCT s.file_path
  FROM sessions s
  JOIN tool_usage t ON s.id = t.session_id
  WHERE t.tool_name = 'Bash'
`).all();

function parseBashCommand(command) {
  if (!command || typeof command !== 'string') {
    return ['Bash'];
  }
  const tools = [];

  const cleanedCommand = command
    .replace(/^cd\s+"[^"]+"\s*&&\s*/i, '')
    .replace(/^cd\s+[^\s]+\s*&&\s*/i, '')
    .trim();

  const commandPatterns = [
    { pattern: /^git\s+(add|commit|push|pull|fetch|merge|rebase|checkout|branch|status|diff|log|stash|reset|cherry-pick|clone|init|tag|remote)/i, name: (m) => 'git ' + (m[1] || '') },
    { pattern: /^git\s+/i, name: 'git' },
    { pattern: /^npm\s+(install|run|test|build|start|publish|update|outdated|audit|ci|init|link|pack)/i, name: (m) => 'npm ' + (m[1] || '') },
    { pattern: /^npm\s+/i, name: 'npm' },
    { pattern: /^pnpm\s+(install|run|test|build|add|remove|update)/i, name: (m) => 'pnpm ' + (m[1] || '') },
    { pattern: /^pnpm\s+/i, name: 'pnpm' },
    { pattern: /^yarn\s+(add|remove|install|run|build|test|start)/i, name: (m) => 'yarn ' + (m[1] || '') },
    { pattern: /^yarn\s+/i, name: 'yarn' },
    { pattern: /^bun\s+(install|run|test|build|add|remove)/i, name: (m) => 'bun ' + (m[1] || '') },
    { pattern: /^bun\s+/i, name: 'bun' },
    { pattern: /^(vitest|jest|mocha|playwright|cypress)/i, name: (m) => (m[1] || 'unknown').toLowerCase() },
    { pattern: /^(tsc|typescript|eslint|prettier|biome)/i, name: (m) => (m[1] || 'unknown').toLowerCase() },
    { pattern: /^(vite|webpack|rollup|esbuild|turbo)/i, name: (m) => (m[1] || 'unknown').toLowerCase() },
    { pattern: /^docker(-compose)?\s+(build|run|exec|ps|logs|pull|push|start|stop|up|down)/i, name: (m) => 'docker ' + (m[2] || '') },
    { pattern: /^docker(-compose)?\s+/i, name: 'docker' },
    { pattern: /^kubectl\s+(get|apply|delete|describe|logs|exec|port-forward)/i, name: (m) => 'kubectl ' + (m[1] || '') },
    { pattern: /^kubectl\s+/i, name: 'kubectl' },
    { pattern: /^(curl|wget|gh|az|aws|gcloud|terraform|pulumi)/i, name: (m) => (m[1] || 'unknown').toLowerCase() },
    { pattern: /^(python|python3|node|deno|bun|ruby|go|cargo|rustc)/i, name: (m) => (m[1] || 'unknown').toLowerCase() },
    { pattern: /^(powershell|pwsh|cmd)/i, name: (m) => (m[1] || 'unknown').toLowerCase() },
    { pattern: /^(mkdir|rm|rmdir|mv|cp|touch|chmod|chown)/i, name: (m) => (m[1] || 'unknown').toLowerCase() },
    { pattern: /^(cat|head|tail|less|more|grep|find|ls|dir)/i, name: (m) => (m[1] || 'unknown').toLowerCase() },
    { pattern: /^(taskkill|tasklist|netstat|ipconfig|ping)/i, name: (m) => (m[1] || 'unknown').toLowerCase() },
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

// Collect unrecognized commands
const unrecognized = new Map();

for (const { file_path } of sessions) {
  if (!fs.existsSync(file_path)) continue;

  try {
    const content = fs.readFileSync(file_path, 'utf8');
    const lines = content.trim().split('\n');

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.message?.content && Array.isArray(entry.message.content)) {
          for (const block of entry.message.content) {
            if (block.type === 'tool_use' && block.name === 'Bash') {
              const cmd = block.input?.command;
              const result = parseBashCommand(cmd);
              if (result[0] === 'Bash' && cmd) {
                // Extract just the first word/command
                const firstWord = cmd.trim().split(/\s+/)[0]?.toLowerCase() || 'unknown';
                unrecognized.set(firstWord, (unrecognized.get(firstWord) || 0) + 1);
              }
            }
          }
        }
      } catch (e) {}
    }
  } catch (e) {
    // Skip files we can't read
  }
}

// Sort by count and display
const sorted = [...unrecognized.entries()].sort((a, b) => b[1] - a[1]);
console.log('Top unrecognized command prefixes:');
for (const [cmd, count] of sorted.slice(0, 50)) {
  console.log(`${count.toString().padStart(5)}  ${cmd}`);
}

db.close();
