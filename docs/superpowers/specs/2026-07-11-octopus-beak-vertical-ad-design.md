# Octopus Beak 30-Second Vertical Ad Design

**Date:** 2026-07-11  
**Status:** Approved for planning  
**Audience:** Busy Taiwanese office workers  
**Call to action:** 前往網站，了解 Octopus Beak

## Goal

Create a 30-second, 9:16 promotional video that makes a busy office worker feel they can understand their daily finances without manually switching between financial services. The video promotes the existing Electron desktop app; it is formatted for mobile viewing but must not suggest that Octopus Beak is a mobile app.

## Selected Creative Direction

The narrative route is **A — 「一天的錢，去哪了？」**. It begins with the cost of fragmented financial information, then shows the app collecting it into one clear view.

The visual route is **B — 高速解答**:

- Purple, magenta, and coral-orange gradients on a dark base.
- Large, kinetic Traditional Chinese type and rapid, intentional cuts.
- Upbeat instrumental music only; no voiceover.
- Realistic desktop-product framing inside a vertical mobile-ad composition.

Alternatives considered and not selected:

- A calm, data-led blue treatment: more reassuring, but less immediately energetic in a 30-second placement.
- A warm lifestyle treatment: human and approachable, but weaker at communicating automation speed.
- A "下班前 30 秒" or "不用再切換 App" narrative: viable, but the selected direct question better earns attention before the feature reveal.

## Timed Storyboard and On-Screen Copy

| Time | Visual | Exact on-screen copy |
| --- | --- | --- |
| 0–3s | Account, credit-card, brokerage, and invoice windows stack and interrupt one another. | 一天的錢，去哪了？ |
| 3–7s | The fragmented windows cut quickly between balances, transaction lists, and invoice records. | 帳戶。投資。消費。發票。 |
| 7–11s | Those sources connect into a framed Octopus Beak desktop window; connection indicators resolve. | 自動整合線上帳戶資料 |
| 11–15s | A daily balance card, inflow/outflow chart, and change indicator assemble into one overview. | 今天，多了多少？<br>花到哪裡？ |
| 15–19s | Taiwan e-invoice records flow into a spending-category visualization. | 發票消費，自動看懂 |
| 19–23s | Investment positions and daily movement animate into the same dashboard. | 投資變化，也不漏看 |
| 23–27s | The account, cash-flow, invoice-spending, and investment cards converge into a clean overview. | 30 秒，看清你的錢 |
| 27–30s | The desktop app remains clearly framed while the brand and website CTA hold on screen. | 前往網站，了解 Octopus Beak |

## Deliverables

1. A deterministic HyperFrames composition at 1080×1920, 30 fps, and exactly 30 seconds.
2. Five generated 9:16 visual reference images: fragmented-finance stress, account integration, cash flow, Taiwan e-invoice spending, and investment/CTA.
3. Final typography, data labels, figures, and CTA rendered in HyperFrames rather than generated into images. This preserves legible Traditional Chinese and exact product copy.

## Production Constraints

- Use representative, non-user financial figures only; do not depict or expose actual account data.
- Keep all essential copy inside a mobile-safe central area and show the final CTA continuously from 27–30 seconds.
- Frame the product as a desktop window throughout product shots, with no phone-native navigation or app-store language.
- Generated references provide lighting, composition, people, devices, and abstract data atmosphere. They contain no required readable text, logos, or final figures.
- Music should rise during the 0–23 second acceleration, resolve as the overview converges at 23–27 seconds, then leave the CTA unobscured at 27–30 seconds.

## Composition Structure

The composition has eight sequential scenes corresponding to the storyboard rows. Each scene accepts a fixed local time range and hands off through opacity, scale, and positional transforms. The product-dashboard frame and the final copy are shared visual assets, not separate app states.

The source flow is: generated reference image → composited scene background or transitional texture → deterministic HyperFrames motion → exact text and mock financial data overlays. This keeps generative material decorative and makes the commercial’s claims and call to action controllable.

## Validation

- Render a full 30-second preview and verify first and final frames.
- Seek to each scene boundary (0, 3, 7, 11, 15, 19, 23, 27, and 30 seconds) to check timing, legibility, and transition completion.
- Check a 9:16 mobile preview for safe-zone cropping and CTA readability.
- Verify that every product shot reads as desktop software and that no generated reference image contains required copy.
