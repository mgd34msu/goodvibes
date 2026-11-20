"""The release gate's reading of a commit's check runs."""
import unittest

from require_green_ci import ACTIONS_APP_ID, CI_WORKFLOW, ci_suite_ids, evaluate

CI_SUITE = 7
OTHER_SUITE = 8
# The commit's workflow runs as the API lists them: CI's own, and another workflow's.
SUITES = ci_suite_ids([
    {'path': CI_WORKFLOW, 'check_suite_id': CI_SUITE},
    {'path': '.github/workflows/other.yml', 'check_suite_id': OTHER_SUITE},
])


def run(id, status='completed', conclusion='success', name='CI ok', suite=CI_SUITE, app=ACTIONS_APP_ID):
    return {'id': id, 'name': name, 'status': status, 'conclusion': conclusion,
            'check_suite': {'id': suite}, 'app': {'id': app}}


class CiGate(unittest.TestCase):
    def test_a_passing_aggregate_job_clears_the_release(self):
        self.assertIsNone(evaluate([run(1, name='validate', conclusion='failure'), run(2)], SUITES))
        # A green "CI ok" posted by another workflow or another app is not CI's: it clears nothing.
        self.assertIn('has not reported', evaluate([run(1, suite=OTHER_SUITE)], SUITES))
        self.assertIn('has not reported', evaluate([run(1, app=ACTIONS_APP_ID + 1)], SUITES))

    def test_no_aggregate_job_means_ci_has_not_reported(self):
        self.assertIn('has not reported', evaluate([run(1, name='validate')], SUITES))
        self.assertIn('has not reported', evaluate([], SUITES))

    def test_a_running_or_red_aggregate_job_blocks_with_its_state(self):
        self.assertIn('still running', evaluate([run(1, status='in_progress', conclusion=None)], SUITES))
        self.assertIn('concluded failure', evaluate([run(1, conclusion='failure')], SUITES))
        self.assertIn('concluded skipped', evaluate([run(1, conclusion='skipped')], SUITES))
        self.assertIn('concluded cancelled', evaluate([run(1, conclusion='cancelled')], SUITES))

    def test_the_newest_run_decides_after_a_rerun(self):
        self.assertIsNone(evaluate([run(1, conclusion='failure'), run(2)], SUITES))
        self.assertIn('concluded failure', evaluate([run(1), run(2, conclusion='failure')], SUITES))


if __name__ == '__main__':
    unittest.main()
