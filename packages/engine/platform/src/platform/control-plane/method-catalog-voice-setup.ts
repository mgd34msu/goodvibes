/**
 * method-catalog-voice-setup.ts, managed local-voice provisioning verbs.
 *
 * `voice.local.status` reads the managed runtime state (not-provisioned /
 * partial / provisioned / unsupported-platform, with a size-labeled offer).
 * `voice.local.install` starts the one-act setup and answers at once: the run
 * provisions the piper engine + a default voice and pre-configures the
 * voice.local.* keys (never overwriting a user-set value), and its receipt is
 * read from `voice.local.status` (`lastInstall`). No request is held open for
 * the download, so a long install is never cut off by the server's idle limit.
 *
 * `voice.setup` is the one operation that sets voice up for a want ("wake",
 * "stt", "tts", "voice"): it plans from the host's own facts, does the steps
 * that need no answer, and returns the plan with what is still proposed or
 * asked. An install it needs is started, not waited for; its progress and
 * receipt are on `voice.local.status`.
 *
 * The three `voice.wake.*` verbs are here rather than in their own group because
 * they are the same capability, provisioning a pinned, checksum-verified voice
 * artifact and reporting honestly on it, and they attach through the voice-setup
 * service that is already composed. `voice.wake.model` exists because a browser
 * tab cannot fetch the pinned artifacts itself: the release assets answer with no
 * CORS header, so a tab reads the model from the daemon, same-origin, in bounded
 * chunks it verifies against the pinned checksum.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  methodDescriptor,
  objectSchema,
} from './method-catalog-shared.js';

const NULLABLE_NUMBER = { anyOf: [NUMBER_SCHEMA, { type: 'null' }] };
const NULLABLE_STRING = { anyOf: [STRING_SCHEMA, { type: 'null' }] };

/**
 * Live progress of the ACTIVE voice.local.install run, served inside the
 * status read while, and only while, an install is running. Surfaces poll
 * status during the provision to render real per-component progress.
 */
const INSTALL_IN_PROGRESS_SCHEMA = objectSchema({
  startedAt: NUMBER_SCHEMA,
  components: {
    type: 'array',
    items: objectSchema({
      component: STRING_SCHEMA,
      phase: { type: 'string', enum: ['skip', 'download', 'verify', 'extract', 'done', 'error'] },
      message: STRING_SCHEMA,
      bytesTotal: NUMBER_SCHEMA,
      bytesDone: NUMBER_SCHEMA,
    }, ['component', 'phase']),
  },
}, ['startedAt', 'components']);

const INSTALL_RESULT_SCHEMA = objectSchema({
  proof: objectSchema({
    proved: BOOLEAN_SCHEMA,
    stage: { type: 'string', enum: ['synthesize', 'transcribe', 'compare'] },
    phrase: STRING_SCHEMA,
    transcript: STRING_SCHEMA,
    wordOverlap: NUMBER_SCHEMA,
    comparison: { type: 'string', enum: ['yes', 'no'] },
    proofBasis: { type: 'string', enum: ['native-word-sequence'] },
    error: STRING_SCHEMA,
    summary: STRING_SCHEMA,
  }, ['proved', 'stage', 'phrase', 'summary']),
  notes: { type: 'array', items: STRING_SCHEMA },
  provisioned: BOOLEAN_SCHEMA,
  platform: NULLABLE_STRING,
  tts: objectSchema({
    engine: STRING_SCHEMA,
    state: { type: 'string', enum: ['provisioned', 'unsupported-platform', 'download-failed', 'checksum-mismatch'] },
    binaryPath: STRING_SCHEMA,
    modelPath: STRING_SCHEMA,
    reason: STRING_SCHEMA,
  }, ['engine', 'state']),
  stt: objectSchema({
    engine: STRING_SCHEMA,
    state: { type: 'string', enum: ['provisioned', 'unsupported-platform', 'download-failed', 'checksum-mismatch'] },
    binaryPath: STRING_SCHEMA,
    modelPath: STRING_SCHEMA,
    reason: STRING_SCHEMA,
  }, ['engine', 'state']),
  components: {
    type: 'array',
    items: objectSchema({
      id: STRING_SCHEMA,
      state: { type: 'string', enum: ['installed', 'skipped', 'failed'] },
      bytes: NUMBER_SCHEMA,
      error: STRING_SCHEMA,
    }, ['id', 'state']),
  },
  configured: objectSchema({
    set: { type: 'array', items: objectSchema({ key: STRING_SCHEMA, value: STRING_SCHEMA }, ['key', 'value']) },
    skipped: { type: 'array', items: objectSchema({ key: STRING_SCHEMA, reason: STRING_SCHEMA }, ['key', 'reason']) },
    // Keys whose earlier value the install replaced, with what it held before.
    superseded: { type: 'array', items: objectSchema({ key: STRING_SCHEMA, previousValue: STRING_SCHEMA, value: STRING_SCHEMA }, ['key', 'previousValue', 'value']) },
  }, ['set', 'skipped']),
}, ['provisioned', 'platform', 'tts', 'stt', 'components', 'configured']);

/**
 * The most recent install run this daemon finished, served on the status read
 * after the run ends: its receipt, or why it stopped without one. An install
 * answers at once and runs on in the daemon, so this is where its result is read.
 */
const LAST_INSTALL_SCHEMA = objectSchema({
  startedAt: NUMBER_SCHEMA,
  finishedAt: NUMBER_SCHEMA,
  receipt: INSTALL_RESULT_SCHEMA,
  error: STRING_SCHEMA,
}, ['startedAt', 'finishedAt']);

/** What voice.local.install answers at once: the run it started, or the one already running that it joined. */
const INSTALL_START_SCHEMA = objectSchema({
  state: { type: 'string', enum: ['running'] },
  startedAt: NUMBER_SCHEMA,
  joined: BOOLEAN_SCHEMA,
}, ['state', 'startedAt', 'joined']);

const SETUP_STEP_SCHEMA = objectSchema({
  kind: { type: 'string', enum: ['do', 'propose', 'ask'] },
  subject: STRING_SCHEMA,
  message: STRING_SCHEMA,
  options: {
    type: 'array',
    items: objectSchema({ id: STRING_SCHEMA, label: STRING_SCHEMA, trade: STRING_SCHEMA }, ['id', 'label', 'trade']),
  },
}, ['kind', 'subject', 'message']);

/** What voice.setup answers: the plan as carried out, and the install it started when it needed one. */
const SETUP_RESULT_SCHEMA = objectSchema({
  plan: objectSchema({
    intent: STRING_SCHEMA,
    shapes: { type: 'array', items: { type: 'string', enum: ['guided-walkthrough', 'browser-automation', 'official-cli', 'question-driven'] } },
    steps: { type: 'array', items: SETUP_STEP_SCHEMA },
  }, ['intent', 'shapes', 'steps']),
  rendered: STRING_SCHEMA,
  complete: BOOLEAN_SCHEMA,
  installStarted: INSTALL_START_SCHEMA,
}, ['plan', 'rendered', 'complete']);

const RUNTIME_STATUS_SCHEMA = objectSchema({
  platform: NULLABLE_STRING,
  state: { type: 'string', enum: ['not-provisioned', 'partial', 'provisioned', 'unsupported-platform'] },
  tts: objectSchema({
    engine: STRING_SCHEMA,
    binaryPresent: BOOLEAN_SCHEMA,
    voicePresent: BOOLEAN_SCHEMA,
    binaryPath: STRING_SCHEMA,
    modelPath: STRING_SCHEMA,
  }, ['engine', 'binaryPresent', 'voicePresent', 'binaryPath', 'modelPath']),
  stt: objectSchema({
    engine: STRING_SCHEMA,
    supported: BOOLEAN_SCHEMA,
    state: { type: 'string', enum: ['not-provisioned', 'partial', 'provisioned', 'unsupported-platform'] },
    binaryPresent: BOOLEAN_SCHEMA,
    modelPresent: BOOLEAN_SCHEMA,
    binaryPath: STRING_SCHEMA,
    modelPath: STRING_SCHEMA,
    reason: STRING_SCHEMA,
  }, ['engine', 'supported', 'state', 'binaryPresent', 'modelPresent', 'binaryPath', 'modelPath']),
  offerBytes: NULLABLE_NUMBER,
  installInProgress: INSTALL_IN_PROGRESS_SCHEMA,
  lastInstall: LAST_INSTALL_SCHEMA,
}, ['platform', 'state', 'tts', 'stt', 'offerBytes']);


/** Content-verified state of one wake artifact on disk. */
const WAKE_ARTIFACT_SCHEMA = objectSchema({
  path: STRING_SCHEMA,
  verified: BOOLEAN_SCHEMA,
  corrupt: BOOLEAN_SCHEMA,
  bytes: NUMBER_SCHEMA,
}, ['path', 'verified', 'corrupt', 'bytes']);

const WAKE_STATUS_SCHEMA = objectSchema({
  ready: BOOLEAN_SCHEMA,
  reason: NULLABLE_STRING,
  classifier: WAKE_ARTIFACT_SCHEMA,
  mobileClassifier: WAKE_ARTIFACT_SCHEMA,
  notice: WAKE_ARTIFACT_SCHEMA,
  embedding: WAKE_ARTIFACT_SCHEMA,
  embeddingNotice: WAKE_ARTIFACT_SCHEMA,
  vad: WAKE_ARTIFACT_SCHEMA,
  vadNotice: WAKE_ARTIFACT_SCHEMA,
  vadReady: BOOLEAN_SCHEMA,
  downloadBytes: NUMBER_SCHEMA,
  modelVersion: NULLABLE_STRING,
  recallIsSyntheticOnly: BOOLEAN_SCHEMA,
}, [
  'ready', 'reason', 'classifier', 'mobileClassifier', 'notice', 'embedding', 'embeddingNotice',
  'vad', 'vadNotice', 'vadReady', 'downloadBytes', 'modelVersion', 'recallIsSyntheticOnly',
]);

const WAKE_PROVISION_RESULT_SCHEMA = objectSchema({
  ready: BOOLEAN_SCHEMA,
  mobileFormatReady: BOOLEAN_SCHEMA,
  vadReady: BOOLEAN_SCHEMA,
  modelVersion: NULLABLE_STRING,
  noticePath: NULLABLE_STRING,
  embeddingNoticePath: NULLABLE_STRING,
  recallIsSyntheticOnly: BOOLEAN_SCHEMA,
  outcomes: {
    type: 'array',
    items: objectSchema({
      component: {
        type: 'string',
        enum: ['classifier', 'mobile-classifier', 'notice', 'embedding', 'embedding-notice', 'vad', 'vad-notice'],
      },
      state: { type: 'string', enum: ['installed', 'skipped', 'failed'] },
      path: STRING_SCHEMA,
      bytes: NUMBER_SCHEMA,
      error: STRING_SCHEMA,
    }, ['component', 'state', 'path']),
  },
}, [
  'ready', 'mobileFormatReady', 'vadReady', 'modelVersion', 'noticePath', 'embeddingNoticePath',
  'recallIsSyntheticOnly', 'outcomes',
]);

const WAKE_MODEL_CHUNK_SCHEMA = objectSchema({
  component: {
    type: 'string',
    enum: ['classifier', 'tflite', 'embedding', 'notice', 'embedding-notice', 'vad', 'vad-notice'],
  },
  offset: NUMBER_SCHEMA,
  bytes: NUMBER_SCHEMA,
  totalBytes: NUMBER_SCHEMA,
  sha256: STRING_SCHEMA,
  dataBase64: STRING_SCHEMA,
  complete: BOOLEAN_SCHEMA,
}, ['component', 'offset', 'bytes', 'totalBytes', 'sha256', 'dataBase64', 'complete']);

export const builtinGatewayVoiceSetupMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'voice.local.status',
    title: 'Get Managed Local-Voice Runtime State',
    description:
      'Whether the managed local voice runtime (piper TTS + a default voice) is installed: not-provisioned (with a size-labeled offer), partial, provisioned, or unsupported-platform. STT (whisper.cpp) reports its own managed state: goodvibes builds and pins the whisper.cpp bundle per platform (no official prebuilt exists; provisioning never compiles on your machine), so where a pinned bundle exists STT provisions like TTS, and elsewhere it reports unsupported honestly. While a voice.local.install run is active, the response also carries installInProgress, the live per-component progress (phase, byte sizes where known) of that run, so surfaces poll this read during the install to render real progress; the section is absent when no install is running. Once a run ends, lastInstall carries its receipt (or the reason it stopped without one) with the run\'s start and finish times; a surface that started an install reads its result here. Read-only.',
    category: 'health',
    scopes: ['read:health'],
    http: { method: 'GET', path: '/api/voice/local/status' },
    inputSchema: objectSchema({}, []),
    outputSchema: RUNTIME_STATUS_SCHEMA,
  }),
  methodDescriptor({
    id: 'voice.local.install',
    repeat: 'safe',
    title: 'Install the Managed Local-Voice Runtime',
    description:
      'Starts the one-act setup and answers at once with the run it started (or the run already in progress it joined); the install runs on in the daemon, voice.local.status serves its live progress as installInProgress and, when it ends, its receipt as lastInstall. The setup: download + checksum-verify the piper TTS engine, a default voice, and (where a pinned goodvibes-built bundle exists) the whisper.cpp STT engine with its default model into the goodvibes-managed directory, then point the voice.local.* config keys at the managed install, never overwriting a key you already set to a custom value (skipped keys are reported). The install ends by speaking a test phrase and reading it back: the transcript is compared word by word in code, allowing one differing word, and the receipt carries the transcript and the comparison. Downloads only when you ask; a failed or checksum-mismatched download keeps nothing.',
    category: 'health',
    scopes: ['write:config'],
    // Downloads and installs executables and rewrites voice.* config: admin, like config.set.
    access: 'admin',
    http: { method: 'POST', path: '/api/voice/local/install' },
    inputSchema: objectSchema({}, []),
    outputSchema: INSTALL_START_SCHEMA,
  }),
  methodDescriptor({
    id: 'voice.setup',
    repeat: 'safe',
    title: 'Set Up Voice',
    description:
      'Sets voice up for what was asked: intent wake (this surface listens for the wake word; implies speech-to-text), stt, '
      + 'tts or voice (all of it), for the surface named (tui, agent, webui, app), which is the one that ends up listening. '
      + 'The plan is decided from this host\'s own facts (wake rows, wake models on disk, the managed speech runtimes, the input '
      + 'device); steps that need no answer are done at once (the wake rows are set, missing wake models are fetched), and the '
      + 'answer lists each step: do (done, or why it could not be), propose (acceptProposals: true does it) and ask (ttsChoice '
      + 'answers the text-to-speech question: local or a cloud provider this host holds a credential for). An install the plan '
      + 'needs is started and not waited for: installStarted names the run, and voice.local.status serves its progress and '
      + 'receipt. rendered is the plan as one reply a surface prints as-is; complete is true when nothing is left to answer '
      + 'and every step that ran finished.',
    category: 'health',
    scopes: ['write:config'],
    // Writes voice settings and may install executables, like voice.local.install.
    access: 'admin',
    http: { method: 'POST', path: '/api/voice/setup' },
    inputSchema: objectSchema({
      intent: { type: 'string', enum: ['wake', 'stt', 'tts', 'voice'] },
      surface: { type: 'string', enum: ['tui', 'agent', 'webui', 'app'] },
      acceptProposals: BOOLEAN_SCHEMA,
      ttsChoice: STRING_SCHEMA,
    }, ['intent', 'surface']),
    outputSchema: SETUP_RESULT_SCHEMA,
  }),
  methodDescriptor({
    id: 'voice.wake.status',
    title: 'Get Wake-Word Model State',
    description:
      'Whether the pinned wake-word artifacts are on disk and VERIFIED BY CONTENT: the "hey goodvibes" classifier, the '
      + 'tflite form of the same classifier, the speech-embedding front end the classifier sits behind, the speech gate '
      + 'voice.wake.vadThreshold runs, and the attribution NOTICE belonging to each of the three redistributable artifacts '
      + '(the classifier\'s, the front end\'s and the gate\'s). Each reports '
      + 'verified, corrupt (present but failing its checksum, a truncated or swapped file, distinct from missing) and its '
      + 'byte size, with the total a fresh provision would download. Installing goodvibes provisions these, and a daemon '
      + 'retries at boot whatever the install could not fetch, so on a normal machine this reads ready without anyone having '
      + 'run a setup command; an offline install reports not-provisioned here until it is retried. The overall ready flag '
      + 'covers the classifier, the front end and both of THEIR NOTICEs, an artifact whose attribution is missing is not one '
      + 'this daemon may serve, and excludes two things: the tflite twin, which nothing here loads, so a host missing just '
      + 'that can still detect; and the speech gate, reported as vadReady instead, because voice.wake.vadThreshold defaults '
      + 'to 0 and the detector runs without it. Also restates that the model\'s published recall figures are measured on '
      + 'synthesised speech only, which any surface describing the model must carry. Never downloads. Read-only.',
    category: 'health',
    scopes: ['read:health'],
    http: { method: 'GET', path: '/api/voice/wake/status' },
    inputSchema: objectSchema({}, []),
    outputSchema: WAKE_STATUS_SCHEMA,
  }),
  methodDescriptor({
    id: 'voice.wake.provision',
    repeat: 'safe',
    title: 'Download the Wake-Word Models',
    description:
      'Download and checksum-verify the pinned wake-word classifier in both runtime formats (onnx and tflite), the '
      + 'speech-embedding front end, the speech gate voice.wake.vadThreshold runs, and the attribution NOTICE of each, into '
      + 'the goodvibes-managed directory, about 6.1 MB. '
      + 'Installing goodvibes already does '
      + 'this, and a daemon retries at boot, so this verb is the RECOVERY path: an install that was offline, an artifact that '
      + 'failed verification, or a re-provision after the pinned model changes. Resumable by re-running: an artifact that '
      + 'already matches its pin is skipped, and one that is present but fails verification is replaced rather than used. '
      + 'A failed or mismatched download keeps nothing at the destination. Single-flight: two surfaces asking at once, or a '
      + 'boot attempt and a user asking, join one download instead of racing for the same files.',
    category: 'health',
    scopes: ['write:config'],
    // Not admin: it fetches only checksum-pinned model files that install and
    // boot already fetch, runs nothing and changes no setting, so any caller
    // holding write:config may recover them.
    http: { method: 'POST', path: '/api/voice/wake/provision' },
    inputSchema: objectSchema({}, []),
    outputSchema: WAKE_PROVISION_RESULT_SCHEMA,
  }),
  methodDescriptor({
    id: 'voice.wake.model.get',
    title: 'Read Wake-Word Model Bytes',
    description:
      'Read one provisioned wake artifact in bounded chunks, for a surface that cannot fetch it itself, a browser tab, whose '
      + 'cross-origin fetch of the release asset is refused because that asset answers with no CORS header. Each chunk carries '
      + 'the offset, the whole artifact\'s size, and its PINNED sha256, so a client reassembles the file and verifies it against '
      + 'the pin: a truncated transfer fails at the consumer instead of loading as a model that silently never detects. '
      + 'Both classifier formats are served, "classifier" is the onnx build a browser tab loads, "tflite" the same classifier '
      + 'for a runtime that cannot, as is the speech gate voice.wake.vadThreshold runs ("vad"), and so is the attribution '
      + 'NOTICE of each redistributable artifact ("notice" for the classifier, "embedding-notice" for the front end, '
      + '"vad-notice" for the gate), because a client that can fetch the bytes but not the NOTICE '
      + 'cannot satisfy the terms it received them under. Serves what is on disk and does not download; installation puts it '
      + 'there, and voice.wake.provision is the recovery path when it is missing.',
    category: 'health',
    scopes: ['read:health'],
    http: { method: 'GET', path: '/api/voice/wake/model' },
    inputSchema: objectSchema({
      component: {
        type: 'string',
        enum: ['classifier', 'tflite', 'embedding', 'notice', 'embedding-notice', 'vad', 'vad-notice'],
      },
      offset: NUMBER_SCHEMA,
      maxBytes: NUMBER_SCHEMA,
    }, ['component']),
    outputSchema: WAKE_MODEL_CHUNK_SCHEMA,
  }),
];
