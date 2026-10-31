# Far Eastern International Bank CAPTCHA calibration

Evidence recorded on 2026-10-31 for PR #319. The corpus is private and outside the repository at `~/OctopusBeakCalibration/feib`. No account credentials or sign-in requests were sent during calibration.

## Corpus

`npm run calibrate:captcha -- collect feib --allow-live-source --headless` collected 60 images from the personal web bank login page through the Preview source, 3 seconds apart, with the `TrxDispatcher` `state=login` POST denied. Every image is 100×30 PNG. The maintainer labelled all 60 by hand on a phone over Tailscale (`label feib --listen`); none was marked unreadable, and every answer is six decimal digits. No agent assigned or inferred labels.

## Result

The generic pipeline with single-line page segmentation read all 60 correctly. With `confidence-only` at 0.97 it accepts 60/60 with no wrong answer: coverage 100%, observed FAR 0%, Wilson 95% upper bound 6.0%. Line removal with single-line OCR also accepted 60/60 but read one image wrong. The single-word and raw-line readings agreed with each other on all 60 but were right on 58, so agreement between them is not a safe acceptance rule. Bank-specific foreground extractions from other banks produce blank output for this geometry.

The selected family is `FEIB_CAPTCHA_FAMILY` in `src/lib/preview-sources/preview-captcha.ts`: one strategy (no preprocessing, single-line), `confidence-only`, threshold 0.97, geometry 100×30, answer `^\d{6}$`. Of the configurations that qualified, the evaluate recommendation picked the highest threshold. Unsupported geometry, charset, or declared length fails before OCR, and an unaccepted answer ends the run without filling the form.

## Limits

- The family meets the sample gate (at least 30 confirmed labels, FAR at most 2% over at least 20 accepts), but there is no independently labelled held-out set.
- No sign-in has been attempted with a real FEIB account, so whether FEIB accepts these answers in a live sign-in is not observed.
