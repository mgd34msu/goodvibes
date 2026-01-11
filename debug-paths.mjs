import { existsSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';

const DB_PATH = path.join(process.env.APPDATA, 'clausitron', 'clausitron.db');

function sqlite(query) {
  return execSync(`sqlite3 "${DB_PATH}" "${query}"`, { encoding: 'utf-8' }).trim();
}

// Get first 10 sessions
const sessionsResult = sqlite("SELECT id, file_path FROM sessions LIMIT 10;");
const sessions = sessionsResult.split('\n').filter(l => l).map(line => {
  const [id, ...pathParts] = line.split('|');
  return { id, filePath: pathParts.join('|') };
});

console.log('Checking paths:');
for (const s of sessions) {
  const originalPath = s.filePath;
  const normalizedPath = originalPath.replace(/\\/g, '/');
  const existsOriginal = existsSync(originalPath);
  const existsNormalized = existsSync(normalizedPath);
  console.log(`Original: ${originalPath}`);
  console.log(`  Exists original: ${existsOriginal}`);
  console.log(`  Exists normalized: ${existsNormalized}`);
  console.log('');
}
