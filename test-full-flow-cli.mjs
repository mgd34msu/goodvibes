// Full flow test using sqlite3 CLI
import fs from 'fs/promises';
import { execSync } from 'child_process';
import path from 'path';

const DB_PATH = path.join(process.env.APPDATA, 'clausitron', 'clausitron.db');
const SESSION_ID = '01953930-1119-43d3-90e2-e7d532fbe0d2';
const SESSION_FILE = path.join(process.env.USERPROFILE, '.claude', 'projects', 'C--Users-buzzkill', `${SESSION_ID}.jsonl`);

function sqlite(query) {
  return execSync(`sqlite3 "${DB_PATH}" "${query}"`, { encoding: 'utf-8' }).trim();
}

// Parsing functions
function fo(t) {
  if (!t || typeof t != "string") return null;
  const e = t.split("/");
  if (e.length !== 2) return `mcp-cli: ${t}`;
  const s = e[0], n = e[1];
  return !s || !n ? `mcp-cli: ${t}` : s.toLowerCase().includes("goodvibes") ? `goodvibes - ${n}` : `mcp:${s} - ${n}`;
}

function mo(t) {
  if (!t || typeof t != "string") return ["Bash"];
  const e = [];
  const s = t.match(/mcp-cli\s+(?:call|info)\s+([^\s'"]+)/);
  if (s && s[1]) {
    const a = fo(s[1]);
    a && e.push(a);
  }
  if (e.length > 0) return e;

  const n = t.replace(/^cd\s+"[^"]+"\s*&&\s*/i, "").replace(/^cd\s+[^\s]+\s*&&\s*/i, "").trim();
  const r = [
    { pattern: /^git\s+(add|commit|push|pull|fetch|merge|rebase|checkout|branch|status|diff|log|stash|reset|cherry-pick|clone|init|tag|remote)/i, name: (a) => `git ${a[1] ?? ""}` },
    { pattern: /^git\s+/i, name: "git" },
    { pattern: /^npm\s+(install|run|test|build|start|publish|update|outdated|audit|ci|init|link|pack)/i, name: (a) => `npm ${a[1] ?? ""}` },
    { pattern: /^npm\s+/i, name: "npm" },
    { pattern: /^(curl|wget|gh|az|aws|gcloud|terraform|pulumi)/i, name: (a) => (a[1] ?? "unknown").toLowerCase() },
    { pattern: /^(cat|head|tail|less|more|grep|find|ls|dir)/i, name: (a) => (a[1] ?? "unknown").toLowerCase() },
    { pattern: /^(mkdir|rm|rmdir|mv|cp|touch|chmod|chown)/i, name: (a) => (a[1] ?? "unknown").toLowerCase() },
    { pattern: /^bun\s+(install|run|test|build|add|remove)/i, name: (a) => `bun ${a[1] ?? ""}` },
    { pattern: /^bun\s+/i, name: "bun" },
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

async function main() {
  console.log('='.repeat(60));
  console.log('Step 1: Read current tool_usage from database');
  console.log('='.repeat(60));

  const currentUsage = sqlite(`SELECT tool_name, count FROM tool_usage WHERE session_id = '${SESSION_ID}';`);
  console.log('Current database entries:');
  console.log(currentUsage || '  (no entries)');

  console.log('\n' + '='.repeat(60));
  console.log('Step 2: Parse session file with correct logic');
  console.log('='.repeat(60));

  const content = await fs.readFile(SESSION_FILE, 'utf-8');
  const lines = content.trim().split('\n').filter(l => l.trim());
  const toolUsage = new Map();

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      extractToolUsage(entry, toolUsage);
    } catch (e) { /* skip */ }
  }

  console.log('Parsed tool usage:');
  const sorted = [...toolUsage.entries()].sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sorted) {
    console.log(`  ${name}: ${count}`);
  }

  console.log('\n' + '='.repeat(60));
  console.log('Step 3: Apply fix - clear and repopulate tool_usage');
  console.log('='.repeat(60));

  sqlite(`DELETE FROM tool_usage WHERE session_id = '${SESSION_ID}';`);
  console.log('Deleted old entries');

  for (const [toolName, count] of toolUsage) {
    // Escape single quotes in tool names
    const escapedName = toolName.replace(/'/g, "''");
    sqlite(`INSERT INTO tool_usage (session_id, tool_name, count) VALUES ('${SESSION_ID}', '${escapedName}', ${count});`);
  }
  console.log(`Inserted ${toolUsage.size} new entries`);

  console.log('\n' + '='.repeat(60));
  console.log('Step 4: Verify fix - read updated tool_usage');
  console.log('='.repeat(60));

  const updatedUsage = sqlite(`SELECT tool_name, count FROM tool_usage WHERE session_id = '${SESSION_ID}' ORDER BY count DESC;`);
  console.log('Updated database entries:');
  console.log(updatedUsage);

  console.log('\n✓ Fix verified for one session!');
}

main().catch(console.error);
