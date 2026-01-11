const fs = require('fs');
const { execSync } = require('child_process');

// Get all sessions with Bash entries using sqlite3 CLI
const dbPath = process.env.APPDATA + '\\clausitron\\clausitron.db';
const result = execSync(`sqlite3 "${dbPath}" "SELECT DISTINCT file_path FROM sessions s JOIN tool_usage t ON s.id = t.session_id WHERE t.tool_name = 'Bash';"`, { encoding: 'utf8' });
const filePaths = result.trim().split(/\r?\n/).filter(Boolean);
console.log(`Found ${filePaths.length} session file paths`);

function parseBashCommand(command) {
  if (!command || typeof command !== 'string') {
    return ['Bash'];
  }

  const cleanedCommand = command
    .replace(/^cd\s+"[^"]+"\s*&&\s*/i, '')
    .replace(/^cd\s+[^\s]+\s*&&\s*/i, '')
    .trim();

  const commandPatterns = [
    { pattern: /^git\s+(add|commit|push|pull|fetch|merge|rebase|checkout|branch|status|diff|log|stash|reset|cherry-pick|clone|init|tag|remote)/i },
    { pattern: /^git\s+/i },
    { pattern: /^npm\s+(install|run|test|build|start|publish|update|outdated|audit|ci|init|link|pack)/i },
    { pattern: /^npm\s+/i },
    { pattern: /^pnpm\s+(install|run|test|build|add|remove|update)/i },
    { pattern: /^pnpm\s+/i },
    { pattern: /^yarn\s+(add|remove|install|run|build|test|start)/i },
    { pattern: /^yarn\s+/i },
    { pattern: /^bun\s+(install|run|test|build|add|remove)/i },
    { pattern: /^bun\s+/i },
    { pattern: /^(vitest|jest|mocha|playwright|cypress)/i },
    { pattern: /^(tsc|typescript|eslint|prettier|biome)/i },
    { pattern: /^(vite|webpack|rollup|esbuild|turbo)/i },
    { pattern: /^docker(-compose)?\s+(build|run|exec|ps|logs|pull|push|start|stop|up|down)/i },
    { pattern: /^docker(-compose)?\s+/i },
    { pattern: /^kubectl\s+(get|apply|delete|describe|logs|exec|port-forward)/i },
    { pattern: /^kubectl\s+/i },
    { pattern: /^(curl|wget|gh|az|aws|gcloud|terraform|pulumi)/i },
    { pattern: /^(python|python3|node|deno|bun|ruby|go|cargo|rustc)/i },
    { pattern: /^(powershell|pwsh|cmd)/i },
    { pattern: /^(mkdir|rm|rmdir|mv|cp|touch|chmod|chown)/i },
    { pattern: /^(cat|head|tail|less|more|grep|find|ls|dir)/i },
    { pattern: /^(taskkill|tasklist|netstat|ipconfig|ping)/i },
  ];

  for (const { pattern } of commandPatterns) {
    if (cleanedCommand.match(pattern)) {
      return ['matched'];
    }
  }
  return ['Bash'];
}

// Collect unrecognized commands
const unrecognized = new Map();
let processed = 0;

for (const file_path of filePaths) {
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
    processed++;
  } catch (e) {
    // Skip files we can't read
  }
}

// Sort by count and display
const sorted = [...unrecognized.entries()].sort((a, b) => b[1] - a[1]);
console.log(`Processed ${processed} session files`);
console.log('Top unrecognized command prefixes:');
for (const [cmd, count] of sorted.slice(0, 50)) {
  console.log(`${count.toString().padStart(5)}  ${cmd}`);
}
