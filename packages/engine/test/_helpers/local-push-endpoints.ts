/**
 * Lets a test file register push subscriptions whose endpoint is a local HTTP
 * sink. The daemon refuses non-public push endpoints unless the deployment says
 * otherwise (`GOODVIBES_PUSH_ALLOW_LOCAL_ENDPOINTS`); a test that stands up its
 * own sink is exactly that deployment. Call once at the top level of the file.
 */
import { afterAll, beforeAll } from 'bun:test';
import { PUSH_ALLOW_LOCAL_ENDPOINTS_ENV } from '../../platform/src/platform/push/subscription-validation.ts';

export function allowLocalPushEndpoints(): void {
  let previous: string | undefined;
  beforeAll(() => {
    previous = process.env[PUSH_ALLOW_LOCAL_ENDPOINTS_ENV];
    process.env[PUSH_ALLOW_LOCAL_ENDPOINTS_ENV] = '1';
  });
  afterAll(() => {
    if (previous === undefined) delete process.env[PUSH_ALLOW_LOCAL_ENDPOINTS_ENV];
    else process.env[PUSH_ALLOW_LOCAL_ENDPOINTS_ENV] = previous;
  });
}
