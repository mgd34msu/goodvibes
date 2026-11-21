/** Runtime-neutral device capability contract: the ids, titles and secure-context rule every device node and surface reads. */
export {
  DEVICE_CAPABILITY_CATALOG,
  DEVICE_CAPABILITY_CONTRACT_VERSION,
  DEVICE_CAPABILITY_IDS,
  getDeviceCapability,
  isDeviceCapabilityId,
  type DeviceCapabilityDescriptor,
  type DeviceCapabilityFamily,
  type DeviceCapabilityId,
} from './platform/devices/device-capability-contract.js';
