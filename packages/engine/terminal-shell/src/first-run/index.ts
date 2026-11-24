export { choosableProviderIds, INTERNAL_PROVIDER_IDS, readFirstRunOffers, FIRST_SCREEN_PROVIDERS, LOCAL_OFFER_NAME, type FirstRunOffers, type ProviderOffer, type OfferRoute, type ProviderFact, type ProviderRegistryView, type DiscoveryView, type EnvView } from './offers.js';
export { FirstRunModal, startFirstRun, openWhoDecides, openModeSegment, sessionModelReady, gatherProviderFacts, firstRunDecisionModel, type FirstRunDeps, type FirstRunDecisionModel } from './first-run-flow.js';
export { installSplashAdditions, setFirstRunScreen, setSplashImportCommand, firstRunOwnsScreen, readSplashAdditions, type FirstRunScreen, type SplashAdditionsView } from './splash-state.js';
export { drawSplashAdditions } from '../renderer/splash-additions.js';
