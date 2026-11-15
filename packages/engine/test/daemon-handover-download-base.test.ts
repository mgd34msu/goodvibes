import { expect, test } from 'bun:test';
import { DAEMON_REPO_RELEASES_LATEST_URL, daemonReleaseDownloadBaseUrl } from '../platform/src/platform/runtime/client/daemon-handover.ts';

test('the download root follows the feed the tag was resolved from', () => {
  expect(daemonReleaseDownloadBaseUrl('v2.0.23', 'https://example.test/owner/repo/releases/latest'))
    .toBe('https://example.test/owner/repo/releases/download/v2.0.23');
  expect(daemonReleaseDownloadBaseUrl('v2.0.23'))
    .toBe(`${DAEMON_REPO_RELEASES_LATEST_URL.replace(/\/latest$/, '')}/download/v2.0.23`);
});
