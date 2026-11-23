# OctopusBeak 收支流水 promo (16:9)

A 31-second 1920×1080 motion graphic for the Cash flow page, in zh-TW and English, built with
[HyperFrames](https://hyperframes.heygen.com). Concept 「錢的河流」: October's money as one river drawn
as realistic flowing water (a WebGL flowmap shader in `generators/river/template.html`). Salary flows in, transfers between your own accounts loop out and lift
away as not counted, outflow splits into category tributaries, and what stays pools as 留下來. The
river then flattens into the page's real flow bar and the real screen lands on top of it. The 9:16
social cut is [`../octopusbeak-cashflow-social`](../octopusbeak-cashflow-social/README.md).

| Path | What it is |
| --- | --- |
| `BRIEF.md` | The brief and every number in the film, with where it comes from |
| `STORYBOARD.md` | Three compositions with timed scenes and the shared geometry |
| `generators/` | The source of the frames: `hook-close/gen.mjs` writes 01-hook and 03-close, `river/gen.cjs` writes 02-river, both languages |
| `compositions/frames/`, `compositions/frames-en/` | Generated zh-TW and English compositions; they differ only in their `STR` strings |
| `capture/shoot.mjs` | Captures the real Cash flow page from the demo app (`capture/cashflow-*.txt` holds its text) |
| `assets/app/` | Crops of the real page used for the proof shot |

## Numbers

Every amount is the demo ledger's October on the real Cash flow page (10/01–10/31): 流入 86,912,
流出 43,744, 留下來 43,168 (50%), transfers not counted 30,000 + 32,064 + 24,040. To capture it
again, from the repository root:

```bash
node --no-warnings --experimental-strip-types scripts/seed-app-demo.ts /tmp/octopusbeak-demo
OCTOPUSBEAK_USER_DATA=/tmp/octopusbeak-demo OCTOPUSBEAK_CDP_PORT=9333 npm run desktop:dev -- --lang=zh-TW --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling
```

Then in `capture/`: `node shoot.mjs` and `SHOT_LANG=en node shoot.mjs`. The script picks 自訂 →
上個月, so run it in November 2026 or change the range. If the numbers change, update `BRIEF.md`,
the `STR` tables in `generators/`, and the crops in `assets/app/`.

## Edit and render

Edit the generators, not the generated compositions. From this directory:

```bash
node generators/hook-close/gen.mjs && node generators/river/gen.cjs
npx hyperframes check
```

The music bed and sound effects are HeyGen library media, licensed for use inside the published
video but not for redistribution, so they are not committed. Fetch them with
`npx hyperframes auth login`, then resolve the queries recorded in `.media/manifest.jsonl` with
`npx hyperframes media-use resolve` and copy them to `assets/bgm/track.wav` and `assets/sfx/`
under the file names `index.html` uses. The music starts at the track's 15-second mark.

`index.html` points at the zh-TW frames. Render each cut:

```bash
npx hyperframes render --quality high --output renders/cashflow-zh-16x9.mp4
sed -i '' 's#compositions/frames/#compositions/frames-en/#g' index.html
npx hyperframes render --quality high --output renders/cashflow-en-16x9.mp4
sed -i '' 's#compositions/frames-en/#compositions/frames/#g' index.html
```
