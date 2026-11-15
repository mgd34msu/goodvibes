import { expect, test } from 'bun:test';
import { sourceFindings } from '../scripts/judgment-lint-rules.ts';

const registered = new Set<string>();
const messages = (source: string): string[] => sourceFindings('z.ts', source, registered).map((finding) => finding.message);

test('a request built in a local const and sent to ask is flagged like an inline one', () => {
  const found = messages(`
    async function classify(port) {
      const request = { state: 'x', questions: { q: noul('?') } };
      return port.ask(request);
    }
  `);
  expect(found).toEqual(['asks Jev with a request built inline, outside a registered decision']);
});

test('a forwarded request whose shape cannot be resolved is not flagged', () => {
  expect(messages(`
    function wrap(port) { return { ask: (request) => port.ask(request) }; }
  `)).toEqual([]);
});

test('a built const without questions is not flagged', () => {
  expect(messages(`
    async function other(port) { const request = { state: 'x' }; return port.ask(request); }
  `)).toEqual([]);
});
