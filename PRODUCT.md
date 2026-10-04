# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The desktop app is an Electron shell around a SvelteKit static renderer (`src/`), so its design language is web, not native macOS. The marketing site (`site/`) is a separate static page.

## Users

Individuals in Taiwan who manage their own money across several local institutions: bank deposits, credit cards, loans, brokerage, funds, foreign currency, crypto (MAX / MaiCoin), and e-invoices. They want one private, complete view of their finances on their own Mac, and they're willing to install a beta desktop app and complete the occasional CAPTCHA or OTP step.

## Product Purpose

OctopusBeak signs in to the user's financial service websites, downloads their statements, and turns them into a local ledger. Assets, liabilities, and spending then sit in one overview. Success means the user can open the app, see an accurate, current picture of their finances, and trust every figure in it without re-checking each bank.

## Positioning

These two commitments are what set it apart. Future work must protect both:

1. **Local-only privacy.** Ledger data, automation settings, credentials, and run summaries all stay on the user's Mac. Credentials are encrypted with Electron `safeStorage`, and the app refuses to start rather than store them in plaintext. Source downloads, generated CSV/JSON files, and raw logs are processed in memory and never persisted; structured run events are kept for 30 days. CAPTCHA, OTP, session cookies, and other verification material are never handed to a model.
2. **Every number is traceable** (每個數字都查得到出處). Any figure can be followed back to the source statement or transaction it came from, through source-scoped lineage and strict canonical admission (see ADR 0008 and ADR 0035).

## Operating Context

- First run: a genuinely new, empty user sees a resumable, swipe-through First-run Welcome. It keeps the chosen language and current slide across restarts, and it ends when the user explicitly chooses whether to begin bank automation. Existing data or onboarding state skips it.
- Onboarding progression: a guided sequence that walks the user through configuring a source, collecting and importing statements, and confirming the overview. While active, it controls app navigation. The user leaves through an explicit Onboarding Exit, which restores normal navigation and lets any already-started collection run finish. Exited onboarding can't be resumed. An Onboarding Restart from Settings begins a fresh progression that keeps sign-in details, source selections, and imported data, and cancels any still-running workflow from the exited progression. Restart never includes the First-run Welcome.
- Collection: the app drives real institution websites. When a site requires CAPTCHA or OTP, the user completes it in a window; some CAPTCHAs are solved by local models (ADR 0012, 0013).
- Review: Overview (assets, liabilities, daily snapshot history, allocation), Assets (grouped by bank, fund, broker, crypto, and foreign currency, with balance trends and drill-down to transactions or holdings), Spending (e-invoices plus account spending, grouped by month and category, with editable classification), and Automation (sources, credentials, run history, human assistance).

## Capabilities and Constraints

- Distributed only for macOS Apple Silicon (arm64), as a DMG or ZIP with `SHA256SUMS.txt`. Windows, Linux, and Intel Macs are not supported.
- Beta. Supported sources: Fubon, E.SUN, Yuanta Bank, Yuanta Securities, Cathay United, Hua Nan, CTBC, Chunghwa Post, SinoPac, LINE Bank, E-Invoice, and MAX / MaiCoin. The source-by-data-type matrix lives in `README.md`. More sources are added over time.
- The local store is PGlite (ADR 0030). Domain vocabulary lives in `CONTEXT.md`; decisions are recorded in `docs/adr/`.
- Production workflows run only from the desktop app. The CLI is for developing workflows against fixtures.

## Brand Commitments

- Name: **OctopusBeak**. Existing assets: `docs/assets/octopusbeak-readme-banner.webp` and `static/favicon.webp`.
- Voice: plain, factual, reassuring about data handling. It says exactly what the app does and doesn't do, with no hype. Traditional Chinese copy reads as natural Taiwanese usage.

## Evidence on Hand

- Real product screenshots in both locales: `docs/assets/readme-{overview,assets,spending,automation-settings}-{zh,en}.png`.
- Site design references: `docs/assets/octopusbeak-site-*.png|jpg`, `docs/assets/onboarding-precision-spotlight.png`.
- No testimonials, user counts, press, security audits, or certifications exist. Do not invent any.

## Product Principles

1. **Your data never leaves the Mac.** No feature, integration, or design may imply cloud sync or remote processing that does not exist.
2. **Show the source.** A number without a traceable origin is a defect, and UI should make provenance reachable.
3. **Be honest when a person is needed.** When a site requires CAPTCHA or OTP, say so plainly and guide the user through it. Never hide the step or pretend it was automated.
4. **Fail closed.** If something can't be done safely (encryption, integrity checks, admission), stop and explain why rather than degrading silently.

## Accessibility & Inclusion

- Traditional Chinese (zh-TW) is the primary language. English (en) must stay at full parity on every surface. Layouts must handle both CJK and Latin text lengths.
- No formal accessibility standard (such as WCAG level) has been adopted yet.
