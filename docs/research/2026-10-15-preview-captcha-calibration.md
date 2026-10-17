# Preview source CAPTCHA calibration, October 2026

## Question

Can the local Tesseract solver answer the login CAPTCHA of the Taishin, Mega, Next Bank, and Rakuten preview sources often enough, and wrongly rarely enough, for ADR 0039 to allow automatic submission?

## Method

The maintainer collected each corpus with `npm run calibrate:captcha -- collect` and confirmed every label by hand. `evaluate` replayed the cached OCR candidates through the production `solveVerificationChallenge` for every strategy set, policy, and threshold, as [How to calibrate a preview source CAPTCHA](../agents/captcha-calibration.md) describes. No image or label is stored in the repository.

The chosen Taishin and Mega families were then replayed through the production `calibratedCaptchaSolver` (`src/lib/preview-sources/preview-captcha.ts`) twice: once with the cached candidates, and once with live Tesseract on every corpus image. Both replays gave the same counts as `evaluate`.

FAR is wrong accepted answers divided by accepted answers. The upper bound is the Wilson 95% upper bound of the FAR.

## Findings

| Bank | Confirmed labels | Image | Answer | Best single strategy, any confidence | Result |
| --- | --- | --- | --- | --- | --- |
| Taishin | 60, none unreadable | 120 x 36 PNG, all 60 | 6 decimal digits, all 60 | 58/60 (96.7%) | Calibrated |
| Mega | 200, none unreadable | 100 x 49 JPEG, all 200 | 5 decimal digits, all 200 | 104/200 (52%) | Calibrated |
| Next Bank | 60, none unreadable | 302 x 96 PNG, all 60 | 5 decimal digits, all 60 | 10/60 (16.7%) | Not calibrated |
| Rakuten | 60, none unreadable | 152 x 60 JPEG, all 60 | 4 characters, digits and uppercase letters | 18/60 (30%) | Not calibrated |

### Taishin

- Chosen: confidence-only over `pre=none|psm=single-word` and `pre=remove-interference-lines|psm=single-word`, threshold 0.5.
- Accepted 58 of 60 (coverage 96.7%), 0 wrong. FAR 0/58, upper bound 6.2%.
- The tool's recommendation, `pre=remove-interference-lines|psm=single-line` alone at 0.85, accepted 59 with 1 wrong (FAR 1.7%, upper bound 9.0%). The zero-error pair was chosen instead.

### Mega

- Chosen: confidence-only over `pre=none|psm=single-line`, `pre=none|psm=single-word`, and `pre=remove-interference-lines|psm=single-line`, threshold 0.99.
- Accepted 56 of 200 (coverage 28%), 0 wrong. FAR 0/56, upper bound 6.4%.
- The tool's recommendation, a triple with `pre=remove-interference-lines|psm=single-word` at 0.99, accepted 57 with 1 wrong (FAR 1.8%, upper bound 9.3%). The zero-error triple was chosen instead.
- Coverage is low, so the source refreshes an unaccepted challenge through its pre-login captcha API, up to five challenges per round (ADR 0046).

### Next Bank

- No configuration accepted at least 20 challenges at a FAR of 2% or less. The lowest FAR among configurations with at least 20 accepts was 50% (10 wrong of 20).
- The source keeps refusing with `verification-configuration-failed`.
- Every label was five digits, although the source declares an alphanumeric charset.

### Rakuten

- No configuration accepted at least 20 challenges at a FAR of 2% or less. The lowest FAR among configurations with at least 20 accepts was 50% (15 wrong of 30). The lowest FAR at any accept count was 37.5% (3 wrong of 8).
- The source keeps refusing with `verification-configuration-failed`.

## Limits

- Each corpus came from one collection period. A bank that changes its CAPTCHA renderer invalidates the family. The geometry, length, and charset guard refuses a changed size, but not a changed font or noise at the same size.
- The Mega images were decoded to PNG by Chromium's canvas during collection, and production decodes them the same way. A different Chromium JPEG decoder could shift the confidences slightly.
- No answer has been submitted to either bank. Whether Mega validates the most recent captcha after a refresh is inferred, not observed.
