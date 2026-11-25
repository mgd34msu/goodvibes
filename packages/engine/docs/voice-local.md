# Local voice engines: free, offline STT and TTS

The `local` voice provider runs speech-to-text and text-to-speech entirely on
your machine, behind the exact same seams as the cloud providers (the voice
provider registry, the spoken-turn controller, the audio-sink contract). It is
the free peer beside the premium ElevenLabs route. Selection is the ordinary
`tts.provider` setting, and a spoken conversation completes with no cloud
voice dependency once engines are configured.

**Nothing auto-downloads.** Out of the box the provider reports an honest
`unconfigured` status (never an error). Setup is one explicit action per
engine, install it, download a model, set the `voice.local.*` keys below.

## Blessed engines (research pass, 2026-07-14)

Chosen from current comparative evidence, not from memory:

- **STT, whisper.cpp** (default). A pure C/C++ Whisper port. CPU-first,
  realtime-capable, no Python dependency. On Apple Silicon it runs ~10× real
  time on large-v3 with Metal. **faster-whisper** is the alternative when an
  NVIDIA GPU is present (CTranslate2 int8, ~4× original-Whisper throughput).
  Sources: [promptquorum: whisper.cpp vs faster-whisper 2026 benchmarks](https://www.promptquorum.com/power-local-llm/local-whisper-stt-comparison-2026),
  [codersera: faster-whisper vs whisper.cpp vs OpenAI Whisper (2026)](https://codersera.com/blog/faster-whisper-vs-whisper-cpp-speech-to-text-2026/),
  [modal: choosing Whisper variants](https://modal.com/blog/choosing-whisper-variants).
- **TTS, Piper** (default). ~0.03 real-time factor, first audio in ~40–50 ms,
  MIT-licensed, runs on CPU-only and edge hardware. **Kokoro-82M** is the
  quality alternative (Apache 2.0, 54 voices, beats XTTS v2 in blind listening
  tests at a fraction of the size).
  Sources: [contracollective: Kokoro vs Piper vs XTTS v2 (2026)](https://contracollective.com/blog/kokoro-vs-piper-vs-xtts-local-text-to-speech-m5-max-2026),
  [localaimaster: best local TTS models 2026](https://localaimaster.com/blog/best-local-tts-models),
  [codesota: TTS leaderboard 2026](https://www.codesota.com/text-to-speech).

## Worked setup path (Linux x86_64; the one used for the measurement below)

```bash
# 1. Piper (TTS): prebuilt binary + one small voice (~63 MB), user-scoped.
mkdir -p ~/.local/opt && cd ~/.local/opt
curl -sL -o piper.tar.gz \
  https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz
tar xzf piper.tar.gz
mkdir -p piper-voices
curl -sL -o piper-voices/en_US-lessac-low.onnx \
  "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/low/en_US-lessac-low.onnx"
curl -sL -o piper-voices/en_US-lessac-low.onnx.json \
  "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/low/en_US-lessac-low.onnx.json"

# 2. whisper.cpp (STT): build once + one tiny English model (~75 MB).
git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git
cd whisper.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j --target whisper-cli
curl -sL -o ggml-tiny.en.bin \
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin"

# 3. Point the platform at them (settings.json / config set):
#   voice.local.ttsEngine    = "piper"
#   voice.local.ttsBinary    = "~/.local/opt/piper/piper"           (a leading ~/ is expanded)
#   voice.local.ttsModelPath = "~/.local/opt/piper-voices/en_US-lessac-low.onnx"
#   voice.local.sttEngine    = "whisper-cpp"
#   voice.local.sttBinary    = "~/.local/opt/whisper.cpp/build/bin/whisper-cli"
#   voice.local.sttModelPath = "~/.local/opt/whisper.cpp/ggml-tiny.en.bin"
#   tts.provider             = "local"                              (route selection)
```

Engine invocation contracts (what the provider runs):

- `whisper-cpp`: `<binary> -m <model> -f <wav> --no-timestamps --no-prints` → transcript on stdout.
- `faster-whisper`: `<binary> <model> <wav>` → transcript on stdout. Wrapper:
  `python -c "from faster_whisper import WhisperModel; import sys; print(' '.join(s.text for s in WhisperModel(sys.argv[1]).transcribe(sys.argv[2])[0]))" "$@"`
- `piper`: `<binary> --model <onnx> --output_file <wav>`, text on stdin.
- `kokoro`: same contract as piper (`--model`, `--output_file`, text on stdin) via a small wrapper script around the kokoro-onnx CLI.

## Measured end-to-end latency (real run, this repo's development host)

Hardware class: AMD Ryzen 9 5900X (12C/24T), CPU-only, Linux. Measured
2026-07-14 with the exact setup above (process spawn + model load included,
the provider's real per-call path, no warm daemon):

| Leg | Engine / model | Input | Wall clock |
| --- | --- | --- | --- |
| TTS | Piper, en_US-lessac-low | 85-char sentence → 4.9 s of 16 kHz wav | **327 ms** |
| STT | whisper.cpp, tiny.en | that 4.9 s wav | **459 ms** |
| Spoken round trip | both | text → audio → text (round-tripped exactly) | **≈ 786 ms** |

The STT leg reproduced the input text byte-for-byte ("Hello from the local
voice engine. This is a real end to end synthesis measurement."). Larger
models trade latency for accuracy; GPU hosts should prefer faster-whisper for
STT per the sources above.

## Setup

`voice.setup` is the one operation that sets voice up for a want: `intent`
`wake` (this surface listens for the wake word, which implies speech-to-text),
`stt`, `tts` or `voice`, for the `surface` that asked. The plan is decided from
the host's own facts; steps that need no answer are done at once, and the reply
lists each step as done, proposed (`acceptProposals: true` does it) or asked
(`ttsChoice` answers the text-to-speech question). An install the plan needs is
started, not waited for: `installStarted` names the run, and
`voice.local.status` serves its progress and receipt. `rendered` is the plan as
one reply to print as-is. The terminal app and the Agent run the same service
in-process for setting up the wake word (System place, Voice) and when wake is switched on; the web UI's
wake switch calls `voice.setup`.

## Managed install

`voice.local.install` installs text-to-speech (piper and a default voice) and
speech-to-text (whisper.cpp and its model) as two independent halves: a failed
voice download never stops speech-to-text, which the wake word and dictation
need, and the receipt reports each half's own state. The verb answers at once
with the run it started (or the run already in progress it joined) and the
install goes on in the daemon: `voice.local.status` carries its progress as
`installInProgress` while it runs and its receipt as `lastInstall` once it ends,
so a long install is never cut off by a request timeout. Every download streams to
disk, fails only after 60 s with no data,
and keeps what it received: the next attempt resumes from there. The install
ends by speaking a test phrase and reading it back; the transcript proves the
round trip when its words match the phrase, allowing one differing word. A
local engine that keeps failing is stopped after three failed runs in a row (at
once for a crash or an incompatible model) until it is reinstalled, the daemon
restarts or its `voice.local.*` paths change.

## Managed engine bundles: hosting and stability contract

`voice.local.install` provisions the STT engine (whisper.cpp) from a
goodvibes-built, checksum-pinned bundle. Those bundles are hosted at ONE
pinned GitHub release tag, **`voice-runtimes-v1`**. Provisioning tries the
`mgd34msu/goodvibes` release first and falls back to the former
[`mgd34msu/goodvibes-sdk` release](https://github.com/mgd34msu/goodvibes-sdk/releases/tag/voice-runtimes-v1),
which holds the same bytes and checksum sidecars. Every origin is checked
against the same pinned size and sha256. Before a release, run
`bun packages/engine/scripts/check-voice-runtime-urls.ts` (add
`--require-all-origins` once the canonical release carries every asset) to
confirm each pinned URL is served.

Stability contract (relied on by the pinned manifest and every referencing
script):

- **Append-only.** Assets are added under new, versioned filenames
  (`goodvibes-whisper-cpp-<version>-<platform>.tar.gz`). An existing asset is
  **never re-uploaded in place and never renamed**. The publish workflow uploads
  without `--clobber`, so an attempt to replace a pinned asset fails loudly.
- **Move-in-lockstep.** If an asset location ever must change, every script/doc
  that references it (the manifest `bundle.url`, this doc, the build script's
  printed URL) is updated in the **same commit**. A pinned URL is never left
  dangling.
- **Reproducible.** `scripts/build-whisper-bundle.ts` produces a byte-reproducible
  tarball (`tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner`,
  `gzip -n`), so a clean rebuild of identical inputs matches the pinned `sha256`.
  A user can therefore build the bundle themselves and drop it at
  `<managedRoot>/engines/whisper.tar.gz`: a file there that matches the pin is
  used as is, with no download.

To build and publish a new bundle, run `scripts/build-whisper-bundle.ts` (it
prints the bundle, its `.sha256` sidecar, and the durable hosted URL), or trigger
the **Voice runtimes** workflow (`.github/workflows/voice-runtimes.yml`), then
stamp the printed `WHISPER_ENGINES` entry into the manifest. linux-x64 is hosted
today; other platforms report `unsupported` honestly until their bundle is
uploaded to the same tag.

## Cost honesty

- **Every provider except local (ElevenLabs, OpenAI, and the rest)**. Every
  synthesis/transcription through the voice service records billable units
  (characters for text-to-speech, seconds for speech-to-text) into cost
  attribution under a voice-scoped model key,
  `<provider>:voice-<tts|stt>:<characters|seconds>`, for example
  `elevenlabs:voice-tts:characters` or `elevenlabs:voice-stt:seconds`. Each
  reports honestly UNPRICED until the one-key manual price for that exact key
  names your plan's rate:
  `pricing.modelPrices["elevenlabs:voice-tts:characters"] = { "input": <USD per 1M units> }`,
  after which sessions show real dollars with `user` pricing provenance. Speech
  in and speech out are separate keys, so price each one you use.
- **Local**. No billing dimension at all. Local calls record nothing. The
  cost surfaces show an honest absence, never a fake $0.00.
