"""The previous-release choice, against scratch git repositories."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from resolve_previous_release import resolve


class PreviousRelease(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.repo = Path(self.temporary.name)
        self.previous_cwd = os.getcwd()
        os.chdir(self.repo)
        self.addCleanup(os.chdir, self.previous_cwd)
        self.git('init', '-q', '-b', 'main')
        self.commits = 0

    def git(self, *args):
        return subprocess.run(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', *args],
                              cwd=self.repo, capture_output=True, text=True, check=True).stdout.strip()

    def commit(self, tag=None):
        self.commits += 1
        self.git('commit', '-q', '--allow-empty', '-m', f'c{self.commits}')
        if tag:
            self.git('tag', tag)
        return self.git('rev-parse', 'HEAD')

    def test_the_nearest_earlier_stable_tag_is_chosen_over_a_nearer_prerelease(self):
        self.commit('v3.1.0')
        self.commit('v3.2.0-rc.1')
        self.commit('v3.2.0+meta')
        self.commit('v3.2.0')
        self.commit('v3.3.0')
        self.assertEqual(resolve('v3.3.0', 'refs/tags/v3.3.0^'), ('v3.2.0', self.git('rev-parse', 'v3.2.0^{commit}')))

    def test_a_release_with_no_earlier_stable_tag_is_a_first_release(self):
        self.commit('v3.0.0-rc.1')
        self.commit('v3.0.0')
        self.assertIsNone(resolve('v3.0.0', 'refs/tags/v3.0.0^'))

    def test_a_first_release_in_an_untagged_history_is_not_an_error(self):
        self.commit()
        self.assertIsNone(resolve('v1.0.0', 'HEAD'))

    def test_the_release_tag_itself_is_never_its_own_previous(self):
        self.commit('v1.0.0')
        self.assertIsNone(resolve('v1.0.0', 'HEAD'))

    def test_a_failed_search_with_earlier_stable_tags_is_an_error_not_a_skip(self):
        def failing_describe(*args):
            if args[0] == 'tag':
                return subprocess.CompletedProcess(args, 0, 'v1.0.0\nv1.1.0\nv1.2.0\n', '')
            return subprocess.CompletedProcess(args, 128, '', 'fatal: cannot describe')
        with self.assertRaises(SystemExit):
            resolve('v1.2.0', 'HEAD', git=failing_describe)

    def test_the_outputs_name_the_previous_tag_and_commit(self):
        source = self.commit('v1.0.0')
        self.commit('v1.1.0')
        output = self.repo / 'github-output'
        completed = subprocess.run(['python3', str(Path(__file__).with_name('resolve_previous_release.py')), 'v1.1.0', 'refs/tags/v1.1.0^{commit}^'],
                                   cwd=self.repo, env={**os.environ, 'GITHUB_OUTPUT': str(output)}, capture_output=True, text=True)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(output.read_text(), f'tag=v1.0.0\nsource={source}\n')

    def test_a_first_release_says_the_upgrade_proof_is_skipped(self):
        self.commit('v1.0.0')
        output = self.repo / 'github-output'
        completed = subprocess.run(['python3', str(Path(__file__).with_name('resolve_previous_release.py')), 'v1.0.0', 'HEAD'],
                                   cwd=self.repo, env={**os.environ, 'GITHUB_OUTPUT': str(output)}, capture_output=True, text=True)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn('::warning::', completed.stdout)
        self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
