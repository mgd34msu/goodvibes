/** Actual suite release ownership shared by the two product governance entrypoints. */
export function suiteWorkflowProblems(value: unknown): readonly string[] {
  const object = (candidate: unknown): candidate is Record<string, unknown> =>
    candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate);
  if (!object(value) || !object(value.jobs)) return ['workspace release jobs must be a mapping'];
  const jobs = value.jobs;
  const problems: string[] = [];
  for (const name of ['verify-tag-version', 'publish-npm', 'complete-suite-assets', 'prepare-native-assets', 'github-release']) {
    if (!object(jobs[name])) problems.push(`workspace release is missing the "${name}" job`);
  }
  for (const [name, expected] of [
    ['complete-suite-assets', './.github/workflows/suite-release-assets.yml'],
    ['github-release', './.github/workflows/reusable-gh-release.yml'],
  ] as const) {
    const job = jobs[name];
    if (!object(job) || job.uses !== expected) problems.push(`workspace release job "${name}" must use ${expected}`);
  }
  for (const name of ['github-release']) {
    const job = jobs[name];
    if (!object(job) || !object(job.with) || job.with['toolchain-source'] !== 'workspace') {
      problems.push(`workspace release job "${name}" must use the workspace toolchain`);
    }
  }
  return problems;
}
