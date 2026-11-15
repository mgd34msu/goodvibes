"""Actual archive collector output is published only after all targets verify."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import subprocess
import sys


REPOSITORY = 'mgd34msu/goodvibes'
TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']
ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'


def archive_entries(target, wrong_commit=False, wrong_tag=False):
    """The default archive of one target: one payload and the descriptor that vouches for it."""
    payload = b'abc'
    return {
        'files': {f'original-{target}': payload},
        'descriptor': {'sourceCommit': 'b' * 40 if wrong_commit else 'a' * 40, 'tag': 'v3.1.1' if wrong_tag else 'v3.1.2', 'target': target,
                       'files': {f'original-{target}': {'size': len(payload), 'sha256': ABC}}},
    }


class SuiteCollectionOutputs(unittest.TestCase):
    def invoke(self, root, wrong_last=False, candidate=None, commit_sha=None, wrong_tag=False, repository=REPOSITORY, tweak=None, after_build=None):
        """`tweak(target, entries)` edits one target's archive before it is written; `after_build(archives)` edits the archive directory."""
        source = 'a' * 40
        archives = root / 'archives'
        archives.mkdir()
        for target in TARGETS:
            last = target == 'darwin-arm64'
            entries = archive_entries(target, wrong_commit=wrong_last and last, wrong_tag=wrong_tag and last)
            if tweak:
                tweak(target, entries)
            members = [(name, body) for name, body in entries['files'].items()]
            members.append((f'suite-release-source-{target}.json', json.dumps(entries['descriptor']).encode()))
            members.extend(entries.get('extra', []))
            with tarfile.open(archives / f'suite-{target}.tgz', 'w:gz') as archive:
                for entry, body in members:
                    info = tarfile.TarInfo(entry)
                    if isinstance(body, tarfile.TarInfo):
                        archive.addfile(body)
                        continue
                    info.size = len(body)
                    archive.addfile(info, io.BytesIO(body))
        if after_build:
            after_build(archives)
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
        with patch.dict(os.environ, {'GITHUB_OUTPUT': str(output), 'GITHUB_REPOSITORY': repository}), \
                patch('sys.argv', arguments), \
                patch('subprocess.check_output', side_effect=api), \
                contextlib.redirect_stdout(io.StringIO()):
            runpy.run_path(str(script), run_name='__main__')
        return output

    def refused(self, **changes):
        """The collection raises and exposes neither a source output nor admitted assets."""
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaises(AssertionError):
                self.invoke(root, **changes)
            self.assertEqual((root / 'github-output').read_text(), 'prior=true\n')

    def test_verified_original_source_is_exposed_without_archive_only_public_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = self.invoke(root)
            self.assertEqual(output.read_text(), 'prior=true\nsource=' + 'a' * 40 + '\n')
            self.assertEqual(len(list((root / 'assets').iterdir())), 4)
            self.assertFalse(list((root / 'assets').glob('suite-release-source-*')))
            self.assertEqual(self.api_paths, [f'repos/{REPOSITORY}/git/ref/tags/v3.1.2'])

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
            self.assertEqual(self.api_paths, [f'repos/{REPOSITORY}/git/commits/' + 'a' * 40])
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

    def test_the_running_repository_decides_where_the_tag_and_commit_are_resolved(self):
        with tempfile.TemporaryDirectory() as temporary:
            self.invoke(Path(temporary), repository='other-owner/other.repo')
            self.assertEqual(self.api_paths, ['repos/other-owner/other.repo/git/ref/tags/v3.1.2'])
        with tempfile.TemporaryDirectory() as temporary:
            self.invoke(Path(temporary), repository='other-owner/other.repo', candidate='a' * 40)
            self.assertEqual(self.api_paths, ['repos/other-owner/other.repo/git/commits/' + 'a' * 40])
        for bad in ('no-slash', 'a/b/c', 'a b/c', '/c'):
            with self.subTest(bad):
                self.refused(repository=bad)

    def test_a_payload_that_differs_from_its_descriptor_is_never_admitted(self):
        def flip_byte(target, entries):
            if target == 'linux-arm64':
                entries['files'][f'original-{target}'] = b'abd'
        def wrong_size(target, entries):
            if target == 'darwin-x64':
                entries['descriptor']['files'][f'original-{target}']['size'] = 4
        def wrong_digest(target, entries):
            if target == 'darwin-arm64':
                entries['descriptor']['files'][f'original-{target}']['sha256'] = '0' * 64
        for label, tweak in [('byte', flip_byte), ('size', wrong_size), ('digest', wrong_digest)]:
            with self.subTest(label):
                self.refused(tweak=tweak)

    def test_malformed_archives_are_never_admitted(self):
        def shared(payload_for):
            def tweak(target, entries):
                name = 'shared'
                body = payload_for(target)
                entries['files'] = {name: body}
                entries['descriptor']['files'] = {name: {'size': len(body), 'sha256': hashlib.sha256(body).hexdigest()}}
            return tweak
        def bad_name(target, entries):
            entries['files'] = {'bad name': b'abc'}
            entries['descriptor']['files'] = {'bad name': {'size': 3, 'sha256': ABC}}
        def other_target(target, entries):
            if target == 'linux-x64':
                entries['descriptor']['target'] = 'linux-arm64'
        def unlisted_member(target, entries):
            entries['extra'] = [('unlisted', b'x')]
        def symlink_member(target, entries):
            link = tarfile.TarInfo('link')
            link.type = tarfile.SYMTYPE
            link.linkname = '/etc/passwd'
            entries['extra'] = [('link', link)]
        def second_archive(archives):
            (archives / 'again').mkdir()
            (archives / 'again' / 'suite-linux-x64.tgz').write_bytes((archives / 'suite-linux-x64.tgz').read_bytes())
        def missing_archive(archives):
            (archives / 'suite-darwin-x64.tgz').unlink()
        cases = [
            ('same name, different bytes across targets', {'tweak': shared(lambda target: b'bytes ' + target.encode())}),
            ('name outside the flat-name rule', {'tweak': bad_name}),
            ('descriptor for another target', {'tweak': other_target}),
            ('member the descriptor does not list', {'tweak': unlisted_member}),
            ('non-regular member', {'tweak': symlink_member}),
            ('two archives for one target', {'after_build': second_archive}),
            ('missing target archive', {'after_build': missing_archive}),
        ]
        for label, changes in cases:
            with self.subTest(label):
                self.refused(**changes)

    def test_the_same_name_with_the_same_bytes_in_every_target_is_admitted_once(self):
        def shared(target, entries):
            entries['files'] = {'shared': b'abc'}
            entries['descriptor']['files'] = {'shared': {'size': 3, 'sha256': ABC}}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.invoke(root, tweak=shared)
            self.assertEqual([path.name for path in (root / 'assets').iterdir()], ['shared'])

    def test_optimized_python_refuses_to_run_without_its_assertions(self):
        script = Path(__file__).with_name('collect-suite-release.py')
        result = subprocess.run([sys.executable, '-O', str(script), 'archives', 'destination', 'v3.1.2'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('without -O', result.stderr)


if __name__ == '__main__':
    unittest.main()
