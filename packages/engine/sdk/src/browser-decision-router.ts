/** Runtime-neutral Decision Router configuration shared by product settings surfaces. */
export { DEFAULT_DECISION_ROUTER_SETTINGS, captureDecisionRouterSettings } from './platform/config/decision-router-settings.js';
export type { DecisionRouterSettings, DecisionRouterCategory, DecisionRouterTarget } from './platform/config/decision-router-settings.js';
export { captureJudgmentFallbackSettings } from './platform/config/judgment-fallback-settings.js';
export type { JudgmentFallbackSettings } from './platform/config/schema-types-judgment.js';
