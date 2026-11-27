import { BatteryRegistry } from '@goodvibes/judgment';
import { automaticProjectName } from './batteries/automatic-project-name.js';

/** Every named decision about projects themselves, for calibration (`bun run calibrate --registry`). */
export const registry = new BatteryRegistry();

// The folder name of a chat's automatic project (workspace/automatic-projects.ts).
registry.register(automaticProjectName);
