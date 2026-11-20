import { BatteryRegistry } from '@goodvibes/judgment';
import { repairSubjectSelection } from './battery.js';
export const registry = new BatteryRegistry();
registry.register(repairSubjectSelection);
