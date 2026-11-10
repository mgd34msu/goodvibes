"""Actual archive collector output is published only after all targets verify."""
import contextlib
import io
import json
import os
from pathlib import Path
import runpy
import tarfile
import tempfile
import unittest
from unittest.mock import patch


class SuiteCollectionOutputs(unittest.TestCase):
    def invoke(self, root, wrong_last=False, candidate=None, commit_sha=None, wrong_tag=False):
        source = 'a' * 40
        archives = root / 'archives'
        archives.mkdir()
        for target in ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']:
            name, payload = f'original-{target}', b'abc'
            metadata = json.dumps({'sourceCommit': 'b' * 40 if wrong_last and target == 'darwin-arm64' else source,
                                   'tag': 'v3.1.1' if wrong_tag and target == 'darwin-arm64' else 'v3.1.2', 'target': target,
                                   'files': {name: {'size': len(payload), 'sha256': 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'}}}).encode()
            with tarfile.open(archives / f'suite-{target}.tgz', 'w:gz') as archive:
                for entry, body in [(name, payload), (f'suite-release-source-{target}.json', metadata)]:
                    info = tarfile.TarInfo(entry)
                    info.size = len(body)
                    archive.addfile(info, io.BytesIO(body))
        output = root / 'github-output'
        output.write_text('prior=true\n')
        script = Path(__file__).with_name('collect-suite-release.py')
        arguments = [str(script), str(archives), str(root / 'assets'), 'v3.1.2']
        if candidate is not None:
            arguments.append(candidate)
        self.api_paths = []
        def api(command, **_kwargs):
            self.api_paths.append(command[-1])
            value = {'sha': commit_sha or source} if '/git/commits/' in command[-1] else {'object': {'type': 'commit', 'sha': source}}
            return json.dumps(value).encode()
        with patch.dict(os.environ, {'GITHUB_OUTPUT': str(output)}), \
                patch('sys.argv', arguments), \
                patch('subprocess.check_output', side_effect=api), \
                contextlib.redirect_stdout(io.StringIO()):
            runpy.run_path(str(script), run_name='__main__')
        return output

    def test_verified_original_source_is_exposed_without_archive_only_public_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = self.invoke(root)
            self.assertEqual(output.read_text(), 'prior=true\nsource=' + 'a' * 40 + '\n')
            self.assertEqual(len(list((root / 'assets').iterdir())), 4)
            self.assertFalse(list((root / 'assets').glob('suite-release-source-*')))
            self.assertEqual(self.api_paths, ['repos/mgd34msu/goodvibes/git/ref/tags/v3.1.2'])

    def test_mixed_final_target_never_exposes_a_partial_source_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaises(AssertionError):
                self.invoke(root, wrong_last=True)
            self.assertEqual((root / 'github-output').read_text(), 'prior=true\n')

    def test_candidate_verifies_original_commit_and_all_payload_pins_without_a_tag_lookup(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = self.invoke(root, candidate='a' * 40)
            self.assertEqual(output.read_text(), 'prior=true\nsource=' + 'a' * 40 + '\n')
            self.assertEqual(self.api_paths, ['repos/mgd34msu/goodvibes/git/commits/' + 'a' * 40])
            self.assertEqual({path.name: path.read_bytes() for path in (root / 'assets').iterdir()},
                             {f'original-{target}': b'abc' for target in ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']})

    def test_candidate_rejects_mixed_source_or_wrong_version_before_exposing_source(self):
        for changes in [{'wrong_last': True}, {'wrong_tag': True}]:
            with self.subTest(changes=changes), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                with self.assertRaises(AssertionError):
                    self.invoke(root, candidate='a' * 40, **changes)
                self.assertEqual((root / 'github-output').read_text(), 'prior=true\n')

    def test_candidate_refuses_moving_refs_and_changed_commit_resolution(self):
        for candidate, commit in [('main', None), ('a' * 40, 'b' * 40)]:
            with self.subTest(candidate=candidate), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                with self.assertRaises(AssertionError):
                    self.invoke(root, candidate=candidate, commit_sha=commit)
                self.assertEqual((root / 'github-output').read_text(), 'prior=true\n')
                self.assertFalse((root / 'assets').exists())


if __name__ == '__main__':
    unittest.main()
