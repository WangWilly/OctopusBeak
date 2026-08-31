# Local solver model distribution

Status: accepted

The on-device verification solvers need model weights. The OCR engine (tesseract.js) fetches its English traineddata on first use, while the vision runtime (#159) and image-selection solver (#160) need an ONNX model that is versioned with the code that interprets it and bundled into the Electron desktop package. Large model files must neither bloat the repository nor force a runtime network dependency on a local-first product.

Decision: track vision (and any future ONNX) model files with Git LFS and bundle them into the desktop package at build time. Small fixtures (such as the committed `tiny-vision.onnx`, a few kilobytes) remain ordinary Git files so tests run without LFS.

## Considered Options

- **Git LFS** — chosen: consistent with the existing `*.mp4` and `src/lib/welcome/assets/**` LFS rules; the model is versioned with the solver code, reviewed in pull requests, and bundled offline. GitHub LFS quota is ample for a quantized model (tens of megabytes).
- **First-run download from a CDN** — rejected: introduces a network dependency on first use and a second distribution channel that must be checksum-verified, cutting against the local-first, on-device boundary.
- **GitHub Release asset downloaded at build time** — rejected: adds a release-time artifact channel and decouples the model from the code revision that reads it.
- **Commit directly without LFS** — rejected for real models: bloats clone and CI, and bypasses the LFS pattern already established in this repository.

## Consequences

- Add `*.onnx` (or a dedicated `models/` directory pattern) to `.gitattributes` as an LFS rule when the first real model lands, so the committed `tiny-vision.onnx` fixture stays a plain file.
- A real vision model is committed via LFS under `src/lib/automation/server/` and bundled into the desktop package, keeping runtime inference fully offline.
- Model and solver revision are coupled: a model change is an ordinary code change, reviewed and versioned with the solver that reads it.
- The vision runtime (#159) and image-selection solver (#160) stay model-path-parameterized, so the model file can be replaced without changing the solver logic.
