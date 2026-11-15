"""Refuse a release whose commit has no passing CI.

Usage: require_green_ci.py <repository> <commit sha>

The CI workflow ends in one aggregate job (`CI ok`) that fails when any other job does. A release
needs the newest run of that job on the release commit to have succeeded.
"""
import json
import re
import subprocess
import sys

AGGREGATE = 'CI ok'


def evaluate(check_runs, required=AGGREGATE):
    """Return None when the commit's CI passed, otherwise the reason it did not."""
    runs = sorted((run for run in check_runs if run.get('name') == required), key=lambda run: run.get('id', 0))
    if not runs:
        return f'CI has not reported "{required}" for this commit. Let CI finish on it (or run it) before releasing.'
    latest = runs[-1]
    if latest.get('status') != 'completed':
        return f'CI is still running for this commit ("{required}" is {latest.get("status")}). Release after it finishes.'
    if latest.get('conclusion') != 'success':
        return f'CI did not pass for this commit ("{required}" concluded {latest.get("conclusion")}). Fix it and release from a green commit.'
    return None


def main(argv):
    repository, commit = argv
    assert re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository), 'Invalid repository'
    assert re.fullmatch(r'[0-9a-f]{40}', commit), 'A full commit SHA is required'
    listing = subprocess.check_output(['gh', 'api', '--paginate', '--slurp', f'repos/{repository}/commits/{commit}/check-runs?per_page=100'], text=True)
    check_runs = [run for page in json.loads(listing) for run in page['check_runs']]
    problem = evaluate(check_runs)
    if problem:
        raise SystemExit(problem)
    print(f'CI passed for {commit}')


if __name__ == '__main__':
    main(sys.argv[1:])
