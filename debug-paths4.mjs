import { existsSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';

const DB_PATH = path.join(process.env.APPDATA, 'clausitron', 'clausitron.db');

function sqlite(query) {
  return execSync(`sqlite3 "${DB_PATH}" "${query}"`, { encoding: 'utf-8' }).trim();
}

// Get first 3 sessions
const sessionsResult = sqlite("SELECT id, file_path FROM sessions LIMIT 3;");
console.log('Raw SQLite result:');
console.log(JSON.stringify(sessionsResult));

const lines = sessionsResult.split('\n');
console.log('\nLines:', lines.length);

for (const line of lines) {
  console.log('\nLine:', JSON.stringify(line));
  const pipeIdx = line.indexOf('|');
  console.log('Pipe at:', pipeIdx);

  if (pipeIdx > 0) {
    const id = line.substring(0, pipeIdx);
    const filePath = line.substring(pipeIdx + 1);
    console.log('ID:', id);
    console.log('Path:', filePath);
    console.log('Path length:', filePath.length);

    // Test direct construction
    const testPath = 'C:/Users/buzzkill/.claude/projects/--192-168-0-85-movies2-/agent-ade5194.jsonl';
    console.log('Same as test?', filePath.replace(/\\/g, '/') === testPath);

    // Test existsSync
    console.log('Exists:', existsSync(filePath.replace(/\\/g, '/')));

    // Compare bytes
    const normalized = filePath.replace(/\\/g, '/');
    if (normalized.includes('ade5194')) {
      console.log('\nByte comparison:');
      for (let i = 0; i < Math.min(normalized.length, testPath.length); i++) {
        if (normalized.charCodeAt(i) !== testPath.charCodeAt(i)) {
          console.log(`  [${i}]: got ${normalized.charCodeAt(i)} expected ${testPath.charCodeAt(i)}`);
        }
      }
    }
  }
}
