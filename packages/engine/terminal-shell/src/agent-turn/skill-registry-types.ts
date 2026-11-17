export type AgentSkillSource = 'user' | 'agent' | 'imported' | 'system';
export type AgentSkillReviewState = 'fresh' | 'reviewed' | 'stale';
export type AgentSkillRequirementKind = 'env' | 'command';

export interface AgentSkillRequirement {
  readonly kind: AgentSkillRequirementKind;
  readonly name: string;
  readonly description?: string | undefined;
}

export interface AgentSkillReadiness {
  readonly ready: boolean;
  readonly met: readonly AgentSkillRequirement[];
  readonly missing: readonly AgentSkillRequirement[];
}

export interface AgentSkillBundleReadiness {
  readonly ready: boolean;
  readonly includedSkills: readonly AgentSkillRecord[];
  readonly missingSkillIds: readonly string[];
  readonly missingRequirements: readonly AgentSkillRequirement[];
}

export interface AgentSkillRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly procedure: string;
  readonly triggers: readonly string[];
  readonly tags: readonly string[];
  readonly requirements: readonly AgentSkillRequirement[];
  readonly enabled: boolean;
  readonly source: AgentSkillSource;
  readonly provenance: string;
  readonly reviewState: AgentSkillReviewState;
  readonly staleReason?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reviewedAt?: string | undefined;
}

export interface AgentSkillBundleRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly skillIds: readonly string[];
  readonly enabled: boolean;
  readonly source: AgentSkillSource;
  readonly provenance: string;
  readonly reviewState: AgentSkillReviewState;
  readonly staleReason?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reviewedAt?: string | undefined;
}

export interface AgentSkillCreateInput {
  readonly name: string;
  readonly description: string;
  readonly procedure: string;
  readonly triggers?: readonly string[] | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly requirements?: readonly AgentSkillRequirement[] | undefined;
  readonly enabled?: boolean | undefined;
  readonly source?: AgentSkillSource | undefined;
  readonly provenance?: string | undefined;
}

export interface AgentSkillBundleCreateInput {
  readonly name: string;
  readonly description: string;
  readonly skillIds: readonly string[];
  readonly enabled?: boolean | undefined;
  readonly source?: AgentSkillSource | undefined;
  readonly provenance?: string | undefined;
}

export interface AgentSkillUpdateInput {
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly procedure?: string | undefined;
  readonly triggers?: readonly string[] | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly requirements?: readonly AgentSkillRequirement[] | undefined;
  /** Applied in the same write as the field edit. */
  readonly enabled?: boolean | undefined;
  readonly provenance?: string | undefined;
}

export interface AgentSkillBundleUpdateInput {
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly skillIds?: readonly string[] | undefined;
  /** Applied in the same write as the field edit. */
  readonly enabled?: boolean | undefined;
  readonly provenance?: string | undefined;
}

export interface AgentSkillSnapshot {
  readonly path: string;
  readonly skills: readonly AgentSkillRecord[];
  readonly enabledSkills: readonly AgentSkillRecord[];
  readonly bundles: readonly AgentSkillBundleRecord[];
  readonly enabledBundles: readonly AgentSkillBundleRecord[];
  readonly activeSkills: readonly AgentSkillRecord[];
}
