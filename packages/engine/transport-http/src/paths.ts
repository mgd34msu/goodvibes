import { ConfigurationError } from '@goodvibes/engine/errors';
import { isPrivateNetworkHost } from './private-network.js';

export interface TransportPaths {
  readonly baseUrl: string;
  readonly statusUrl: string;
  readonly controlPlaneUrl: string;
  readonly controlPlaneAuthUrl: string;
  readonly controlPlaneEventsUrl: string;
  readonly controlPlaneMethodsUrl: string;
  readonly sessionsUrl: string;
  readonly tasksUrl: string;
  readonly approvalsUrl: string;
  readonly providersUrl: string;
  readonly accountsUrl: string;
  readonly localAuthUrl: string;
  readonly telemetryUrl: string;
  readonly telemetryEventsUrl: string;
  readonly telemetryErrorsUrl: string;
  readonly telemetryTracesUrl: string;
  readonly telemetryMetricsUrl: string;
  readonly telemetryStreamUrl: string;
  readonly telemetryOtlpTracesUrl: string;
  readonly telemetryOtlpLogsUrl: string;
  readonly telemetryOtlpMetricsUrl: string;
  readonly remoteUrl: string;
  readonly remoteContractUrl: string;
  readonly peerRequestsUrl: string;
  readonly peerListUrl: string;
  readonly remoteWorkUrl: string;
  /**
   * Alias for `controlPlaneUrl`. Provided for convenience.
   */
  readonly controlUrl: string;
}

// Plain-http origins on a private network are a supported posture (a phone on
// the same LAN or tailnet talking to the daemon), not a mistake to wall off:
// the daemon never mints certificates, so the transport works over http there,
// in a browser bundle too, where no process.env escape hatch exists.
// Genuinely public http origins keep the insecure-transport wall.
export { isLoopbackHost, isPrivateNetworkHost, isTailnetHost, stateTailnetAddresses } from './private-network.js';
export { exemptLoopbackFromProxy } from './loopback-proxy.js';

export function normalizeBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim();
  if (!normalized) {
    throw new ConfigurationError('Transport baseUrl is required. Pass a non-empty baseUrl string to your transport or platform options.', { code: 'ENGINE_TRANSPORT_BASE_URL_REQUIRED' });
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch (cause) {
    throw new ConfigurationError('Transport baseUrl must be an absolute URL.', {
      code: 'ENGINE_TRANSPORT_BASE_URL_INVALID',
      source: 'transport',
      hint: 'Pass a full URL such as https://goodvibes.example.com.',
      cause,
    });
  }
  const protocol = parsed.protocol;
  if (protocol !== 'https:' && protocol !== 'wss:' && protocol !== 'http:' && protocol !== 'ws:') {
    throw new ConfigurationError(`Unsupported transport baseUrl protocol: ${protocol}`, {
      code: 'ENGINE_TRANSPORT_BASE_URL_PROTOCOL_UNSUPPORTED',
      source: 'transport',
      hint: 'Use https:// or wss://. http:// and ws:// are supported on private-network origins (localhost, private LAN and link-local addresses, .local names, Tailscale names and stated Tailscale addresses) and for explicit public-http deployments.',
    });
  }
  // Only a genuinely public http origin keeps the wall; the server-side env
  // override remains for an intentional public-http deployment. A secure
  // origin never asks the private-network question (nor starts its Tailscale probe).
  const plain = protocol === 'http:' || protocol === 'ws:';
  if (plain && !allowsInsecureTransport() && !isPrivateNetworkHost(parsed.hostname)) {
    throw new ConfigurationError('Refusing insecure PUBLIC GoodVibes transport baseUrl.', {
      code: 'ENGINE_TRANSPORT_INSECURE_BASE_URL',
      source: 'transport',
      hint: 'Use https:// or wss:// for public origins. Plain http is supported on private-network origins (localhost; 10/8, 172.16/12, 192.168/16 and link-local addresses; .local names; Tailscale *.ts.net names). A 100.64/10 address is also used by carrier-grade NAT, so it is accepted over http only as a Tailscale address (one a running Tailscale on this machine lists): use the machine\'s Tailscale name (<machine>.<tailnet>.ts.net), or list the address in GOODVIBES_TAILNET_ADDRESSES (or set it to 100.64.0.0/10 when no carrier-grade NAT is in the path). For an intentional public-http deployment set GOODVIBES_ALLOW_INSECURE_TRANSPORT=true (server-side only).',
    });
  }
  return normalized.replace(/\/+$/, '');
}

// Same switch grammar as the platform envFlag (1/true on, anything else off); kept inline because this package imports no platform code.
function allowsInsecureTransport(): boolean {
  const runtimeProcess = (globalThis as { readonly process?: { readonly env?: Record<string, string | undefined> } }).process;
  const insecureSwitch = runtimeProcess?.env?.GOODVIBES_ALLOW_INSECURE_TRANSPORT?.trim().toLowerCase();
  return insecureSwitch === '1' || insecureSwitch === 'true';
}

export function buildUrl(baseUrl: string, path: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (/^[a-z][a-z0-9+\-.]*:/i.test(path)) {
    throw new ConfigurationError(`Absolute path not allowed: ${path}`, { code: 'ENGINE_TRANSPORT_PATH_ABSOLUTE' });
  }
  let resolved: string;
  try {
    // Join onto the base path rather than resolving against the origin, so a daemon
    // served under a prefix (https://host/goodvibes) keeps it. Leading slashes are
    // dropped so '/api/x' and '//other-host/x' both stay inside the base.
    resolved = new URL(path.replace(/^\/+/, ''), `${normalized}/`).toString();
  } catch (cause) {
    throw new ConfigurationError(`Invalid transport path: ${path}`, { code: 'ENGINE_TRANSPORT_PATH_INVALID', cause });
  }
  return assertSameOriginAbsoluteUrl(resolved, normalized);
}

/**
 * Assert that an absolute URL has the same origin as a reference URL (or baseUrl).
 *
 * Used by transport call sites that allow absolute URLs as a convenience but
 * MUST NOT leak the bearer Authorization header to a different origin. Throws
 * `ConfigurationError ENGINE_TRANSPORT_CROSS_ORIGIN` when origins diverge.
 *
 * Returns the validated absolute URL unchanged on success.
 */
export function assertSameOriginAbsoluteUrl(absoluteUrl: string, originReferenceUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(absoluteUrl);
  } catch (cause) {
    throw new ConfigurationError(`Invalid absolute transport URL: ${absoluteUrl}`, {
      code: 'ENGINE_TRANSPORT_URL_INVALID',
      source: 'transport',
      cause,
    });
  }
  let referenceOrigin: string;
  try {
    referenceOrigin = new URL(originReferenceUrl).origin;
  } catch (cause) {
    throw new ConfigurationError(`Invalid transport origin reference URL: ${originReferenceUrl}`, {
      code: 'ENGINE_TRANSPORT_URL_INVALID',
      source: 'transport',
      cause,
    });
  }
  if (parsed.origin !== referenceOrigin) {
    throw new ConfigurationError(`Cross-origin transport request rejected: ${parsed.origin} does not match transport baseUrl origin ${referenceOrigin}`, {
      code: 'ENGINE_TRANSPORT_CROSS_ORIGIN',
      source: 'transport',
      hint: 'The transport bearer token would be sent to a different origin. Use a same-origin URL or open a separate transport for the cross-origin endpoint.',
    });
  }
  return absoluteUrl;
}

export function createTransportPaths(baseUrl: string): TransportPaths {
  const normalized = normalizeBaseUrl(baseUrl);
  return {
    baseUrl: normalized,
    statusUrl: buildUrl(normalized, '/status'),
    controlPlaneUrl: buildUrl(normalized, '/api/control-plane'),
    controlPlaneAuthUrl: buildUrl(normalized, '/api/control-plane/auth'),
    controlPlaneEventsUrl: buildUrl(normalized, '/api/control-plane/events'),
    controlPlaneMethodsUrl: buildUrl(normalized, '/api/control-plane/methods'),
    sessionsUrl: buildUrl(normalized, '/api/sessions'),
    tasksUrl: buildUrl(normalized, '/api/tasks'),
    approvalsUrl: buildUrl(normalized, '/api/approvals'),
    providersUrl: buildUrl(normalized, '/api/providers'),
    accountsUrl: buildUrl(normalized, '/api/accounts'),
    localAuthUrl: buildUrl(normalized, '/api/local-auth'),
    telemetryUrl: buildUrl(normalized, '/api/v1/telemetry'),
    telemetryEventsUrl: buildUrl(normalized, '/api/v1/telemetry/events'),
    telemetryErrorsUrl: buildUrl(normalized, '/api/v1/telemetry/errors'),
    telemetryTracesUrl: buildUrl(normalized, '/api/v1/telemetry/traces'),
    telemetryMetricsUrl: buildUrl(normalized, '/api/v1/telemetry/metrics'),
    telemetryStreamUrl: buildUrl(normalized, '/api/v1/telemetry/stream'),
    telemetryOtlpTracesUrl: buildUrl(normalized, '/api/v1/telemetry/otlp/v1/traces'),
    telemetryOtlpLogsUrl: buildUrl(normalized, '/api/v1/telemetry/otlp/v1/logs'),
    telemetryOtlpMetricsUrl: buildUrl(normalized, '/api/v1/telemetry/otlp/v1/metrics'),
    remoteUrl: buildUrl(normalized, '/api/remote'),
    remoteContractUrl: buildUrl(normalized, '/api/remote/node-host/contract'),
    peerRequestsUrl: buildUrl(normalized, '/api/remote/pair/requests'),
    peerListUrl: buildUrl(normalized, '/api/remote/peers'),
    remoteWorkUrl: buildUrl(normalized, '/api/remote/work'),
    controlUrl: buildUrl(normalized, '/api/control-plane'),
  };
}
