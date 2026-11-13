import { appendFileSync } from 'node:fs';
import { installTestNetworkGuard } from './test-network-guard.js';

// The runner checks this file after the run, so a blocked request fails the run
// even when production code caught the error.
const path = process.env.GOODVIBES_TEST_NETWORK_VIOLATIONS;
installTestNetworkGuard((diagnostic) => {
  if (path !== undefined) appendFileSync(path, `${diagnostic}\n`, 'utf8');
});
