"""Refuse a release whose commit has no passing CI.

Usage: require_green_ci.py <repository> <commit sha>

The CI workflow ends in one aggregate job (`CI ok`) that fails when any other job does. A release
needs the newest run of that job on the release commit to have succeeded. The check run is chosen
by its name AND the app that posted it (GitHub Actions) AND the workflow file it came from
(.github/workflows/ci.yml): another app or another workflow posting a check run named `CI ok` on
the commit is never read as CI.
"""
import json
import re
import subprocess
import sys

AGGREGATE = 'CI ok'
# The GitHub Actions app: the only app whose check runs are CI's own jobs.
ACTIONS_APP_ID = 15368
CI_WORKFLOW = '.github/workflows/ci.yml'


def ci_suite_ids(workflow_runs, workflow=CI_WORKFLOW):
    """The check suites of the CI workflow's runs on the commit."""
    return {run['check_suite_id'] for run in workflow_runs if run.get('path') == workflow and run.get('check_suite_id') is not None}


def evaluate(check_runs, suites, required=AGGREGATE):
    """Return None when the commit's CI passed, otherwise the reason it did not."""
    runs = sorted((run for run in check_runs
                   if run.get('name') == required
                   and (run.get('app') or {}).get('id') == ACTIONS_APP_ID
                   and (run.get('check_suite') or {}).get('id') in suites),
                  key=lambda run: run.get('id', 0))
    if not runs:
        return f'CI ({CI_WORKFLOW}) has not reported "{required}" for this commit. Let CI finish on it (or run it) before releasing.'
    latest = runs[-1]
    if latest.get('status') != 'completed':
        return f'CI is still running for this commit ("{required}" is {latest.get("status")}). Release after it finishes.'
    if latest.get('conclusion') != 'success':
        return f'CI did not pass for this commit ("{required}" concluded {latest.get("conclusion")}). Fix it and release from a green commit.'
    return None


def api(path):
    """Every page of one GitHub API listing."""
    return json.loads(subprocess.check_output(['gh', 'api', '--paginate', '--slurp', path], text=True))


def main(argv):
    repository, commit = argv
    assert re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository), 'Invalid repository'
    assert re.fullmatch(r'[0-9a-f]{40}', commit), 'A full commit SHA is required'
    workflow_runs = [run for page in api(f'repos/{repository}/actions/runs?head_sha={commit}&per_page=100') for run in page['workflow_runs']]
    check_runs = [run for page in api(f'repos/{repository}/commits/{commit}/check-runs?per_page=100') for run in page['check_runs']]
    problem = evaluate(check_runs, ci_suite_ids(workflow_runs))
    if problem:
        raise SystemExit(problem)
    print(f'CI passed for {commit}')


if __name__ == '__main__':
    main(sys.argv[1:])
