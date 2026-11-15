"""The release gate's reading of a commit's check runs."""
import unittest

from require_green_ci import evaluate


def run(id, status='completed', conclusion='success', name='CI ok'):
    return {'id': id, 'name': name, 'status': status, 'conclusion': conclusion}


class CiGate(unittest.TestCase):
    def test_a_passing_aggregate_job_clears_the_release(self):
        self.assertIsNone(evaluate([run(1, name='validate', conclusion='failure'), run(2)]))

    def test_no_aggregate_job_means_ci_has_not_reported(self):
        self.assertIn('has not reported', evaluate([run(1, name='validate')]))
        self.assertIn('has not reported', evaluate([]))

    def test_a_running_or_red_aggregate_job_blocks_with_its_state(self):
        self.assertIn('still running', evaluate([run(1, status='in_progress', conclusion=None)]))
        self.assertIn('concluded failure', evaluate([run(1, conclusion='failure')]))
        self.assertIn('concluded skipped', evaluate([run(1, conclusion='skipped')]))
        self.assertIn('concluded cancelled', evaluate([run(1, conclusion='cancelled')]))

    def test_the_newest_run_decides_after_a_rerun(self):
        self.assertIsNone(evaluate([run(1, conclusion='failure'), run(2)]))
        self.assertIn('concluded failure', evaluate([run(1), run(2, conclusion='failure')]))


if __name__ == '__main__':
    unittest.main()
