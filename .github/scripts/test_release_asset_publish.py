"""The release completion script against a fake `gh` that keeps a release in a scratch directory."""
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('publish-missing-suite-assets.py')
TAG = 'v3.1.2'
REPO = 'owner/repo'
COMMIT = 'a' * 40

# A minimal `gh`: the release lives in $FAKE_RELEASE/assets, calls are appended to $FAKE_RELEASE/calls.
# Uploading the manifest with --clobber removes the old one first, like the real client, and fails
# the first $FAKE_FAIL_MANIFEST_UPLOADS such uploads.
FAKE_GH = r'''#!__PYTHON__
import hashlib, json, os, pathlib, shutil, sys
root = pathlib.Path(os.environ['FAKE_RELEASE'])
assets = root / 'assets'
args = sys.argv[1:]
with (root / 'calls').open('a') as calls:
    calls.write(' '.join(args) + '\n')
state = json.loads((root / 'state.json').read_text())
if args[0] == 'api':
    path = args[1]
    if path.endswith('/git/ref/tags/' + state['tag']):
        print(json.dumps({'object': {'type': state.get('ref_type', 'commit'), 'sha': state['commit']}}))
    elif '/releases/tags/' in path:
        listing = [{'name': f.name, 'size': f.stat().st_size, 'digest': 'sha256:' + hashlib.sha256(f.read_bytes()).hexdigest()} for f in sorted(assets.iterdir())]
        print(json.dumps({'draft': state.get('draft', False), 'tag_name': state['tag'], 'assets': listing}))
    else:
        sys.exit('unexpected api path ' + path)
elif args[:2] == ['release', 'download']:
    name = args[args.index('--pattern') + 1]
    directory = pathlib.Path(args[args.index('--dir') + 1])
    shutil.copy(assets / name, directory / name)
elif args[:2] == ['release', 'upload']:
    file = pathlib.Path([a for a in args[3:] if not a.startswith('--') and a != args[args.index('--repo') + 1]][0])
    if (assets / file.name).exists():
        if '--clobber' not in args:
            sys.exit('asset already exists')
        (assets / file.name).unlink()
    if file.name == state['manifest']:
        failures = root / 'failures'
        done = int(failures.read_text()) if failures.exists() else 0
        failures.write_text(str(done + 1))
        if done < int(os.environ.get('FAKE_FAIL_MANIFEST_UPLOADS', '0')):
            sys.exit('upload failed')
    shutil.copy(file, assets / file.name)
else:
    sys.exit('unexpected gh call ' + ' '.join(args))
'''


def digest(data):
    return hashlib.sha256(data).hexdigest()


class CompletionScript(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.release, self.candidates, bin_dir = root / 'release', root / 'candidates', root / 'bin'
        for directory in (self.release / 'assets', self.candidates, bin_dir):
            directory.mkdir(parents=True)
        gh = bin_dir / 'gh'
        gh.write_text(FAKE_GH.replace('__PYTHON__', sys.executable))
        gh.chmod(gh.stat().st_mode | stat.S_IXUSR)
        self.state = {'tag': TAG, 'commit': COMMIT, 'manifest': 'SHA256SUMS.txt'}
        self.write_state()
        self.env = {**os.environ, 'PATH': f'{bin_dir}:{os.environ["PATH"]}', 'FAKE_RELEASE': str(self.release), 'GITHUB_REPOSITORY': REPO}

    def write_state(self):
        (self.release / 'state.json').write_text(json.dumps(self.state))

    def publish(self, name, data):
        (self.release / 'assets' / name).write_bytes(data)

    def candidate(self, name, data):
        (self.candidates / name).write_bytes(data)

    def manifest(self, entries):
        return ''.join(f'{digest(data)}  {name}\n' for name, data in sorted(entries.items())).encode()

    def run_script(self, **env):
        return subprocess.run([sys.executable, str(SCRIPT), str(self.candidates), TAG], env={**self.env, **env}, capture_output=True, text=True, cwd=SCRIPT.parent)

    def uploads(self):
        calls = (self.release / 'calls').read_text().splitlines()
        return [call for call in calls if call.startswith('release upload')]

    def published(self, name):
        return (self.release / 'assets' / name).read_bytes()

    def test_a_draft_release_is_refused_before_anything_is_uploaded(self):
        self.state['draft'] = True
        self.write_state()
        self.candidate('program', b'new')
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.uploads(), [])

    def test_a_tag_that_is_not_a_commit_is_refused(self):
        self.state['ref_type'] = 'tree'
        self.write_state()
        self.candidate('program', b'new')
        self.assertNotEqual(self.run_script().returncode, 0)
        self.assertEqual(self.uploads(), [])

    def test_a_missing_payload_is_added_and_listed_with_the_published_ones(self):
        self.publish('program', b'kept')
        self.publish('SHA256SUMS.txt', self.manifest({'program': b'kept'}))
        self.candidate('program', b'rebuilt differently')
        self.candidate('companion', b'new')
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.published('program'), b'kept')
        self.assertEqual(self.published('companion'), b'new')
        self.assertEqual(self.published('SHA256SUMS.txt'), self.manifest({'program': b'kept', 'companion': b'new'}))

    def test_nothing_missing_and_an_identical_manifest_makes_no_upload(self):
        self.publish('program', b'kept')
        self.publish('SHA256SUMS.txt', self.manifest({'program': b'kept'}))
        self.candidate('program', b'rebuilt differently')
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.uploads(), [])
        self.assertIn('"checksumReplaced": false', result.stdout)

    def test_a_partial_upload_resumes_only_with_equal_bytes(self):
        self.publish('program', b'published')
        self.candidate('program', b'published')
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.published('SHA256SUMS.txt'), self.manifest({'program': b'published'}))

        (self.release / 'assets' / 'SHA256SUMS.txt').unlink()
        (self.candidates / 'program').write_bytes(b'rebuilt differently')
        refused = self.run_script()
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn('Unknown partial upload: program', refused.stderr)
        self.assertIn('Delete program from the release', refused.stderr)

    def test_a_checksummed_payload_the_release_lost_is_uploaded_again_from_a_matching_candidate(self):
        self.publish('SHA256SUMS.txt', self.manifest({'kept': b'kept', 'lost': b'lost'}))
        self.publish('kept', b'kept')
        self.candidate('kept', b'kept')
        self.candidate('lost', b'lost')
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.published('lost'), b'lost')
        self.assertEqual(self.published('SHA256SUMS.txt'), self.manifest({'kept': b'kept', 'lost': b'lost'}))

    def test_a_checksummed_payload_the_release_lost_is_refused_when_the_candidate_differs(self):
        self.publish('SHA256SUMS.txt', self.manifest({'kept': b'kept', 'lost': b'lost'}))
        self.publish('kept', b'kept')
        self.candidate('lost', b'not what the manifest recorded')
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('no candidate has its recorded digest: lost', result.stderr)
        self.assertEqual(self.uploads(), [])

    def test_a_failed_manifest_upload_is_retried(self):
        self.publish('program', b'kept')
        self.publish('SHA256SUMS.txt', self.manifest({'program': b'kept'}))
        self.candidate('companion', b'new')
        result = self.run_script(FAKE_FAIL_MANIFEST_UPLOADS='1')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.published('SHA256SUMS.txt'), self.manifest({'program': b'kept', 'companion': b'new'}))

    def test_a_manifest_that_cannot_be_uploaded_names_the_repair(self):
        self.publish('program', b'kept')
        self.publish('SHA256SUMS.txt', self.manifest({'program': b'kept'}))
        self.candidate('companion', b'new')
        result = self.run_script(FAKE_FAIL_MANIFEST_UPLOADS='99')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f'gh release upload {TAG} --repo {REPO} SHA256SUMS.txt --clobber', result.stderr)
        self.assertIn(self.manifest({'program': b'kept', 'companion': b'new'}).decode().splitlines()[0], result.stderr)

    def test_optimized_python_refuses_to_run_without_its_assertions(self):
        result = subprocess.run([sys.executable, '-O', str(SCRIPT), 'directory', TAG], capture_output=True, text=True, cwd=SCRIPT.parent)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('without -O', result.stderr)


if __name__ == '__main__':
    unittest.main()
