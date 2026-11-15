/**
 * Validation of the repo and ref names that are interpolated into the path of
 * an authenticated GitHub API call. Shared by the service (which refuses bad
 * input up front, as an invalid argument) and the gh source (which refuses it
 * again before any call).
 */
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** Characters git forbids in a ref name, plus the ones that would steer a URL path (`?`, `#`, `\`). */
const FORBIDDEN_REF = /[\u0000- \u007f~^:?*[\\#]|\.\.|@\{|\/\/|\.lock(\/|$)|^\/|\/$/;

export function isGitHubRepoName(repo: string): boolean {
  return REPO_PATTERN.test(repo) && !repo.split('/').some((part) => part === '.' || part === '..');
}

export function isGitRefName(ref: string): boolean {
  return ref.length > 0 && !FORBIDDEN_REF.test(ref);
}
