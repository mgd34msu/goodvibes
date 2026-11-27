/**
 * The Agent's view of the one skill store (platform skills/library.ts): the
 * daemon's skill files, with GoodVibes' facts about each skill in its
 * frontmatter and the skill bundles beside them. The store, its rules and the
 * one-time carry of the Agent's 3.5.0 `skills.json` are the platform's; this
 * file names it for the Agent's turns and builds the prompt section from it.
 */
import { dirname } from 'node:path';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import { noteOthersWritingRead } from '@goodvibes/engine/platform/platform/state';
import {
  SkillLibrary,
  evaluateAgentSkillBundleReadiness,
  evaluateAgentSkillReadiness,
  formatAgentSkillRequirement,
  resolveSkillRoots,
  skillLibraryPath,
  type AgentSkillBundleRecord,
  type AgentSkillDeleteResult,
  type AgentSkillRecord,
  type AgentSkillSnapshot,
  type SkillLibraryWriteEffects,
} from '@goodvibes/engine/platform/platform/skills';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import { GOODVIBES_AGENT_SURFACE_ROOT } from './surface.js';
import { formatAgentRecordReviewState } from './record-labels.js';

export type {
  AgentSkillDeleteResult,
  AgentSkillBundleCreateInput,
  AgentSkillBundleReadiness,
  AgentSkillBundleRecord,
  AgentSkillBundleUpdateInput,
  AgentSkillCreateInput,
  AgentSkillReadiness,
  AgentSkillRecord,
  AgentSkillRequirement,
  AgentSkillRequirementKind,
  AgentSkillReviewState,
  AgentSkillSnapshot,
  AgentSkillSource,
  AgentSkillUpdateInput,
} from './skill-registry-types.js';
export {
  buildAgentSkillRequirements,
  evaluateAgentSkillBundleReadiness,
  evaluateAgentSkillReadiness,
  formatAgentSkillRequirement,
  normalizeAgentSkillRequirements,
} from '@goodvibes/engine/platform/platform/skills';

type AgentLocalStorePaths = Pick<ShellPathService, 'resolveUserPath'> & Partial<Pick<ShellPathService, 'workingDirectory'>>;

/** The file every change to the skill store rewrites (bundles and the store's revision): what a tool call's checks watch. */
export function skillStorePath(shellPaths: Pick<ShellPathService, 'resolveUserPath'>): string {
  return skillLibraryPath(shellPaths.resolveUserPath());
}

/** The one skill store, as the Agent's turns read it: this project's skill folders and the home's. */
export class AgentSkillRegistry extends SkillLibrary {
  public static fromShellPaths(shellPaths: AgentLocalStorePaths, effects?: SkillLibraryWriteEffects): AgentSkillRegistry {
    const goodvibesRoot = shellPaths.resolveUserPath();
    const roots = resolveSkillRoots({ workingDirectory: shellPaths.workingDirectory, homeDirectory: dirname(goodvibesRoot) }, GOODVIBES_AGENT_SURFACE_ROOT);
    return new AgentSkillRegistry({ roots, goodvibesRoot, ...(effects ? { effects } : {}) });
  }

  /** The store of one home (an Agent profile's), with no project folder. */
  public static forHome(homeDirectory: string): AgentSkillRegistry {
    const goodvibesRoot = `${homeDirectory}/.goodvibes`;
    return new AgentSkillRegistry({ roots: resolveSkillRoots({ homeDirectory }, GOODVIBES_AGENT_SURFACE_ROOT), goodvibesRoot });
  }
}

/** The receipt lines that say which bundles a skill deletion removed or sent back to review; none when no bundle held it. */
export function formatSkillDeleteBundleLines(result: Pick<AgentSkillDeleteResult, 'removedBundles' | 'changedBundles'>): string[] {
  return [
    ...(result.removedBundles.length > 0 ? [`  removed bundles (no skill left): ${result.removedBundles.map((bundle) => bundle.id).join(', ')}`] : []),
    ...(result.changedBundles.length > 0 ? [`  bundles now pending review: ${result.changedBundles.map((bundle) => bundle.id).join(', ')}`] : []),
  ];
}

/**
 * The one-line section that stands in for the skills when the store cannot be
 * read. The turn goes ahead without skills, and the model and owner are told
 * which file to repair rather than every turn failing with no recovery step.
 */
export function skillStoreUnreadableNotice(storePath: string, error: unknown): string {
  return [
    '## Enabled GoodVibes Agent Skills',
    `No skills are applied this turn: the skill store at ${storePath} could not be read (${error instanceof Error ? error.message : String(error)}). Repair or remove that file, then open Skills in Tools and extensions (the menu) to confirm.`,
  ].join('\n');
}

/** How many reviewed, ready skills one prompt carries in full; the receipt counts against the same number. */
export const ENABLED_SKILLS_PROMPT_LIMIT = 8;
/** How many reviewed, ready skill bundles one prompt carries in full. */
export const ENABLED_SKILL_BUNDLES_PROMPT_LIMIT = 4;

/**
 * The line that tells the model which enabled skills the prompt left out, so it
 * can read one by name instead of not knowing it exists. Empty when none were cut.
 */
export function skillsBeyondPromptLimitLine(skills: readonly AgentSkillRecord[], bundles: readonly AgentSkillBundleRecord[]): string {
  const cut = skills.slice(ENABLED_SKILLS_PROMPT_LIMIT);
  const cutBundles = bundles.slice(ENABLED_SKILL_BUNDLES_PROMPT_LIMIT);
  if (cut.length === 0 && cutBundles.length === 0) return '';
  const names = [
    ...cutBundles.map((bundle) => `${bundle.name} (bundle ${bundle.id})`),
    ...cut.map((skill) => `${skill.name} (${skill.id})`),
  ];
  const shown = names.slice(0, 20).join(', ');
  const more = names.length > 20 ? `, and ${names.length - 20} more` : '';
  return `${names.length} more enabled skill${names.length === 1 ? '' : 's'} not shown here: ${shown}${more}. When one fits, read it with agent_local_registry domain:"skill" action:"get" id:<id> (domain:"skill_bundle" for a bundle).`;
}

export function buildEnabledSkillsPrompt(shellPaths: ShellPathService, preread?: AgentSkillSnapshot): string | null {
  const registry = AgentSkillRegistry.fromShellPaths(shellPaths);
  let snapshot: AgentSkillSnapshot;
  try {
    snapshot = preread ?? registry.snapshot();
  } catch (error) {
    logger.warn('Agent skill store could not be read; composing the system prompt without skills', {
      path: skillStorePath(shellPaths),
      error: summarizeError(error),
    });
    return skillStoreUnreadableNotice(skillStorePath(shellPaths), error);
  }
  const activeBundles = snapshot.activeBundles;
  const active = snapshot.activeSkills;
  const candidateSkillIds = new Set([
    ...snapshot.enabledSkills.map((skill) => skill.id),
    ...snapshot.enabledBundles.flatMap((bundle) => bundle.skillIds),
  ]);
  const suppressedSkills = snapshot.skills
    .filter((skill) => candidateSkillIds.has(skill.id) && !active.some((activeSkill) => activeSkill.id === skill.id))
    .slice(0, 8)
    .map((skill) => {
      const readiness = evaluateAgentSkillReadiness(skill);
      const review = skill.reviewState === 'reviewed' ? '' : `review=${formatAgentRecordReviewState(skill.reviewState)}`;
      const setup = readiness.ready ? '' : `missing=${readiness.missing.map(formatAgentSkillRequirement).join(', ')}`;
      return `- ${skill.name}: ${[review, setup].filter(Boolean).join('; ')}`;
    });
  const suppressedBundles = snapshot.enabledBundles
    .filter((bundle) => !activeBundles.some((activeBundle) => activeBundle.id === bundle.id))
    .slice(0, 4)
    .map((bundle) => {
      const readiness = evaluateAgentSkillBundleReadiness(bundle, snapshot.skills);
      const review = bundle.reviewState === 'reviewed' ? '' : `review=${formatAgentRecordReviewState(bundle.reviewState)}`;
      const setup = readiness.ready ? '' : `missing=${[
        ...readiness.missingRequirements.map(formatAgentSkillRequirement),
        ...readiness.missingSkillIds.map((skillId) => `skill:${skillId}`),
      ].join(', ')}`;
      const unreviewedSkills = readiness.includedSkills
        .filter((skill) => skill.reviewState !== 'reviewed')
        .map((skill) => `${skill.id}:${formatAgentRecordReviewState(skill.reviewState)}`);
      const memberReview = unreviewedSkills.length === 0 ? '' : `member-review=${unreviewedSkills.join(', ')}`;
      return `- ${bundle.name}: ${[review, setup, memberReview].filter(Boolean).join('; ')}`;
    });
  if (active.length === 0 && activeBundles.length === 0 && suppressedSkills.length === 0 && suppressedBundles.length === 0) return null;
  const beyondLimit = skillsBeyondPromptLimitLine(active, activeBundles);
  return [
    '## Enabled GoodVibes Agent Skills',
    'Use only reviewed, setup-ready local reusable procedures inside the same serial assistant conversation when they fit the user request.',
    '',
    ...activeBundles.slice(0, ENABLED_SKILL_BUNDLES_PROMPT_LIMIT).flatMap((bundle) => {
      const readiness = evaluateAgentSkillBundleReadiness(bundle, snapshot.skills);
      const missing = [
        ...readiness.missingRequirements.map(formatAgentSkillRequirement),
        ...readiness.missingSkillIds.map((skillId) => `skill:${skillId}`),
      ];
      return [
        `### Skill Bundle: ${bundle.name}`,
        `Description: ${bundle.description}`,
        `Review: ${formatAgentRecordReviewState(bundle.reviewState)}`,
        `Readiness: ${readiness.ready ? 'ready' : `missing ${missing.join(', ')}`}`,
        `Included skills: ${bundle.skillIds.join(', ')}`,
        '',
      ];
    }),
    ...active.slice(0, ENABLED_SKILLS_PROMPT_LIMIT).flatMap((skill) => {
      // Someone else's words the owner has not accepted, put into the prompt now: the conversation has read outside text.
      const others = noteOthersWritingRead('skill', skill.id, skill.author);
      return [
        `### ${skill.name}`,
        `Description: ${skill.description}`,
        `Review: ${formatAgentRecordReviewState(skill.reviewState)}`,
        ...(others !== undefined ? [`Written by ${others}, not the owner.`] : []),
        `Triggers: ${skill.triggers.join(', ') || '(manual)'}`,
        `Readiness: ${evaluateAgentSkillReadiness(skill).ready ? 'ready' : `missing ${evaluateAgentSkillReadiness(skill).missing.map(formatAgentSkillRequirement).join(', ')}`}`,
        skill.procedure,
        '',
      ];
    }),
    ...(beyondLimit ? [beyondLimit, ''] : []),
    ...(suppressedBundles.length > 0 || suppressedSkills.length > 0 ? [
      '### Suppressed Skills Pending Review Or Setup',
      'Do not apply these skills until the user reviews them or resolves setup through the learning curator.',
      ...suppressedBundles,
      ...suppressedSkills,
      '',
    ] : []),
  ].join('\n').trim();
}
