import { BatteryRegistry } from '@goodvibes/judgment';

/**
 * Every named decision the state and runtime layers make, for calibration:
 *
 *   bun run --cwd packages/judgment calibrate --registry ../engine/platform/src/platform/runtime/judgment-registry.ts
 */
export const registry = new BatteryRegistry();

// State: memory and knowledge.
import { knowledgeRelevance } from '../state/batteries/knowledge-relevance.js';
import { memoryAgreement, memoryAlignment } from '../state/batteries/memory-alignment.js';
import { memoryReviewPriority } from '../state/batteries/memory-review-priority.js';
import { knowledgeInjectionRerank, memorySearchRerank } from '../state/batteries/memory-search-rerank.js';
import { memoryUsage } from '../state/batteries/memory-usage.js';
registry.register(knowledgeRelevance);
registry.register(memoryAlignment);
registry.register(memoryAgreement);
registry.register(memoryReviewPriority);
registry.register(memorySearchRerank);
registry.register(knowledgeInjectionRerank);
registry.register(memoryUsage);

// Runtime: compaction, forensics, tool contracts.
// (The forensics classifier reads error messages through engine.failure-reading,
// registered in packages/engine/errors/src/judgment-registry.ts.)
import { compactionFidelity } from './compaction/batteries/compaction-fidelity.js';
import { compactionRetention } from './compaction/batteries/compaction-retention.js';
import { recommendationFit } from './ecosystem/batteries/recommendation-fit.js';
import { descriptionQuality } from './tools/batteries/description-quality.js';
registry.register(compactionFidelity);
registry.register(compactionRetention);
registry.register(recommendationFit);
registry.register(descriptionQuality);

// Runtime: session return.
import { pendingApproval } from './batteries/pending-approval.js';
registry.register(pendingApproval);

// Runtime: the one request that checks a decision model answers (first run, Settings).
import { decisionModelReadinessCheck } from './batteries/decision-model-readiness.js';
registry.register(decisionModelReadinessCheck);

// State: code index.
import { codeSearchRerank } from '../state/batteries/code-search-rerank.js';
registry.register(codeSearchRerank);

// Runtime: ecosystem catalog search and review.
import { catalogSearch } from './ecosystem/batteries/catalog-search.js';
import { trustNoteCaution } from './ecosystem/batteries/trust-note-caution.js';
registry.register(catalogSearch);
registry.register(trustNoteCaution);

// Utils: error display.
import { displayPayload } from '../utils/batteries/display-payload.js';
registry.register(displayPayload);

// Types: the wait a provider error's message states before retrying.
import { retryWait } from '../types/batteries/retry-wait.js';
registry.register(retryWait);

// Runtime: model picker.

// Runtime: tool output policy.


// Runtime: forensics.

// Runtime: observed fleet agents.

// Structured compaction source membership.
import { conversationSubstance, toolResultRelevance, resolvedProblemEvidence, compactionEvidenceDependency } from './compaction/batteries/section-selection.js';
registry.register(conversationSubstance);
registry.register(toolResultRelevance);
registry.register(resolvedProblemEvidence);
registry.register(compactionEvidenceDependency);

// Email: semantic refusals and mailbox purpose; RFC grammar stays deterministic.
import { imapRefusalReading, imapDraftsReading } from '../email/imap-readings.js';
registry.register(imapRefusalReading);
registry.register(imapDraftsReading);

// Email writing style; complete protected corpus and actual sender evidence.
import { emailStyleProfileReading, emailStyleSenderReading } from '../email/style-reply-readings.js';
registry.register(emailStyleProfileReading);
registry.register(emailStyleSenderReading);

// Browser host provisioning diagnoses, shared by runtime and driver installs.
import { browserProvisionFailure } from '../browser/browser-failure-reading.js';
registry.register(browserProvisionFailure);
import { browserControlIdentity, browserCredentialPage } from '../browser/browser-control-identity.js';
registry.register(browserControlIdentity);
registry.register(browserCredentialPage);
// Google setup control purposes and authentication page state.
import { googleSetupControl, googleSignInPage, googleTwoStepPage, googleAppPasswordPage } from '../google/browser-readings.js';
registry.register(googleSetupControl);
registry.register(googleSignInPage);
registry.register(googleTwoStepPage);
registry.register(googleAppPasswordPage);

// Occasion meaning; closed dates and delivery authority remain mechanical.
import { occasionInterest, occasionSubject } from '../occasions/readings.js';
registry.register(occasionInterest);
registry.register(occasionSubject);
// Owner profile: named People prose, never read/disclosure authority.
import { profilePersonLine } from '../owner-profile/person-reading.js';
registry.register(profilePersonLine);

// Native archetype purpose and complete owner planning text.
import { archetypeFamily } from '../agents/batteries/archetype-family.js';
import { planningGoal } from '../agents/batteries/planning-goal.js';
registry.register(archetypeFamily);
registry.register(planningGoal);

import { browserLaunchCause } from '../browser/launch-reading.js';
registry.register(browserLaunchCause);
