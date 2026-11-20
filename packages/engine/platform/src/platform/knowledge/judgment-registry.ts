import { BatteryRegistry } from '@goodvibes/judgment';
import { consolidationReading } from './batteries/consolidation.js';
export const registry = new BatteryRegistry();
registry.register(consolidationReading);

import { repairFailureCause } from './semantic/self-improvement-failure-battery.js';
registry.register(repairFailureCause);

import { knowledgeScopeSelection } from './batteries/scope-selection.js';
registry.register(knowledgeScopeSelection);

import { selfImprovementGapContext, selfImprovementEvidenceCoverage } from './semantic/self-improvement-assessment/battery.js';
registry.register(selfImprovementGapContext);
registry.register(selfImprovementEvidenceCoverage);

import { extractedSentenceKind, repairSourceRelevance } from './semantic/repair-decisions.js';
registry.register(extractedSentenceKind);
registry.register(repairSourceRelevance);
