import { BatteryRegistry } from '@goodvibes/judgment/decisions';
import { failureReading } from './failure-reading.js';

/** Every named decision the errors package defines, for calibration (`bun run calibrate --registry`). */
export const registry = new BatteryRegistry();
registry.register(failureReading);
