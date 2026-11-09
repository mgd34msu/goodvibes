import { requireDecisionFeature } from '../runtime/decision-policy.js';

/** Semantic assessments never become native facts merely because the model is disabled. */
export function requireSemanticKnowledge(): void {
  requireDecisionFeature('semantic knowledge assessment or synthesis; use native source inspection, local search and explicit owner review in Classic');
}
