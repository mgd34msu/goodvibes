import { buildGoodVibesCloudflareWorkerModule } from '../../workers.js';

/**
 * The Worker module provisioning uploads. It is built from the one Worker
 * implementation (`createGoodVibesCloudflareWorker` in `workers.ts`), so a
 * provisioned Worker and a hand-deployed one behave the same.
 */
export const GOODVIBES_CLOUDFLARE_WORKER_MODULE = buildGoodVibesCloudflareWorkerModule();
