import { expect, test } from 'bun:test';
import { inspectBundle } from '../terminal-shell/src/support-bundle-inspection.ts';

test('support-bundle inspection reads own data paths without invoking getters or following prototypes', () => {
  let getters = 0;
  const provider = Object.create({ model: 'inherited model' }) as object;
  Object.defineProperty(provider, 'key', {
    get() {
      getters++;
      throw new Error('synthetic credential');
    },
  });
  const report = inspectBundle('fixture.json', { type: 'support', version: '3.0.0', config: { provider }, diagnostics: {} }, [
    { key: 'provider.model' },
    { key: 'provider.key' },
    { key: 'constructor.prototype.model' },
  ]);
  expect(report.configKeys).toBe(0);
  expect(getters).toBe(0);
  expect(JSON.stringify(report)).not.toContain('synthetic credential');
});
