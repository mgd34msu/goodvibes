export type {
  QrMatrix,
} from './qr-generator.js';
export {
  generateQrMatrix,
  renderQrToString,
} from './qr-generator.js';

export type {
  CompanionPairingResult,
  CompanionConnectionInfo,
  CompanionTokenOptions,
  CompanionTokenQuarantine,
  CompanionTokenRecord,
  HttpListenerTokenResult,
} from './companion-token.js';
export {
  getOrCreateCompanionToken,
  getOrCreateHttpListenerToken,
  httpListenerTokenPath,
  readHttpListenerTokenValue,
  regenerateCompanionToken,
  pruneStaleOperatorTokens,
} from './companion-token.js';
export type { PruneStaleOperatorTokensOptions, PruneStaleOperatorTokensResult } from './companion-token.js';

export { PairingLimitReachedError, PairingTokenManager, readLegacySharedRevoked } from './pairing-token-store.js';
export { LOCAL_OWNER_PRINCIPAL, pairingPrincipalId, pairingTokenIdOfPrincipal } from './principal-ids.js';
export type {
  PublicPairingToken,
  PairingTokenOrigin,
  MintedPairingToken,
  AuthenticatedPairingToken,
  PairingTokenManagerOptions,
} from './pairing-token-store.js';

export {
  buildPairingHandoffLink,
  buildPairingHandoffFragment,
  parsePairingHandoffLink,
  normalizeOffers,
  PAIRING_HANDOFF_OFFER_KINDS,
  PAIRING_FRAGMENT_KEY,
  PAIRING_OFFERS_FRAGMENT_KEY,
} from './pairing-handoff.js';
export type {
  PairingHandoffOfferKind,
  BuildPairingHandoffLinkInput,
  ParsedPairingHandoff,
} from './pairing-handoff.js';

export {
  describeOriginPosture,
  describePairingReach,
  isLoopbackHost,
  BROWSER_GATED_CAPABILITIES,
  LAN_PLAIN_HTTP_NOTICE,
  PAIRING_REACH_FIX,
  TAILNET_PLAIN_HTTP_NOTICE,
} from './origin-posture.js';
export type {
  OriginPosture,
  OriginCapability,
  BrowserGatedCapability,
  PairingReach,
  PairingReachAnswer,
} from './origin-posture.js';

export {
  firstNonInternalIpv4,
  interfaceIpv4,
  isWildcardBindHost,
  mdnsLocalName,
  parseDefaultRouteInterface,
  parseTailscaleStatus,
  probeStableHostInputs,
  refreshStableHostInputs,
  resolvesToThisHost,
  resolveStableHost,
  stableUrlHostForBindHost,
} from './stable-host.js';
export type {
  ResolvedStableHost,
  StableHostInputs,
  StableHostKind,
  TailscaleState,
} from './stable-host.js';

export {
  availablePairingOffers,
  defaultPairingTokenName,
  mintPairingHandoff,
  pairingQrContent,
} from './handoff-mint.js';
export type {
  MintPairingHandoffInput,
  PairingHandoff,
  PairingOfferAvailability,
  PairingTokenMinter,
} from './handoff-mint.js';

export {
  formatCreated,
  formatDeviceLine,
  deviceOriginLabel,
  formatLastSeen,
  resolveTokenByIdPrefix,
  shortTokenId,
} from './device-lines.js';

export {
  formatPairingOffers,
  formatPairingSteps,
  formatPostureCapabilities,
  PAIRING_OFFER_COPY,
  PAIRING_PAIR_AGAIN,
  pairingNoWebUiLines,
  pairingPostureNotice,
  pairingReadySteps,
  pairingThisMachineLines,
  pairingUnreachableLines,
  pairingUnreachableSteps,
  POSTURE_CAPABILITY_LABEL,
  SERVE_TO_NETWORK_QUESTION,
} from './offer-copy.js';
export type { PairingOfferCopy, PairingStep } from './offer-copy.js';

export { controlPlaneOriginUsesStableHost, controlPlaneScheme, explicitPublicBaseUrl, formatHttpOrigin, isHttpOnLan, lanHttpsOriginOf, lanHttpsPort, pairingOriginUsesStableHost, pairingReachFromSettings, publicBaseUrlIsOwnOrigin, resolveControlPlaneOrigin, resolvePairingWebOrigin, resolveWebUiListener, resolveWebUiOrigin } from './web-origin.js';
export type { ControlPlaneOrigin, PairingWebOrigin } from './web-origin.js';
