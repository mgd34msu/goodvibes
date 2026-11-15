/**
 * Validation of the repo and ref names that are interpolated into the path of
 * an authenticated GitHub API call. The service checks them once, where they
 * enter (a status call or a new watch), and refuses bad input as an invalid
 * argument; the gh source only encodes what passed.
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
