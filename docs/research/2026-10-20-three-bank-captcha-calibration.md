# First Bank, KGI, and O-Bank CAPTCHA calibration

Evidence recorded on 2026-10-20 for the continuation of PR #231. The corpus is
private and outside the repository at `~/OctopusBeakCalibration/<bank>`.
No account credentials or sign-in requests were sent during calibration.

## Dark foreground extraction

First Bank's 62 existing images are 67×29. Their grayscale histogram separates
the text, concentrated below 40, from interference beginning around 80. The
fixed `firstbank-dark-foreground` candidate keeps luminance ≤64, resizes 4× with
the shared interpolation, and adds a 10px white border. It skips the generic
blur, line removal, and component removal. Against the maintainer's corrected
labels, single-word OCR improves from 49/62 (79.0%) with the generic pipeline
to 54/62 (87.1%).

Additional local experiments did not justify a more complicated First Bank
pipeline: 3×3 closing reduced the best reading to 46/62, fixed four-slot
single-character OCR reached 37/62, and an uppercase-only whitelist did not
improve on 54/62. Those experimental variants are not production strategies.
The maintainer reviewed the existing one-character confirmations and corrected
the labels before the final evaluation; no agent assigned or inferred labels.

The selected First Bank family uses line-removal single-line OCR followed by
dark-foreground single-line and single-word OCR, with `confidence-only` at
0.97. Cached evaluation and real Tesseract replay through the production
solver both accept 54/62 images, with 53 correct and one wrong: coverage
87.1%, observed FAR 1.85%, Wilson 95% upper bound 9.77%. It meets the existing
sample gate, but has no independently labelled held-out set. Unsupported
geometry, charset, and declared length fail before OCR; an unaccepted answer
causes no sign-in, refresh, or logout. Failed or successful submitted sign-ins
retain their existing logout behavior.

KGI's 62 existing images are 98×25. Its colored text is much darker than its
gray interference. `kgibank-dark-foreground` keeps luminance ≤96 and resizes 3×;
`kgibank-dark-padded` uses the same threshold with 4× resizing and a 10px white
border. The unpadded single-line reading improves exact accuracy from 45/62
(72.6%) to 58/62 (93.5%). Closing was less accurate and is not included.

All three new preprocessing modes require their bank's exact geometry, compose
alpha against white before thresholding, and fail closed when combined with
another mode. Real samples, answers, and experimental output stay outside Git.

## Fixed KGI production family

The selected family fixes 98×25, six decimal digits, and these three strategies:

1. Generic preprocessing, single-line OCR.
2. `kgibank-dark-foreground`, single-line OCR.
3. `kgibank-dark-padded`, single-word OCR.

Acceptance uses `confidence-or-agreement` with conflict resolution `reject` and
threshold 0.99. Distinct preprocessing paths retain distinct strategy
fingerprints. Invalid-length OCR readings do not participate in acceptance.

Both a cached-candidate replay with the actual strategy declarations and a real
Tesseract replay through `calibratedCaptchaSolver` accept 56/62 images, all
correct: coverage 90.3%, observed FAR 0%, Wilson 95% upper bound 6.42%. This
exceeds the existing sample gate of at least 30 confirmed images, at least 20
acceptances, and observed FAR ≤2%; it does not establish a true FAR below 2%.
The declaration was fixed before the maintainer labelled 60 additional images.
These held-out images have no exact image-hash overlap with the original 62;
prelabel preserved every original confirmation. The fixed solver accepts
54/60 new images, all correct: coverage 90.0%, observed FAR 0%, Wilson 95%
upper bound 6.64%. The combined reference result is 110/122 accepted, all
correct, coverage 90.2%, upper bound 3.37%. Real Tesseract replay reproduces
these numbers. The new labels validate the declaration; they do not select a
replacement from the full grid's later recommendation.

The source opens the login page, reads one challenge, and submits only after
acceptance. A refusal sends no credentials, performs no refresh, and does not
log out an account that was never signed in. Existing credential rejection and
session takeover behavior is unchanged. No live account login was tested.

## O-Bank capture

The calibration CLI now supports `obank`. It uses the source's public API
bootstrap through guarded browser HTTP. The browser serves an inert same-origin
document at the app entry point: the real app redirects during startup and
otherwise destroys the fetch execution context. API requests remain real;
`submitCredentials` and authenticated `sendAndReceive` requests are denied.
The recording solver stops the source immediately after the challenge image.
The production source retains its Node HTTP transport for API requests. A live
public-media probe confirmed the challenge is JPEG, which the Node transport's
PNG-only decoder could not read. O-Bank now decodes non-PNG challenge media in
an isolated browser page without opening the bank app. A synthetic JPEG check
exercises the default Node transport and confirms that the solver receives PNG
with the original dimensions, before any credential sealing or submission.

The run collected 60 images, all 152×60, converted them to PNG, and generated
local OCR suggestions. The maintainer confirmed all 60. O-Bank shares Rakuten's
teal layout but has its own family: unclosed teal single-word OCR must agree
with the existing teal four-slot character pipeline. Cached evaluation and
real Tesseract replay both accept 24/60 images, all correct: coverage 40.0%,
observed FAR 0%, Wilson 95% upper bound 13.80%. Confidence alone never permits
submission. No independently labelled held-out O-Bank set or live account
login was tested.

## Calibration tooling checks

The strategy grid contains 34 candidates, including the three new preprocessing
modes with each whole-image segmentation mode. Rerunning prelabel replaces
suggestions and preserves confirmations. The label server rejects a confirmed
answer whose normalized length differs from an authoritative source length;
it prioritizes such existing confirmations for review without modifying them.
Length hints remain advisory, and Esc is the explicit unreadable marker.

Synthetic checks cover thresholds, geometry, transparency, incompatible mode
combinations, guarded O-Bank capture, authoritative versus hinted label lengths,
KGI's acceptance policy, and rejection before form submission. The previous
PR CI failed on a stale registry check that still expected Rakuten's default
source to refuse CAPTCHA support before opening a page. A focused invocation
reproduced that exact assertion failure, then passed after the registry check
was updated to include the supported Rakuten, First Bank, and KGI browser
flows. The complete registry check file also passes. See the
[calibration guide](../agents/captcha-calibration.md) for the current procedure.
