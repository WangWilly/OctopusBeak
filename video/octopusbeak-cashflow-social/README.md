# OctopusBeak 收支流水 promo (9:16 social)

The 1080×1920 social cut of [`../octopusbeak-cashflow`](../octopusbeak-cashflow/README.md), for IG
Reels, Threads, YouTube Shorts and TikTok, in zh-TW and English. Same concept, numbers, strings and
scene timings as the 16:9 film (so the same music and sound-effect cues), re-laid out: the river
flows top to bottom, readable content stays inside y 200–1560, and the proof shot adds the real
帳戶淨變動 card under the main card.

| Path | What it is |
| --- | --- |
| `STORYBOARD.md` | The vertical layout; everything else is in the 16:9 project's `BRIEF.md` and `STORYBOARD.md` |
| `generators/` | `hook-close/gen.mjs` writes 01-hook and 03-close, `river/gen.cjs` writes 02-river, both languages |
| `compositions/frames/`, `compositions/frames-en/` | Generated zh-TW and English compositions |

Edit the generators, then from this directory:

```bash
node generators/hook-close/gen.mjs && node generators/river/gen.cjs
npx hyperframes check
npx hyperframes render --quality high --output renders/cashflow-zh-9x16.mp4
sed -i '' 's#compositions/frames/#compositions/frames-en/#g' index.html
npx hyperframes render --quality high --output renders/cashflow-en-9x16.mp4
sed -i '' 's#compositions/frames-en/#compositions/frames/#g' index.html
```

`assets/` is a copy of the 16:9 project's; the music and sound effects are fetched the same way
(see its README) and are not committed.
