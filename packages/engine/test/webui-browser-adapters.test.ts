import { describe, expect, test } from 'bun:test';
import { readWebuiStatusCatalog } from '../platform/src/platform/judgment-browser/batteries/webui-status-catalog.ts';

describe('WebUI status catalogs', () => {
  test('current status catalogs use exhaustive structural mappings', () => {
    expect(readWebuiStatusCatalog('session.closed', 'badge')).toEqual({ vocabulary: 'badge', tone: 'neutral' });
    expect(readWebuiStatusCatalog('knowledge-job.running', 'library-dot')).toEqual({ vocabulary: 'library-dot', tone: 'info' });
    expect(readWebuiStatusCatalog('knowledge-job.completed', 'library-dot')).toEqual({ vocabulary: 'library-dot', tone: 'ok' });
    expect(readWebuiStatusCatalog('knowledge-job.future-status', 'badge')).toBeUndefined();
  });
});
