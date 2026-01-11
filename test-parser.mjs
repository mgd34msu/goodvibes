// Test script for tool parsing logic

function parseBashCommand(command) {
  if (!command || typeof command !== 'string') {
    return ['Bash'];
  }
  const tools = [];

  // Check for mcp-cli calls first (highest priority)
  const mcpMatch = command.match(/mcp-cli\s+(?:call|info)\s+([^\s'"]+)/);
  if (mcpMatch && mcpMatch[1]) {
    const toolRef = mcpMatch[1];
    const parts = toolRef.split('/');
    if (parts.length === 2) {
      const server = parts[0];
      const tool = parts[1];
      if (server.toLowerCase().includes('goodvibes')) {
        tools.push(`goodvibes - ${tool}`);
      } else {
        tools.push(`mcp:${server} - ${tool}`);
      }
    } else {
      tools.push(`mcp-cli: ${toolRef}`);
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
    { pattern: /^npx\s+(\S+)/i, name: (m) => `npx ${m[1] ?? ''}` },  // npx with command
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
    // Windows-specific commands
    { pattern: /^(rd|del|copy|move|type|where|attrib|icacls)/i, name: (m) => (m[1] ?? 'unknown').toLowerCase() },
    { pattern: /^(echo|set|setx|cls|exit|pause)/i, name: (m) => (m[1] ?? 'unknown').toLowerCase() },
    // SQLite
    { pattern: /^sqlite3?\s+/i, name: 'sqlite' },
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

// Test cases from actual session
const tests = [
  { name: 'Bash', input: { command: 'command -v opencode && opencode --version || echo "NOT_INSTALLED"' } },
  { name: 'Bash', input: { command: 'git status' } },
  { name: 'Bash', input: { command: 'npm run build' } },
  { name: 'Bash', input: { command: 'mcp-cli call plugin_goodvibes_goodvibes-tools/detect_stack' } },
  { name: 'Bash', input: { command: 'curl -fsSL https://opencode.ai/install | bash' } },
  { name: 'Bash', input: { command: 'ls -la ~/.local/bin/opencode' } },
  { name: 'Read', input: { file_path: '/some/file.ts' } },
  { name: 'Bash', input: { command: 'cat ~/.config/opencode/opencode.json' } },
  // New test cases from actual Bash entries
  { name: 'Bash', input: { command: 'npx electron-rebuild -f -w better-sqlite3' } },
  { name: 'Bash', input: { command: 'npx tsc -p tsconfig.main.json' } },
  { name: 'Bash', input: { command: 'rd /s /q "C:\\path"' } },
  { name: 'Bash', input: { command: 'cd /d C:\\path && npm run dev:renderer' } },
  { name: 'Bash', input: { command: 'npm uninstall better-sqlite3 && npm install sql.js --save' } },
  { name: 'Bash', input: { command: 'sqlite3 database.db "SELECT * FROM users"' } },
  { name: 'Bash', input: { command: 'echo "hello"' } },
  { name: 'Bash', input: { command: 'type file.txt' } },
  { name: 'Bash', input: { command: 'del file.txt' } },
  { name: 'Bash', input: { command: 'copy src dst' } },
  { name: 'Bash', input: { command: 'move src dst' } },
  { name: 'Bash', input: { command: 'where node' } },
];

console.log('Testing resolveToolNames:');
console.log('='.repeat(80));
let bashCount = 0;
for (const test of tests) {
  const result = resolveToolNames(test.name, test.input);
  const cmdPreview = test.input.command?.substring(0, 50) || 'N/A';
  const isBash = result.includes('Bash');
  if (isBash) bashCount++;
  console.log(`${isBash ? '❌' : '✓'} "${cmdPreview}${test.input.command?.length > 50 ? '...' : ''}" => ${JSON.stringify(result)}`);
}
console.log('='.repeat(80));
console.log(`Total: ${tests.length}, Unresolved (Bash): ${bashCount}`);
