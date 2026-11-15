import { BatteryRegistry } from '@goodvibes-jev/judgment';

/**
 * Every named decision the config layer makes, for calibration:
 *
 *   bun run --cwd packages/judgment calibrate --registry ../engine/platform/src/platform/config/judgment-registry.ts
 */
export const registry = new BatteryRegistry();

// Whether an undeclared config key holds a credential.
import { credentialKey } from './batteries/credential-key.js';
registry.register(credentialKey);
