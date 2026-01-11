// Test tool parser
function parseBashCommand(command) {
  if (!command || typeof command !== 'string') {
    console.log('[TOOL_PARSE] No command or not string', { command });
    return ['Bash'];
  }
  const tools = [];
  console.log('[TOOL_PARSE] Parsing command', { command: command.substring(0, 100) });

  // Extract the first command (handle cd prefix)
  const cleanedCommand = command
    .replace(/^cd\s+"[^"]+"\s*&&\s*/i, '')
    .replace(/^cd\s+[^\s]+\s*&&\s*/i, '')
    .trim();

  console.log('[TOOL_PARSE] Cleaned command', { cleanedCommand: cleanedCommand.substring(0, 100) });

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
      console.log('[TOOL_PARSE] Matched pattern, toolName:', toolName);
      tools.push(toolName);
      break;
    }
  }
  const result = tools.length > 0 ? tools : ['Bash'];
  console.log('[TOOL_PARSE] Final result:', result);
  return result;
}

// Test with actual commands from the session
const testCommands = [
  'ls -1 "\\\\\\\\192.168.0.85\\\\movies3\\\\"',
  'powershell -Command "Rename-Item -LiteralPath ..."',
  'net use Z: "\\\\\\\\192.168.0.85\\\\movies3"',
];

for (const cmd of testCommands) {
  console.log('\n=== Testing Command ===');
  console.log('Input:', cmd);
  const result = parseBashCommand(cmd);
  console.log('Output:', result);
}
