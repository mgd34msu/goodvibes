import { BatteryRegistry } from '@goodvibes-jev/judgment/decisions';
import { smokeLoadFailure } from './batteries/smoke-load-failure.js';
import { nativeAddonFailure } from './batteries/native-addon-failure.js';

export const registry = new BatteryRegistry();
registry.register(smokeLoadFailure);
registry.register(nativeAddonFailure);
