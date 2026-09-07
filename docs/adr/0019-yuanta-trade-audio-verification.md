# Yuanta Trade audio verification replaces image-selection

Status: accepted

The Yuanta Trade login offers several selectable verification modes, and its default is an image-selection challenge. Solving that challenge with a local vision model proved the weak point of the automatic CAPTCHA path (#160, #162): an open-ended click-the-images problem resists a small local model. The same login page also serves a first-party audio verification mode — it can switch to an audio challenge whose content is "開始播放" followed by six spoken decimal digits, served as an MP3 by `/NexusWebTrade/Login/VerificationCodeSound` and rotated by `/NexusWebTrade/Login/RenewVerificationCodeSound`. The image-selection plan is therefore replaced: the Yuanta Trade workflow switches to audio verification and declares an `audio-captcha` challenge, and a new local speech-recognition solver (sherpa-onnx running the paraformer-zh-small model) transcribes the six digits. The answer is injected into the verification input via the existing CDP path; login outcome remains the final correctness check.

## Considered Options

- **Local vision model for image-selection** — rejected for Yuanta Trade: the challenge is an open-ended image-matching problem a small local model cannot solve reliably enough to meet the confidence gate.
- **buster-style reCAPTCHA audio bypass** — considered: Yuanta Trade also offers "Google 我不是機器人" (reCAPTCHA Enterprise). Rejected because it requires crossing Google's anti-automation scoring and its cross-origin iframe, and because the first-party audio mode reaches the same transcription outcome without those risks.
- **Vosk speech recognition** — rejected after live validation: the official `vosk` and `@echogarden/vosk` Node bindings depend on `ffi-napi`/`ref-napi`, whose V8-ABI addons no longer compile on the project's Node 25 toolchain.
- **sherpa-onnx paraformer-zh-small** — chosen: a NAPI addon with prebuilt binaries that loads on Node 25, driving the 82 MB int8 paraformer model. Live validation transcribed all sampled challenges correctly with free-form output (no digit-grammar constraint needed).

## Consequences

- Adds an `audio-captcha` challenge kind alongside `text-captcha` and `image-selection`; the solver seam generalises its captured media from an image to a buffer that may carry an image or an audio clip.
- The local solver gains a speech-recognition runtime (`sherpa-onnx-node` + `sherpa-onnx` and the paraformer-zh-small int8 model), whose model ships via Git LFS. The MPEG clip is decoded with `mpg123-decoder`, resampled to 16 kHz, and transcribed; the Chinese output is mapped to decimal digits with the "開始播放" prompt dropped.
- Audio capture, like image capture, is on-device and memory-only; the solver answer is held only for the live injection.
- The Yuanta Trade workflow switches to audio verification and declares the audio challenge with `expectedAnswerLength: 6` and `charset: "digits"`.
- The retry budget reuses the CAPTCHA retry campaign; refreshing the challenge is the first-party `RenewVerificationCodeSound` call rather than a new screenshot.

## Follow-up options

- The smaller `sherpa-onnx-streaming-zipformer-zh-14M` int8 model (~25 MB) is recorded as a fallback if the 82 MB paraformer model needs to shrink: it is materially less accurate on the six-digit clips, so adopting it would pair with the existing bounded solver retry rather than stand alone.
