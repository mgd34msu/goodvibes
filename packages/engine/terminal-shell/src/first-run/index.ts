export { readFirstRunOffers, FIRST_SCREEN_PROVIDERS, LOCAL_OFFER_NAME, type FirstRunOffers, type ProviderOffer, type OfferRoute, type ProviderFact, type ProviderRegistryView, type DiscoveryView, type EnvView } from './offers.js';
export { starterPrompts, starterPromptsFor, readFolderFacts, type FolderFacts } from './starter-prompts.js';
export { FirstRunModal, startFirstRun, sessionModelReady, gatherProviderFacts, type FirstRunDeps } from './first-run-flow.js';
export { installSplashAdditions, setFirstRunScreen, firstRunOwnsScreen, readSplashAdditions, takeNextStarterPrompt, starterPromptAtRow, fillComposerWithStarterPrompt, type FirstRunScreen, type SplashAdditionsView } from './splash-state.js';
export { drawSplashAdditions } from '../renderer/splash-additions.js';
