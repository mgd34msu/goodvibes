import { existsSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';

const DB_PATH = path.join(process.env.APPDATA, 'clausitron', 'clausitron.db');

// Get raw bytes from sqlite
const result = execSync(`sqlite3 "${DB_PATH}" "SELECT file_path FROM sessions WHERE file_path LIKE '%agent-ade5194%';"`, { encoding: 'utf-8' });

console.log('Raw result inspection:');
console.log(`  Length with newlines: ${result.length}`);
console.log(`  Trimmed length: ${result.trim().length}`);

const trimmed = result.trim();
console.log('  First 20 chars:', [...trimmed].slice(0, 20).join(''));
console.log('  Last 20 chars:', [...trimmed].slice(-20).join(''));

// Check for problematic characters
console.log('\n  All character codes:');
for (let i = 0; i < trimmed.length; i++) {
  const c = trimmed[i];
  const code = c.charCodeAt(0);
  if (code < 32 || code > 126 || c === '\\') {
    console.log(`    [${i}]: '${c}' (${code})`);
  }
}

// Normalize and test
const normalized = trimmed.replace(/\\/g, '/');
console.log(`\n  Normalized: ${normalized}`);
console.log(`  Exists: ${existsSync(normalized)}`);

// Compare with direct construction
const direct = 'C:/Users/buzzkill/.claude/projects/--192-168-0-85-movies2-/agent-ade5194.jsonl';
console.log(`\n  Direct length: ${direct.length}`);
console.log(`  Same as normalized: ${normalized === direct}`);

if (normalized !== direct) {
  console.log('\n  Differences:');
  for (let i = 0; i < Math.max(normalized.length, direct.length); i++) {
    if (normalized[i] !== direct[i]) {
      console.log(`    [${i}]: normalized='${normalized[i]}' (${normalized.charCodeAt(i)}) vs direct='${direct[i]}' (${direct.charCodeAt(i)})`);
    }
  }
}
