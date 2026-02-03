// ============================================================================
// TOOL PARSER UTILITIES
// Parse tool names from Bash commands and MCP-CLI calls
// ============================================================================

/**
 * Extract the actual tool/command being called from a Bash command string.
 * Returns an array of tool names (may include multiple for chained commands).
 */
export function parseBashCommand(command: string): string[] {
  if (!command || typeof command !== 'string') {
    return ['Bash'];
  }

  const tools: string[] = [];

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

  // If we found mcp-cli tools, return them
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

  // Known command patterns to extract
  const commandPatterns: Array<{ pattern: RegExp; name: string | ((match: RegExpMatchArray) => string) }> = [
    // Git operations
    { pattern: /^git\s+(add|commit|push|pull|fetch|merge|rebase|checkout|branch|status|diff|log|stash|reset|cherry-pick|clone|init|tag|remote)/i, name: (m) => `git ${m[1] ?? ''}` },
    { pattern: /^git\s+/i, name: 'git' },

    // Package managers
    { pattern: /^npm\s+(install|run|test|build|start|publish|update|outdated|audit|ci|init|link|pack|uninstall)/i, name: (m) => `npm ${m[1] ?? ''}` },
    { pattern: /^npm\s+/i, name: 'npm' },
    { pattern: /^pnpm\s+(install|run|test|build|add|remove|update)/i, name: (m) => `pnpm ${m[1] ?? ''}` },
    { pattern: /^pnpm\s+/i, name: 'pnpm' },
    { pattern: /^yarn\s+(add|remove|install|run|build|test|start)/i, name: (m) => `yarn ${m[1] ?? ''}` },
    { pattern: /^yarn\s+/i, name: 'yarn' },
    { pattern: /^bun\s+(install|run|test|build|add|remove)/i, name: (m) => `bun ${m[1] ?? ''}` },
    { pattern: /^bun\s+/i, name: 'bun' },

    // Build/test tools
    { pattern: /^(vitest|jest|mocha|playwright|cypress)/i, name: (m) => (m[1] ?? 'unknown').toLowerCase() },
    { pattern: /^(tsc|typescript|eslint|prettier|biome)/i, name: (m) => (m[1] ?? 'unknown').toLowerCase() },
    { pattern: /^(vite|webpack|rollup|esbuild|turbo)/i, name: (m) => (m[1] ?? 'unknown').toLowerCase() },

    // Docker/containers
    { pattern: /^docker(-compose)?\s+(build|run|exec|ps|logs|pull|push|start|stop|up|down)/i, name: (m) => `docker ${m[2] ?? ''}` },
    { pattern: /^docker(-compose)?\s+/i, name: 'docker' },
    { pattern: /^kubectl\s+(get|apply|delete|describe|logs|exec|port-forward)/i, name: (m) => `kubectl ${m[1] ?? ''}` },
    { pattern: /^kubectl\s+/i, name: 'kubectl' },

    // Common CLI tools
    { pattern: /^(curl|wget|gh|az|aws|gcloud|terraform|pulumi)/i, name: (m) => (m[1] ?? 'unknown').toLowerCase() },
    { pattern: /^(python|python3|node|deno|bun|ruby|go|cargo|rustc)/i, name: (m) => (m[1] ?? 'unknown').toLowerCase() },
    { pattern: /^(powershell|pwsh|cmd)/i, name: (m) => (m[1] ?? 'unknown').toLowerCase() },

    // File operations (when used explicitly)
    { pattern: /^(mkdir|rm|rmdir|mv|cp|touch|chmod|chown)/i, name: (m) => (m[1] ?? 'unknown').toLowerCase() },
    { pattern: /^(cat|head|tail|less|more|grep|find|ls|dir)/i, name: (m) => (m[1] ?? 'unknown').toLowerCase() },

    // Windows-specific
    { pattern: /^(taskkill|tasklist|netstat|ipconfig|ping)/i, name: (m) => (m[1] ?? 'unknown').toLowerCase() },

    // npx commands
    { pattern: /^npx\s+(\S+)/i, name: (m) => `npx ${m[1] ?? ''}` },

    // More Windows-specific commands
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

  // If no patterns matched, fall back to generic "Bash"
  return tools.length > 0 ? tools : ['Bash'];
}

/**
 * Parse an mcp-cli tool reference and return a formatted tool name.
 * For goodvibes MCP server tools, returns "goodvibes - toolname"
 * For other MCP tools, returns "mcp:<server> - toolname"
 */
export function parseMcpCliTool(toolRef: string): string | null {
  if (!toolRef || typeof toolRef !== 'string') {
    return null;
  }

  // Format: server/tool
  const parts = toolRef.split('/');
  if (parts.length !== 2) {
    return `mcp-cli: ${toolRef}`;
  }

  const server = parts[0];
  const tool = parts[1];

  if (!server || !tool) {
    return `mcp-cli: ${toolRef}`;
  }

  // Check for goodvibes MCP server (various possible names)
  const isGoodvibes = server.toLowerCase().includes('goodvibes');

  if (isGoodvibes) {
    return `goodvibes - ${tool}`;
  }

  // Other MCP servers get a different format
  return `mcp:${server} - ${tool}`;
}

/**
 * Parse a tool_use entry and return resolved tool names.
 * Handles Bash commands specially to extract the actual tool being called.
 */
export function resolveToolNames(toolName: string, toolInput: Record<string, unknown> | null): string[] {
  // If it's a Bash tool, parse the command
  if (toolName === 'Bash' && toolInput && typeof toolInput.command === 'string') {
    return parseBashCommand(toolInput.command);
  }

  // Return the tool name as-is for non-Bash tools
  return [toolName];
}
