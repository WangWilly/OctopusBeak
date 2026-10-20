# Rakuten CAPTCHA calibration, October 20, 2026

## Method

The maintainer confirmed 183 captured challenges by hand. All are 152×60 images with four uppercase letters or decimal digits. Corpus images, labels, candidates, and individual answers remain outside the repository.

The first 123 images were used to compare teal extraction, morphology, and character segmentation. A single pair was fixed before evaluating the additional 60 images. The new images have distinct ids and no exact image-hash overlap with the original set. No thresholds, whitelist, cuts, or acceptance rules were retuned on them.

The fixed pair is:

- Whole image: `rakuten-teal-closed`, `single-line`.
- Per character: `rakuten-teal-foreground`, `ocrCharacterSegmentation: "rakuten-four-slots"`. For each of three cuts, search ±13 pixels around slots at x=38, 76, 114. Minimize `4*(ink[cut-1]+ink[cut]) + ((cut-target)/13)^2`. Tightly crop each glyph, scale by two, pad with 10 white pixels on every side, then run Tesseract single-character mode. Use the unchanged production alphanumeric whitelist and normalization. A glyph producing zero or multiple characters rejects the entire strategy.

The policy is agreement-only: both strategies must return the same four-character answer. The four glyph calls are one strategy and cannot establish agreement by themselves. Geometry, declared length, and charset remain guarded by the calibrated family.

## Results

| Corpus | Challenges | Accepted | Correct | Wrong | Coverage | FAR | FAR Wilson 95% upper bound |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Parameter selection | 123 | 60 | 59 | 1 | 48.8% | 1.7% | 8.9% |
| Held-out validation | 60 | 29 | 29 | 0 | 48.3% | 0.0% | 11.7% |
| Combined reference | 183 | 89 | 88 | 1 | 48.6% | 1.1% | 6.1% |

Only the 60-image row is held out; the combined row includes parameter selection. The fixed pair meets the existing observed FAR ≤2% and at least 20 accepts gate on the held-out set. This gate does not require the Wilson upper bound to be ≤2%.

After integration, all 183 character candidates matched the frozen experiment. Replaying the production `calibratedCaptchaSolver` with cached candidates and then with real local Tesseract reproduced the same selection, held-out, and combined counts above. Confirmed labels were preserved when prelabel refreshed the 25-strategy corpus.

The expanded `evaluate` sweep recommends the same two strategies with confidence-or-agreement/reject at 0.99: 91 accepts, 90 correct, one wrong (49.7% coverage, 1.1% FAR). This extra confidence-only acceptance was selected after examining the combined corpus and was not the held-out rule. The production family therefore retains the previously fixed agreement-only rule with 89 accepts.

## Implementation and limits

`RAKUTEN_CAPTCHA_FAMILY` keeps this fixed two-strategy pair. `prelabel` and `evaluate` include the same character pipeline used by the production engine. A later grid recommendation is exploratory and does not replace the held-out pair automatically.

The family does not establish that true FAR is below 2%; the upper bounds above remain substantial. A renderer change at the same dimensions can evade the geometry guard. The corpus does not establish that unobserved characters are forbidden, so no letters or digits were removed from the whitelist. No live bank sign-in or financial collection was performed for this calibration. The source submits at most one accepted answer per round and has no verified in-page refresh.
