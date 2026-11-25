/**
 * skills/library-types.ts, the facts GoodVibes keeps about a skill beside its
 * text (switched on or off, reviewed, what it needs, where it came from) and
 * about a skill bundle. One shape for every program: the skill files are the
 * daemon's skill store (roots.ts), and these facts are written into each
 * file's frontmatter (library.ts).
 */

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
  /** The skill's name in the store (its file name): what every program and the daemon's skills.* methods address it by. */
  readonly id: string;
  /** The name a person gave it ("release notes"). */
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
  /** The skill's file, where it was found, and whether it carries GoodVibes' facts yet (a file dropped in by hand does not). */
  readonly path?: string | undefined;
  readonly origin?: 'project-local' | 'global' | 'custom' | undefined;
  readonly marked?: boolean | undefined;
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

/** What deleting a skill changed: the skill, the bundles left empty and removed, and the bundles now pending review. */
export interface AgentSkillDeleteResult {
  readonly skill: AgentSkillRecord;
  readonly removedBundles: readonly AgentSkillBundleRecord[];
  readonly changedBundles: readonly AgentSkillBundleRecord[];
}

export interface AgentSkillSnapshot {
  /** The library file (bundles and the store's revision); every change to the store rewrites it. */
  readonly path: string;
  readonly skills: readonly AgentSkillRecord[];
  readonly enabledSkills: readonly AgentSkillRecord[];
  readonly bundles: readonly AgentSkillBundleRecord[];
  readonly enabledBundles: readonly AgentSkillBundleRecord[];
  /** Enabled bundles a turn applies: reviewed, setup-ready, every member reviewed. */
  readonly activeBundles: readonly AgentSkillBundleRecord[];
  /** Skills a turn applies: enabled or in an active bundle, and reviewed and setup-ready. */
  readonly activeSkills: readonly AgentSkillRecord[];
}
