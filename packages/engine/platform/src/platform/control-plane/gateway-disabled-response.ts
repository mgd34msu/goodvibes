/**
 * gateway-disabled-response.ts
 *
 * The actionable body returned by the control-plane gateway's streaming/live entry points
 * (createEventStream, renderWebUi) when the gateway is explicitly turned off. The setting
 * defaults ON (a stock daemon streams), so this only reaches an operator who deliberately
 * disabled it, hence the response NAMES the setting and tells them how to restore streaming
 * instead of being a bare 503 dead end.
 *
 * The gate id is the one CONTROL_PLANE_FEATURE_FLAG, and the setting key is read from the
 * feature-settings table that maps every gate to its key, so a rename happens in one place.
 */
import { CONTROL_PLANE_FEATURE_FLAG } from '../runtime/surface-feature-flags.js';
import { getFeatureSettingsBinding } from '../runtime/feature-flags/feature-settings.js';

/** The settings key that turns the control-plane gateway on and off. */
export function controlPlaneGatewaySetting(): string {
  const binding = getFeatureSettingsBinding(CONTROL_PLANE_FEATURE_FLAG);
  if (!binding) throw new Error(`The feature gate ${CONTROL_PLANE_FEATURE_FLAG} has no settings key.`);
  return binding.key;
}

export interface GatewayDisabledResponseBody {
  readonly error: string;
  /** The settings key an operator flips to restore streaming. */
  readonly setting: string;
  readonly hint: string;
}

export function buildGatewayDisabledResponseBody(): GatewayDisabledResponseBody {
  const setting = controlPlaneGatewaySetting();
  return {
    error: `the control-plane gateway is turned off (${setting})`,
    setting,
    hint:
      'Live streaming, event broadcast, and the web UI are turned off for this daemon because '
      + `the ${setting} setting was disabled in config. `
      + `Set ${setting} back to true (its default) to restore `
      + 'SSE/WebSocket streaming. Request/response method calls remain available regardless '
      + 'of this setting.',
  };
}
