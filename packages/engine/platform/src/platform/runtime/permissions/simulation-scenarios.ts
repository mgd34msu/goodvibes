/**
 * The summary a `/policy simulate` review records for the policy panel: how many
 * recorded calls were decided again and how many the candidate decides differently.
 */
import type { DivergenceType, PermissionDecision, SimulationMode } from './types.js';

export interface PolicySimulationScenario {
  id: string;
  label: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface PolicySimulationScenarioResult {
  scenario: PolicySimulationScenario;
  actualDecision: PermissionDecision;
  simulatedDecision: PermissionDecision;
  authoritativeDecision: PermissionDecision;
  diverged: boolean;
  divergenceType?: DivergenceType | undefined;
}

export interface PolicySimulationSummary {
  simulatedAt: string;
  mode: SimulationMode;
  totalScenarios: number;
  divergentScenarios: number;
  allowedByActual: number;
  allowedBySimulated: number;
  results: PolicySimulationScenarioResult[];
}
