import { expect, test } from 'bun:test';
import { createKnowledgeUriCanonicalizer } from '../platform/src/platform/knowledge/uri-canonicalization/reader.js';

test('click-tracking parameters are dropped whatever their case, and the rest are ordered', async () => {
  const canonical = await createKnowledgeUriCanonicalizer().canonicalize('https://Example.com/p?GCLID=abc&b=2&a=1&FBCLID=z&UTM_source=x');
  expect(canonical).toBe('https://example.com/p?a=1&b=2');
});
