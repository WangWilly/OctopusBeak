# Manual immutable Electron releases

OctopusBeak uses a manually dispatched, `main`-only release workflow for Electron application releases rather than publishing the root project to npm. The workflow gates version creation with a full preflight and reviewer-approved release environment, creates an immutable `vX.Y.Z` version, builds and verifies the signed macOS arm64 DMG and ZIP, stages them in a Draft GitHub Release, and publishes only after the complete build succeeds; failed packaging is recovered by retrying the existing tag instead of rewriting or incrementing the version.
