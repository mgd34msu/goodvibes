import { BatteryRegistry } from '@goodvibes/judgment';
import { consoleStatus } from './console-reading.js';
export const registry = new BatteryRegistry();
registry.register(consoleStatus);

import { googleGrantFailure } from './failure-readings.js';
registry.register(googleGrantFailure);

import { verificationArtifact } from './verification-reading.js';
registry.register(verificationArtifact);

// Enabling a Google API on the person's Cloud project so their request can run (decided in their place under Jev decides and Just vibes).
import { enableGoogleApis } from './connection-repair.js';
registry.register(enableGoogleApis);
