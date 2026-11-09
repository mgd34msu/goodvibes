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
    def invoke(self, root, wrong_last=False):
        source = 'a' * 40
        archives = root / 'archives'
        archives.mkdir()
        for target in ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']:
            name, payload = f'original-{target}', b'abc'
            metadata = json.dumps({'sourceCommit': 'b' * 40 if wrong_last and target == 'darwin-arm64' else source,
                                   'tag': 'v3.1.2', 'target': target,
                                   'files': {name: {'size': len(payload), 'sha256': 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'}}}).encode()
            with tarfile.open(archives / f'suite-{target}.tgz', 'w:gz') as archive:
                for entry, body in [(name, payload), (f'suite-release-source-{target}.json', metadata)]:
                    info = tarfile.TarInfo(entry)
                    info.size = len(body)
                    archive.addfile(info, io.BytesIO(body))
        output = root / 'github-output'
        output.write_text('prior=true\n')
        script = Path(__file__).with_name('collect-suite-release.py')
        with patch.dict(os.environ, {'GITHUB_OUTPUT': str(output)}), \
                patch('sys.argv', [str(script), str(archives), str(root / 'assets'), 'v3.1.2']), \
                patch('subprocess.check_output', return_value=json.dumps({'object': {'type': 'commit', 'sha': source}}).encode()), \
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

    def test_mixed_final_target_never_exposes_a_partial_source_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaises(AssertionError):
                self.invoke(root, wrong_last=True)
            self.assertEqual((root / 'github-output').read_text(), 'prior=true\n')


if __name__ == '__main__':
    unittest.main()
