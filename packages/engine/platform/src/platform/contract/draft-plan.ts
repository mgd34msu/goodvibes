/**
 * A plan drafted before the contract started: a launched plan proposal or
 * workstream draft. Its units become the contract's units as drafted. The
 * planner adds what the draft does not have (the contract criteria, each
 * unit's role and criteria, the groups that hold the units, and the
 * integration unit); the host joins that to the stored draft, so a drafted
 * unit's title, brief, files and attempts are the draft's whatever the planner
 * wrote, and only the graph rules are checked.
 */
import type { ContractPlan, PlannedGroup, PlanProblem } from './plan-schema.js';
import type { DraftedPlan, DraftedUnit } from './types.js';

/** The draft as the runner stores it: units numbered `u1`, `u2`... in draft order, dependencies renamed with them. */
export function numberDraft(draft: { readonly goal: string; readonly units: readonly DraftedUnit[] }): DraftedPlan {
  if (draft.units.length === 0) throw new Error('a drafted plan needs at least one unit');
  const ids = new Map<string, string>();
  draft.units.forEach((unit, index) => {
    if (ids.has(unit.id)) throw new Error(`the drafted plan names unit ${unit.id} twice`);
    ids.set(unit.id, `u${index + 1}`);
  });
  return {
    goal: draft.goal,
    units: draft.units.map((unit) => ({
      id: ids.get(unit.id)!,
      title: unit.title,
      brief: unit.brief,
      dependsOn: unit.dependsOn.map((dependency) => {
        const renamed = ids.get(dependency);
        if (renamed === undefined) throw new Error(`drafted unit ${unit.id} depends on ${dependency}, which the draft does not have`);
        return renamed;
      }),
      ...(unit.files === undefined ? {} : { files: [...unit.files] }),
      ...(unit.attempts === undefined ? {} : { attempts: unit.attempts }),
    })),
  };
}

/** The planner request's section for a drafted plan. */
export function draftSection(draft: DraftedPlan): string {
  return [
    '## The plan already drafted',
    'This plan was drafted and approved before the contract started. Place every drafted unit by its id and give it the role its brief calls for and its criteria.',
    'Its title, brief, files and attempts are taken from the draft whatever you write, so for a drafted unit write "title" and "brief" as one short line each; do not copy the drafted brief.',
    'Keep every drafted dependency: a unit that depends on another is either in the same group with that unit, or in a group that depends, directly or through other groups, on the group holding that unit.',
    'Write the goal and the contract criteria from the draft\'s goal and the request, and the criteria of every unit. Add no units except the integration unit the rules require for a plan with more than one unit.',
    '```json',
    JSON.stringify(draft, null, 2),
    '```',
  ].join('\n');
}

/**
 * The plan with every drafted unit's title, brief, files and attempts taken
 * from the draft, and each drafted dependency on a unit of the same group
 * added to its `dependsOn`. The planner's copies of drafted text are not
 * compared: the host has the draft.
 */
export function joinDraft(plan: ContractPlan, draft: DraftedPlan): ContractPlan {
  const drafted = new Map(draft.units.map((unit) => [unit.id, unit]));
  return {
    ...plan,
    groups: plan.groups.map((group) => {
      const inGroup = new Set(group.units.map((unit) => unit.id));
      return {
        ...group,
        units: group.units.map((unit) => {
          const draftedUnit = drafted.get(unit.id);
          if (draftedUnit === undefined) return unit;
          const sameGroup = draftedUnit.dependsOn.filter((dependency) => inGroup.has(dependency) && !unit.dependsOn.includes(dependency));
          return {
            ...unit,
            title: draftedUnit.title,
            brief: draftedUnit.brief,
            ...(draftedUnit.files === undefined ? {} : { files: [...draftedUnit.files] }),
            ...(draftedUnit.attempts === undefined ? {} : { attempts: draftedUnit.attempts }),
            dependsOn: [...unit.dependsOn, ...sameGroup],
          };
        }),
      };
    }),
  };
}

function problem(message: string, targetId?: string): PlanProblem {
  return { code: 'draft-changed', message, ...(targetId === undefined ? {} : { targetId }) };
}

/** Group ids a group depends on, directly or through other groups. */
function groupAncestors(groups: readonly PlannedGroup[], groupId: string): Set<string> {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const seen = new Set<string>();
  const stack = [...(byId.get(groupId)?.dependsOn ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(byId.get(next)?.dependsOn ?? []));
  }
  return seen;
}

/**
 * The graph rules a joined plan must keep (`joinDraft` already gave every
 * drafted unit its drafted text, files, attempts and same-group dependencies):
 * every drafted unit is placed, a drafted dependency in another group is kept
 * by the group order, and no unit is added except an integration unit.
 */
export function checkDraftFidelity(plan: ContractPlan, draft: DraftedPlan): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const placed = new Map<string, { readonly group: PlannedGroup; readonly unit: PlannedGroup['units'][number] }>();
  for (const group of plan.groups) for (const unit of group.units) placed.set(unit.id, { group, unit });
  const drafted = new Set(draft.units.map((unit) => unit.id));

  for (const unit of draft.units) {
    const found = placed.get(unit.id);
    if (found === undefined) {
      problems.push(problem(`Drafted unit ${unit.id} ("${unit.title}") is missing from the plan.`, unit.id));
      continue;
    }
    for (const dependency of unit.dependsOn) {
      const other = placed.get(dependency);
      if (other === undefined || other.group.id === found.group.id) continue;
      if (!groupAncestors(plan.groups, found.group.id).has(other.group.id)) {
        problems.push(problem(`Unit ${unit.id} depends on ${dependency} in the draft; put them in one group, or make group ${found.group.id} depend on group ${other.group.id}.`, unit.id));
      }
    }
  }
  for (const [id, { unit }] of placed) {
    if (!drafted.has(id) && unit.role !== 'integration') {
      problems.push(problem(`Unit ${id} ("${unit.title}") is not in the draft; only the integration unit may be added.`, id));
    }
  }
  return problems;
}
