# How to calibrate a preview source CAPTCHA

ADR 0039 lets a source submit a CAPTCHA answer only through a calibrated solver family. The Taishin, Mega, Rakuten, First Bank, KGI, O-Bank, and FEIB preview sources have calibrated image families, and Next Bank solves its CAPTCHA from its audio challenge with the local speech recogniser instead of an image family. See [the initial calibration record](../research/2026-10-15-preview-captcha-calibration.md), [Rakuten's calibration and held-out validation](../research/2026-10-20-rakuten-captcha-calibration.md), [the First Bank, KGI, and O-Bank calibration record](../research/2026-10-20-three-bank-captcha-calibration.md), and [the FEIB calibration record](../research/2026-10-31-feib-captcha-calibration.md). `npm run calibrate:captcha` is the development-only calibration tool. It collects real CAPTCHA images, lets you label them by hand, and measures which OCR configuration the production solver could use for each bank. The installer does not include it.

You label every image yourself. No agent labels or solves a CAPTCHA image. Prelabel only suggests an answer from local OCR. A suggestion counts only after you confirm it.

A separate tool validates the Next Bank audio CAPTCHA: `npm run validate:nextbank-audio` collects the spoken clips, transcribes them with the same local speech recogniser the source uses, and serves a page where you listen to each clip and confirm the recognised digits.

## Run the four steps for a bank

Replace `mega` with `taishin`, `rakuten`, `kgibank`, `firstbank`, `obank`, or `feib` for the other banks.

1. Collect the images. The browser window opens on your screen. Add `--headless` to hide it.

   ```sh
   npm run calibrate:captcha -- collect mega --allow-live-source
   ```

2. Add OCR suggestions. This step runs Tesseract on your machine.

   ```sh
   npm run calibrate:captcha -- prelabel mega
   ```

3. Label the images. The command prints a `http://127.0.0.1:<port>/` URL. Open it in your browser, label every image, then press Ctrl-C in the terminal.

   ```sh
   npm run calibrate:captcha -- label mega
   ```

   To label from a phone on your tailnet, add `--listen` with this Mac's Tailscale IPv4 address (`tailscale ip -4`) and open the printed URL on the phone. The CLI accepts only `127.0.0.1` or an address in Tailscale's `100.64.0.0/10` range, so the page is never offered on a LAN or public interface.

   ```sh
   npm run calibrate:captcha -- label mega --listen "$(tailscale ip -4)"
   ```

4. Evaluate the labels.

   ```sh
   npm run calibrate:captcha -- evaluate mega
   ```

Every subcommand takes `--corpus DIR` to use another corpus directory. `evaluate` also takes `--json` to print the full result as JSON. `--help` prints the usage and exits.

To collect more images, run `collect` again. It appends to the corpus. Run `prelabel` again after it. Prelabel replaces suggestions and keeps your confirmed labels.

## Understand what collect sends

`collect` opens the same non-persistent development browser as `npm run workflow:dev`. For each image, it runs the steps below and stops before any sign-in request.

| Bank | Method | Requests before the image |
| --- | --- | --- |
| `mega` | Preview source | OAuth client credentials, `/main/init`, the App initialize call, then `/fco/fco00001/captcha`. The image comes back as base64 in the JSON response. |
| `rakuten` | Preview source page driver | The login page. The image is a data URI in `div.pic_veri captcha-image img`. |
| `taishin` | Preview source login form | The RWD login page. `form.captcha()` takes the bytes of the `NonSessionShuffle` response that `img._field_item__verify-code` loaded. It also records the `maxlength` of the CAPTCHA input when the page declares one. |
| `kgibank` | Preview source | The Ionic login page (`/ibank/`). `form.captcha()` reads the CAPTCHA data URL from `img[src^="data:image"]` (or `ion-img.recaptcha-image`) and decodes it to PNG. Use `--headless`: KGI's landing page rejects a visible Playwright browser with 「瀏覽器不支援」. |
| `firstbank` | Preview source page driver | The iBank login page. `page.captchaImage()` takes the `code_verify1.jpg` response bytes and decodes them to PNG. |
| `obank` | Preview source through guarded browser HTTP | OAuth client credentials, public MobileFirst adapter bootstrap, `emptyLogin`, login-page metadata and audit, then `common/CMN01001/010`. The browser serves an inert same-origin page so the web app cannot redirect during those requests. No credentials are sent. Production retains its Node transport. |
| `feib` | Preview source page driver | The personal web bank login page (`mainIndex6.jsp`). `page.captchaImage()` waits for the login form and takes the `VerifyCodeServlet` response bytes, decoded to PNG. The deny rule blocks the `TrxDispatcher` POST whose body says `state=login`. |

Two guards keep `collect` from signing in:

- The preview sources run with a solver that records the image and then throws. The source never reaches its login request. The Taishin capture calls only `form.captcha()`, so it never fills or submits the form.
- Each bank in `scripts/captcha-calibration/banks.ts` lists deny rules for its login requests. The browser aborts any request that matches a rule, and the whole collection stops with an error.

The browser check `scripts/captcha-calibration/collect.check.mjs` runs each bank capture against fake bank hosts. It asserts that no request matches a deny rule or a login path, including O-Bank's `submitCredentials` and authenticated `sendAndReceive` adapter.

## Stay within the politeness limits

- `--count` defaults to 60. The CLI rejects a value above 200.
- `--delay-ms` defaults to 3000. The CLI rejects a value below 2000. The delay applies between captures.
- After three failed captures in a row, `collect` stops. The log shows only the error class, never page content.
- Ctrl-C stops the run. Captures written so far stay in the corpus.

## Find the corpus

The corpus defaults to `~/OctopusBeakCalibration/<bank>`. The CLI refuses a directory inside the repository, including one reached through a symlink.

- `images/<id>.png` holds each image as PNG. `collect` converts JPEG, GIF, BMP, and WebP images to PNG in the browser.
- `captures.jsonl` has one line per image: `id`, `file`, `capturedAt`, `width`, `height`, `sourceMediaType`, `method`, and `declaredLength` when the page declared one.
- `labels.json` holds the OCR suggestion (`suggested`) and your label (`confirmed`) per image.
- `evaluation.json` holds the last `evaluate` result.

## Keep the corpus private

- A CAPTCHA image is public challenge media. It contains no personal data, and `collect` sends no credentials.
- Keep the corpus outside the repository. Never commit an image, `labels.json`, or `evaluation.json`.
- Tesseract may download its English model on first use, as ADR 0013 describes. It stores the model outside the repository.

## Label with the keyboard

The page shows each image at six times its size with `image-rendering: pixelated`. The answer box starts with the OCR suggestion selected, so typing replaces it.

| Key | Action |
| --- | --- |
| Enter | Save the text in the box as the confirmed answer, then go to the next unconfirmed image. |
| Esc | Mark the image unreadable, then go to the next unconfirmed image. |
| PageUp, PageDown | Go to the previous or next image to fix a label. |
| Save, Unreadable buttons | Do the same as Enter and Esc, for a phone keyboard without Esc. |
| Left arrow, right arrow | Do the same when the box is empty. |

The **Previous** and **Next** buttons also move between images. The server stores the answer after the production normalization: digits only for a digit bank, and uppercase letters and digits for an alphanumeric bank. The page shows how many OCR strategies agree with the suggestion and how many images you have confirmed.

When the source declares an authoritative answer length, prelabel suggests only answers of that length. A bank's length hint does not filter suggestions. All OCR candidates, including other lengths, stay in `labels.json` for evaluation, and rerunning prelabel preserves confirmed labels.

The label server also rejects answers that do not match an authoritative source length after normalization. Existing confirmations with a different length stay in the corpus and are selected for review before the page reports completion; it never turns them into unreadable labels automatically. A length hint does not restrict confirmation.

Mark an image unreadable when you cannot read it with confidence. Evaluate counts any answer the solver would submit for an unreadable image as a false accept.

## Read the evaluate output

`evaluate` uses only confirmed labels and the stored OCR candidates. It does not run OCR again. For each configuration, it calls the production `solveVerificationChallenge` with the cached candidates.

It tries each strategy in `scripts/captcha-calibration/strategies.ts` alone with confidence only. It tries every pair and triple of strategies with confidence only, with agreement only, and with confidence or agreement that rejects conflicts. Thresholds run from 0.50 to 0.95 in steps of 0.05, plus 0.97 and 0.99. Agreement only ignores the threshold, so it appears once with threshold `n/a`.

Rakuten has two foreground strategies: `rakuten-teal-foreground` extracts teal pixels and removes neutral interference; `rakuten-teal-closed` then applies one 3×3 square dilation followed by erosion to the black foreground. Closing fills small holes and gaps while restoring the outer stroke bounds away from the image border. Both require 152×60 input. They are separate candidates, so evaluate can compare the original filtering with closing. Rerun `prelabel rakuten` before `evaluate rakuten` to measure the added strategy on your corpus.

The grid also includes `pre=rakuten-teal-foreground|split=rakuten-four-slots`. It uses the same teal extraction, chooses cuts near four character slots from the column ink projection, tightly crops each glyph, doubles it, adds a 10px white border, and runs Tesseract's single-character mode. Every glyph must normalize to exactly one character; otherwise the whole strategy returns no answer. The four internal OCR calls constitute one Solve Attempt, not four agreement votes. Unsupported geometry and empty slots fail closed.

This fixed pipeline is declared with `ocrCharacterSegmentation: "rakuten-four-slots"`; it owns its page segmentation and output stage, so those two overrides must be omitted. Rerun `prelabel` after adding a strategy: `evaluate` uses cached candidates and cannot run a missing strategy itself. The Rakuten production family keeps the whole-image/per-character agreement pair validated on held-out images even if a later grid sweep ranks another configuration higher.

The small First Bank and KGI images also have dark text separated from lighter interference. `firstbank-dark-foreground` requires 67×29, keeps luminance ≤64, resizes 4× with the shared interpolation, and adds a 10px white border. `kgibank-dark-foreground` requires 98×25, keeps luminance ≤96, and resizes 3×. `kgibank-dark-padded` uses the same threshold with 4× resizing and a 10px border. These filters threshold before resizing and skip the generic blur, line removal, and component removal. Other dimensions or a combination with another preprocessing mode produce blank output. A preprocessing mode alone does not authorize production submission; the source must use its calibrated family.

- Coverage is accepted images divided by confirmed images.
- FAR (false-accept rate) is wrong accepted answers divided by accepted images. The output also shows wrong answers divided by all confirmed images.
- Single strategy exact accuracy counts the images where the strategy read the right answer, at any confidence.
- The agreement pairs show how often two strategies gave the same answer, and how often that answer was right.
- Geometry and answer shape show the image sizes, the answer lengths, and the character classes in your labels.

The expected answer length comes from the source when `banks.ts` declares it there. Otherwise it is the most common `maxlength` the page declared, or else the most common length of your labels.

The recommendation is the configuration with the highest coverage among those with a FAR of at most 2% over at least 20 accepted images. Ties go to fewer strategies, then to the higher threshold. With fewer than 20 accepts, a FAR of zero still has a Wilson upper bound above 16%. Evaluate refuses to recommend with fewer than 30 confirmed labels, or when no configuration qualifies, and says which. The recommendation prints:

- A TypeScript family declaration with `charset`, `ocrAttemptPlan`, `solveAcceptancePolicy`, `solverConfidenceThreshold`, and `expectedAnswerLength`.
- A separate constant with `geometry` and `answerPattern`.
- A `CONTEXT.md` family entry.
- The Wilson 95% upper bound of the FAR. Treat it as the worst rate your sample size cannot rule out.

## Use the result in phase 2

Phase 2 turns a recommendation into a production solver for one preview source. `TAISHIN_CAPTCHA_FAMILY`, `MEGA_CAPTCHA_FAMILY`, `RAKUTEN_CAPTCHA_FAMILY`, `FIRSTBANK_CAPTCHA_FAMILY`, `KGIBANK_CAPTCHA_FAMILY`, `OBANK_CAPTCHA_FAMILY`, and `FEIB_CAPTCHA_FAMILY` show the result. O-Bank reuses the Rakuten-named teal and four-slot preprocessing, with its own measured acceptance pair.

1. Copy the recommended declaration, or a configuration you choose from the evaluate output, into a `PreviewCaptchaFamily` in `src/lib/preview-sources/preview-captcha.ts`.
2. Add the family entry to `CONTEXT.md`, and record the measured numbers under `docs/research/`.
3. Pass `calibratedCaptchaSolver(family)` as the source's default `solveCaptcha`, and get the answer through `solveChallengeRound`.

ADR 0039 still applies. A source without a calibrated family must not submit a CAPTCHA answer.
