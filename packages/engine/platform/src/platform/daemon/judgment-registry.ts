import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { channelApprovalTarget } from './batteries/approval-reply.js';
import { surfaceControl } from './batteries/surface-control.js';
import { inboundMessage } from './batteries/inbound-message.js';

/** Independent named batteries for inbound channel messages, approval targets and surface control. */
export const registry = new BatteryRegistry();
registry.register(inboundMessage);
registry.register(channelApprovalTarget);

registry.register(surfaceControl);
