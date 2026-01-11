// Test script for extractToolUsage from actual session entries

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
    console.log('[TOOL_PARSE] No command or not string', { command });
    return ['Bash'];
  }
  const tools = [];
  console.log('[TOOL_PARSE] Parsing command', { command: command.substring(0, 100) });

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
  console.log('[RESOLVE] toolName:', toolName, 'toolInput:', toolInput ? JSON.stringify(toolInput).substring(0, 100) : null);
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
      console.log('[DIRECT] Found direct tool_use:', toolName);
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
        console.log('[NESTED] Found nested tool_use:', block.name, 'input:', block.input ? 'present' : 'missing');
        const resolvedNames = resolveToolNames(block.name, block.input);
        for (const name of resolvedNames) {
          toolUsage.set(name, (toolUsage.get(name) || 0) + 1);
        }
      }
    }
  }
}

// Test with actual session entry from the file we read
const testEntry = {
  "parentUuid": "dc9e5c3f-7d02-4400-8366-d6e898c5ed7a",
  "message": {
    "model": "claude-opus-4-5-20251101",
    "id": "msg_01Y8hBAjbeBMBTDaeQJomQVX",
    "type": "message",
    "role": "assistant",
    "content": [
      {
        "type": "tool_use",
        "id": "toolu_01RJp3HkN2SX9Q7DGmvZWaEj",
        "name": "Bash",
        "input": {
          "command": "command -v opencode && opencode --version || echo \"NOT_INSTALLED\"",
          "description": "Check if OpenCode is installed"
        }
      }
    ]
  },
  "type": "assistant"
};

const testEntry2 = {
  "message": {
    "content": [
      {
        "type": "tool_use",
        "name": "Bash",
        "input": {
          "command": "git status"
        }
      }
    ]
  }
};

console.log('='.repeat(60));
console.log('Test 1: Entry with full structure');
console.log('='.repeat(60));
const toolUsage1 = new Map();
extractToolUsage(testEntry, toolUsage1);
console.log('Result:', Object.fromEntries(toolUsage1));

console.log('\n' + '='.repeat(60));
console.log('Test 2: Entry with git status');
console.log('='.repeat(60));
const toolUsage2 = new Map();
extractToolUsage(testEntry2, toolUsage2);
console.log('Result:', Object.fromEntries(toolUsage2));
