// Direct test against the built bundle
// This will import from the actual compiled output

import fs from 'fs/promises';
import path from 'path';

// Since the bundle is an IIFE, we can't easily import it
// Let's just test the parsing logic by extracting and running it

// Copy the logic from the built bundle
function fo(t) {
  if (!t || typeof t != "string")
    return null;
  const e = t.split("/");
  if (e.length !== 2)
    return `mcp-cli: ${t}`;
  const s = e[0], n = e[1];
  return !s || !n ? `mcp-cli: ${t}` : s.toLowerCase().includes("goodvibes") ? `goodvibes - ${n}` : `mcp:${s} - ${n}`;
}

// Mock logger
const D = { debug: () => {} };

function mo(t) {
  if (!t || typeof t != "string")
    return D.debug("[TOOL_PARSE] No command or not string", { command: t }), ["Bash"];
  const e = [];
  D.debug("[TOOL_PARSE] Parsing command", { command: t.substring(0, 100) });
  const s = t.match(/mcp-cli\s+(?:call|info)\s+([^\s'"]+)/);
  if (s && s[1]) {
    const a = fo(s[1]);
    a && e.push(a);
  }
  if (e.length > 0)
    return e;
  const n = t.replace(/^cd\s+"[^"]+"\s*&&\s*/i, "").replace(/^cd\s+[^\s]+\s*&&\s*/i, "").trim(), r = [
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
    { pattern: /^(python|python3|node|deno|bun|ruby|go|cargo|rustc)/i, name: (a) => (a[1] ?? "unknown").toLowerCase() },
    { pattern: /^(powershell|pwsh|cmd)/i, name: (a) => (a[1] ?? "unknown").toLowerCase() },
    { pattern: /^(mkdir|rm|rmdir|mv|cp|touch|chmod|chown)/i, name: (a) => (a[1] ?? "unknown").toLowerCase() },
    { pattern: /^(cat|head|tail|less|more|grep|find|ls|dir)/i, name: (a) => (a[1] ?? "unknown").toLowerCase() },
    { pattern: /^(taskkill|tasklist|netstat|ipconfig|ping)/i, name: (a) => (a[1] ?? "unknown").toLowerCase() }
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

function $s(t, e) {
  return t === "Bash" && e && typeof e.command == "string" ? mo(e.command) : [t];
}

function extractToolUsage(entry, toolUsage) {
  if (entry.type === "tool_use" || entry.tool_use) {
    const tool = entry.tool_use || entry;
    const toolName = tool.name;
    const toolInput = tool.input;
    if (toolName) {
      const resolvedNames = $s(toolName, toolInput);
      for (const name of resolvedNames)
        toolUsage.set(name, (toolUsage.get(name) || 0) + 1);
    }
  }
  if (entry.message?.content && Array.isArray(entry.message.content)) {
    for (const block of entry.message.content) {
      if (block.type === "tool_use" && block.name) {
        const resolvedNames = $s(block.name, block.input);
        for (const name of resolvedNames)
          toolUsage.set(name, (toolUsage.get(name) || 0) + 1);
      }
    }
  }
}

// Parse actual session file
const filePath = path.join(process.env.USERPROFILE, '.claude', 'projects', 'C--Users-buzzkill', '01953930-1119-43d3-90e2-e7d532fbe0d2.jsonl');

async function main() {
  const content = await fs.readFile(filePath, 'utf-8');
  const lines = content.trim().split('\n').filter(l => l.trim());
  const toolUsage = new Map();

  console.log(`Parsing ${lines.length} lines using BUILT logic...`);

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      extractToolUsage(entry, toolUsage);
    } catch (e) {
      // Skip malformed
    }
  }

  console.log('\nTool Usage from BUILT code:');
  console.log('='.repeat(60));
  const sorted = [...toolUsage.entries()].sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sorted) {
    console.log(`${name}: ${count}`);
  }
}

main().catch(console.error);
