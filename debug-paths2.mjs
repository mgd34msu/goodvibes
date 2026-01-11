import { existsSync, statSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';

const DB_PATH = path.join(process.env.APPDATA, 'clausitron', 'clausitron.db');

// Direct test
const testPath = 'C:/Users/buzzkill/.claude/projects/--192-168-0-85-movies2-/agent-ade5194.jsonl';
console.log('Direct test:');
console.log(`  Path: ${testPath}`);
console.log(`  Exists: ${existsSync(testPath)}`);

// Get path from sqlite
const result = execSync(`sqlite3 "${DB_PATH}" "SELECT file_path FROM sessions WHERE file_path LIKE '%agent-ade5194%';"`, { encoding: 'utf-8' }).trim();
console.log(`\nFrom SQLite:`);
console.log(`  Raw: ${JSON.stringify(result)}`);
console.log(`  Length: ${result.length}`);

// Check character codes
console.log('  Char codes:', [...result].slice(0, 30).map(c => c.charCodeAt(0)));

const normalized = result.replace(/\\/g, '/');
console.log(`  Normalized: ${normalized}`);
console.log(`  Exists: ${existsSync(normalized)}`);

// Try direct path construction
const directPath = `C:/Users/buzzkill/.claude/projects/--192-168-0-85-movies2-/agent-ade5194.jsonl`;
console.log(`\nDirect construction:`);
console.log(`  Path: ${directPath}`);
console.log(`  Exists: ${existsSync(directPath)}`);
