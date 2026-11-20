"""Regression coverage for release publication checksum selection."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from release_asset_pins import evidence_product_ids, needs_metadata, release_exists, resume_existing_assets, stage_release_assets, validate_reader_assets

# Each product's identifier in release evidence, read from the product's own table as publication reads it.
PRODUCT_IDS = evidence_product_ids()

SOURCE = 'a' * 40


def pin(value):
    return {'sha256': hashlib.sha256(value).hexdigest(), 'size': len(value)}


def reader_payloads(binary=b'original'):
    asset = 'goodvibes-linux-x64'
    return {asset: binary, asset + '.bun': b'runtime', asset + '.bun.LICENSE.md': b'license', asset + '.bun.json': b'owner'}


def member(path, payload, mode):
    return {'path': path, **pin(payload), 'mode': mode}


def linux_tui_cohort():
    """A valid linux-x64 terminal cohort: pins of the published bytes and the descriptor that names them."""
    asset = 'goodvibes-linux-x64'
    payloads = reader_payloads()
    pins = {name: pin(payload) for name, payload in payloads.items()}
    descriptor = {
        'target': 'linux-x64', 'schema': 1, 'packageName': PRODUCT_IDS['goodvibes'], 'version': '3.1.2',
        'readers': {'schema': 1, 'version': '3.1.2'}, 'sourceCommit': SOURCE, 'headCommit': SOURCE,
        'files': [member(name, payload, 0o755 if name in (asset, asset + '.bun') else 0o644) for name, payload in payloads.items()],
    }
    return pins, {asset + '.reader-ci-artifact.json': descriptor}


def linux_daemon_cohort():
    """A valid linux-x64 daemon cohort: the rich descriptor plus the legacy one that must agree with it."""
    asset = 'goodvibes-daemon-linux-x64'
    payloads = {asset: b'daemon', asset + '.bun': b'runtime', asset + '.bun.LICENSE.md': b'license', asset + '.bun.json': b'owner',
                'sqlite-vec-linux-x64.so': b'vec'}
    pins = {name: pin(payload) for name, payload in payloads.items()}
    paths = {asset: asset, asset + '.bun': asset + '.bun', asset + '.bun.LICENSE.md': asset + '.bun.LICENSE.md', asset + '.bun.json': asset + '.bun.json',
             'lib/sqlite-vec-linux-x64/vec0.so': 'sqlite-vec-linux-x64.so'}
    files = [member(path, payloads[name], 0o755 if path in (asset, asset + '.bun') else 0o644) for path, name in paths.items()]
    rich = {'target': 'linux-x64', 'schema': 2, 'readers': {'schema': 1, 'version': '3.1.2'}, 'sourceCommit': SOURCE, 'headCommit': SOURCE,
            'sourceTree': 't' * 40, 'files': files}
    legacy = {'target': 'linux-x64', 'schema': 1, 'sourceCommit': SOURCE, 'headCommit': SOURCE, 'sourceTree': 't' * 40, 'files': files}
    return pins, {asset + '.reader-ci-artifact.json': rich, asset + '.ci-artifact.json': legacy}


def darwin_daemon_cohort():
    """A valid macOS arm64 daemon cohort with the SQLite library producer that binds the selected dylib."""
    asset = 'goodvibes-daemon-macos-arm64'
    payloads = {asset: b'daemon', 'sqlite-vec-darwin-arm64.dylib': b'vec', 'sqlite-darwin-arm64.dylib': b'sqlite', 'sqlite-darwin-arm64.dylib.json': b'producer'}
    pins = {name: pin(payload) for name, payload in payloads.items()}
    paths = {asset: asset, 'lib/sqlite-vec-darwin-arm64/vec0.dylib': 'sqlite-vec-darwin-arm64.dylib',
             'lib/sqlite-darwin-arm64/libsqlite3.dylib': 'sqlite-darwin-arm64.dylib', 'lib/sqlite-darwin-arm64/libsqlite3.dylib.json': 'sqlite-darwin-arm64.dylib.json'}
    files = [member(path, payloads[name], 0o755 if path == asset else 0o644) for path, name in paths.items()]
    descriptor = {'target': 'darwin-arm64', 'schema': 1, 'packageName': PRODUCT_IDS['goodvibes-daemon'], 'version': '3.1.2',
                  'readers': {'schema': 1, 'version': '3.1.2'}, 'sourceCommit': SOURCE, 'headCommit': SOURCE, 'files': files}
    producer = {'schema': 1, 'packageName': PRODUCT_IDS['goodvibes-daemon'], 'daemonVersion': '3.1.2', 'target': 'darwin-arm64', **pins['sqlite-darwin-arm64.dylib']}
    return pins, {asset + '.reader-ci-artifact.json': descriptor, 'sqlite-darwin-arm64.dylib.json': producer}


def validate(cohort, source=SOURCE, tag='v3.1.2'):
    pins, metadata = cohort
    validate_reader_assets(pins, {name: json.dumps(value).encode() for name, value in metadata.items()}, tag, source)


def mutated(cohort, edit):
    pins, metadata = copy.deepcopy(cohort)
    edit(pins, metadata)
    return pins, metadata


class ReleasePinSelection(unittest.TestCase):
    def test_a_valid_cohort_is_accepted(self):
        for cohort in (linux_tui_cohort(), linux_daemon_cohort(), darwin_daemon_cohort()):
            validate(cohort)
        validate(linux_tui_cohort(), source=None)

    def test_each_broken_field_is_refused_with_its_own_message(self):
        tui = 'goodvibes-linux-x64.reader-ci-artifact.json'
        cases = [
            ('target', lambda p, m: m[tui].update(target='linux-arm64'), 'Reader target mismatch'),
            ('schema', lambda p, m: m[tui].update(schema=2), 'Reader schema mismatch'),
            ('package', lambda p, m: m[tui].update(packageName=PRODUCT_IDS['goodvibes-agent']), 'Reader product/version mismatch'),
            ('version', lambda p, m: m[tui].update(version='3.1.1'), 'Reader product/version mismatch'),
            ('reader version', lambda p, m: m[tui]['readers'].update(version='3.1.1'), 'Reader version mismatch'),
            ('source commit', lambda p, m: m[tui].update(sourceCommit='b' * 40), 'Reader source mismatch'),
            ('head commit', lambda p, m: m[tui].update(headCommit='b' * 40), 'Reader source mismatch'),
            ('missing member', lambda p, m: m[tui]['files'].pop(), 'Incomplete reader cohort'),
            ('extra member', lambda p, m: m[tui]['files'].append(member('extra', b'x', 0o644)), 'Incomplete reader cohort'),
            ('member digest', lambda p, m: m[tui]['files'][0].update(sha256='0' * 64), 'Reader pins do not match selected published bytes'),
            ('member size', lambda p, m: m[tui]['files'][1].update(size=999), 'Reader pins do not match selected published bytes'),
            ('program mode', lambda p, m: m[tui]['files'][0].update(mode=0o644), 'Reader member mode mismatch'),
            ('data mode', lambda p, m: m[tui]['files'][2].update(mode=0o755), 'Reader member mode mismatch'),
            ('unselected member asset', lambda p, m: p.pop('goodvibes-linux-x64.bun.json'), 'Reader references missing asset'),
        ]
        for label, edit, message in cases:
            with self.subTest(label):
                with self.assertRaisesRegex(AssertionError, message):
                    validate(mutated(linux_tui_cohort(), edit))

    def test_oversized_or_unreadable_descriptors_and_wrong_tags_are_refused(self):
        pins, metadata = linux_tui_cohort()
        with self.assertRaisesRegex(AssertionError, 'Oversized reader metadata'):
            validate_reader_assets(pins, {name: b' ' * (128 * 1024 + 1) for name in metadata}, 'v3.1.2', SOURCE)
        for tag in ('3.1.2', 'v3.1', 'v3.1.2-rc.1', 'v3.1.2+meta'):
            with self.subTest(tag), self.assertRaisesRegex(AssertionError, 'Invalid release tag'):
                validate(linux_tui_cohort(), tag=tag)

    def test_daemon_descriptors_must_agree_and_the_rich_one_must_exist(self):
        legacy = 'goodvibes-daemon-linux-x64.ci-artifact.json'
        rich = 'goodvibes-daemon-linux-x64.reader-ci-artifact.json'
        with self.assertRaisesRegex(AssertionError, 'Legacy/rich daemon descriptors disagree'):
            validate(mutated(linux_daemon_cohort(), lambda p, m: m[legacy].update(sourceTree='u' * 40)))
        with self.assertRaisesRegex(AssertionError, 'Selected program has no reader evidence'):
            validate(mutated(linux_daemon_cohort(), lambda p, m: m.pop(rich)))
        with self.assertRaisesRegex(AssertionError, 'Reader schema mismatch'):
            validate(mutated(linux_daemon_cohort(), lambda p, m: m[rich].update(schema=1)))

    def test_darwin_daemon_needs_a_producer_that_binds_the_selected_library(self):
        producer = 'sqlite-darwin-arm64.dylib.json'
        cases = [
            ('absent', lambda p, m: m.pop(producer), 'Darwin SQLite producer is absent'),
            ('daemon version', lambda p, m: m[producer].update(daemonVersion='3.1.1'), 'Darwin SQLite producer identity mismatch'),
            ('target', lambda p, m: m[producer].update(target='darwin-x64'), 'Darwin SQLite producer identity mismatch'),
            ('digest', lambda p, m: m[producer].update(sha256='0' * 64), 'Darwin SQLite producer does not bind selected library'),
            ('size', lambda p, m: m[producer].update(size=1), 'Darwin SQLite producer does not bind selected library'),
        ]
        for label, edit, message in cases:
            with self.subTest(label), self.assertRaisesRegex(AssertionError, message):
                validate(mutated(darwin_daemon_cohort(), edit))

    def test_only_descriptors_that_can_prove_a_cohort_need_metadata(self):
        self.assertTrue(needs_metadata('goodvibes-linux-x64.reader-ci-artifact.json'))
        self.assertTrue(needs_metadata('goodvibes-daemon-linux-x64.ci-artifact.json'))
        self.assertTrue(needs_metadata('sqlite-darwin-arm64.dylib.json'))
        self.assertFalse(needs_metadata('goodvibes-linux-x64.ci-artifact.json'))
        self.assertFalse(needs_metadata('goodvibes-linux-x64'))

    def test_a_checksummed_asset_the_release_lost_is_uploaded_again_only_with_its_recorded_digest(self):
        kept, lost = pin(b'kept'), pin(b'lost')
        assets = {'kept': {'digest': 'sha256:' + kept['sha256'], 'size': kept['size']}, 'SHA256SUMS.txt': {}}
        self.assertEqual(resume_existing_assets(assets, {'kept': kept['sha256'], 'lost': lost['sha256']}, {'lost': lost}), [])
        with self.assertRaisesRegex(AssertionError, 'no candidate has its recorded digest: lost'):
            resume_existing_assets(assets, {'kept': kept['sha256'], 'lost': lost['sha256']}, {'lost': pin(b'rebuilt differently')})
        with self.assertRaisesRegex(AssertionError, 'no candidate has its recorded digest: lost'):
            resume_existing_assets(assets, {'kept': kept['sha256'], 'lost': lost['sha256']}, {})

    def test_unknown_partial_upload_says_how_to_recover(self):
        candidate = pin(b'published')
        assets = {'program': {'digest': 'sha256:' + candidate['sha256'], 'size': candidate['size']}}
        with self.assertRaisesRegex(AssertionError, 'Delete program from the release'):
            resume_existing_assets(assets, {}, {'program': pin(b'different')})

    def test_optimized_python_refuses_to_run_without_its_assertions(self):
        result = subprocess.run([sys.executable, '-O', '-c', 'import release_asset_pins'], cwd=Path(__file__).parent, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('without -O', result.stderr)

    def test_missing_program_evidence_refuses_publication(self):
        payloads = reader_payloads()
        with self.assertRaisesRegex(AssertionError, 'no reader evidence'):
            # The actual precondition refuses a selected program lacking its
            # reader before any member pin can be inspected. Only names are
            # relevant here; no discarded descriptor or fixture digest.
            validate_reader_assets({name: {} for name in payloads}, {}, 'v3.1.2', SOURCE)


    def test_partial_upload_resume_requires_exact_candidate_pin(self):
        candidate = pin(b'published')
        assets = {'companion': {'digest': 'sha256:' + candidate['sha256'], 'size': candidate['size']}, 'SHA256SUMS.txt': {}}
        checks = {}
        self.assertEqual(resume_existing_assets(assets, checks, {'companion': candidate}), ['companion'])
        self.assertEqual(checks, {'companion': candidate['sha256']})
        with self.assertRaisesRegex(AssertionError, 'Unknown partial upload'):
            resume_existing_assets(assets, {}, {'companion': pin(b'other rebuild')})


    def test_partial_upload_without_any_checksum_manifest_can_resume_only_exact_bytes(self):
        candidate = pin(b'published')
        assets = {'program': {'digest': 'sha256:' + candidate['sha256'], 'size': candidate['size']}}
        checks = {}
        self.assertEqual(resume_existing_assets(assets, checks, {'program': candidate}, 'CUSTOM-SUMS.txt'), ['program'])
        self.assertEqual(checks, {'program': candidate['sha256']})

    def test_release_completion_refuses_ambiguous_asset_names(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first, second = root / 'first', root / 'second'
            first.mkdir()
            second.mkdir()
            (first / 'program').write_bytes(b'original')
            (second / 'program').write_bytes(b'other')
            stage = root / 'stage'
            with self.assertRaisesRegex(AssertionError, 'Ambiguous release asset basename'):
                stage_release_assets(stage, f'{first}/* {second}/*', 'SHA256SUMS.txt')
            self.assertEqual(list(stage.iterdir()), [])

    def test_release_completion_selects_explicit_candidates_once(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'program'
            source.write_bytes(b'original')
            stage = root / 'stage'
            self.assertEqual(stage_release_assets(stage, f'{source} {source}', 'SHA256SUMS.txt'), ['program'])
            self.assertEqual((stage / 'program').read_bytes(), b'original')


    def test_only_a_not_found_answer_means_the_release_is_absent(self):
        def answer(code, body):
            return lambda *_args, **_kwargs: subprocess.CompletedProcess([], code, json.dumps(body), 'error')
        self.assertFalse(release_exists('owner/repo', 'v3.1.2', run=answer(1, {'status': '404'})))
        self.assertTrue(release_exists('owner/repo', 'v3.1.2', run=answer(0, {'tag_name': 'v3.1.2', 'draft': False})))
        for code, body in [(1, {'status': '500'}), (1, None), (0, {'tag_name': 'v3.1.2', 'draft': True})]:
            with self.subTest(code=code, body=body), self.assertRaises(AssertionError):
                release_exists('owner/repo', 'v3.1.2', run=answer(code, body))


if __name__ == '__main__':
    unittest.main()
