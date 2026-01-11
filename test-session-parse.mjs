import fs from 'fs/promises';

// Copy of inline parsing functions
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
  if (mcpMatch && mcpMatch[1]) {
    const mcpTool = parseMcpCliTool(mcpMatch[1]);
    if (mcpTool) {
      tools.push(mcpTool);
    }
  }
  if (tools.length > 0) {
    return tools;
  }

  // Extract the first command (handle cd prefix)
  const cleanedCommand = command
    .replace(/^cd\s+"[^"]+"\s*&&\s*/i, '')
    .replace(/^cd\s+[^\s]+\s*&&\s*/i, '')
    .trim();

  const commandPatterns = [
    { pattern: /^git\s+(add|commit|push|pull|fetch|merge|rebase|checkout|branch|status|diff|log|stash|reset|cherry-pick|clone|init|tag|remote)/i, name: (m) => `git ${m[1] ?? ''}` },
    { pattern: /^git\s+/i, name: 'git' },
    { pattern: /^npm\s+(install|run|test|build|start|publish|update|outdated|audit|ci|init|link|pack)/i, name: (m) => `npm ${m[1] ?? ''}` },
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

// Parse actual session file
const filePath = process.env.USERPROFILE + '/.claude/projects/C--Users-buzzkill/01953930-1119-43d3-90e2-e7d532fbe0d2.jsonl';

async function main() {
  const content = await fs.readFile(filePath, 'utf-8');
  const lines = content.trim().split('\n').filter(l => l.trim());
  const toolUsage = new Map();

  console.log(`Parsing ${lines.length} lines...`);

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      extractToolUsage(entry, toolUsage);
    } catch (e) {
      // Skip malformed
    }
  }

  console.log('\nTool Usage:');
  console.log('='.repeat(60));
  const sorted = [...toolUsage.entries()].sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sorted) {
    console.log(`${name}: ${count}`);
  }
}

main().catch(console.error);
