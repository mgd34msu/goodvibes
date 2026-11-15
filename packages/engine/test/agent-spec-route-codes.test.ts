import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';

const ENGINE = join(import.meta.dir, '..');
const generator = readFileSync(join(ENGINE, 'scripts/generate-agent-spec.ts'), 'utf8');
const routeSources = readdirSync(join(ENGINE, 'daemon-api/src')).filter((name) => name.endsWith('.ts'))
  .map((name) => readFileSync(join(ENGINE, 'daemon-api/src', name), 'utf8'));

// The generated agent index promises these codes and statuses; a route that stopped sending one would leave the promise stale.
const documented = [...generator.matchAll(/\{ code: '([A-Z_]+)', status: (\d{3}),/g)].map((match) => ({ code: match[1]!, status: match[2]! }));

test('the generator documents the route codes it is meant to', () => {
  expect(documented.length).toBeGreaterThan(5);
});

test.each(documented)('$code is still sent by a route with status $status', ({ code, status }) => {
  const sends = routeSources.some((source) => {
    for (const match of source.matchAll(new RegExp(`(?:'${code}'|EngineErrorCodes\\.${code})`, 'g'))) {
      if (source.slice(match.index, match.index + 400).includes(status)) return true;
    }
    return false;
  });
  expect(sends).toBe(true);
});

test('the generated index points at routes the daemon serves', () => {
  const served = routeSources.join('\n');
  expect(generator).toContain("'/api/control/gateway-methods/{methodId}/invoke'");
  expect(served).toContain('/api/control/gateway-methods/:methodId/invoke');
  for (const path of generator.match(/\/api\/control-plane\/events(?:\/catalog)?/g) ?? []) expect(served).toContain(path);
  expect(generator).toContain('/api/control-plane/events');
});
