# 消費洞察 screen recording

A 34-second recording of the real desktop app's Spending page on demo data: this month against the
last three (本月累積走勢 with its day-by-day tooltip), the 近 12 個月 chart and month-end estimate,
the category breakdown and filter, and the refresh control that syncs it all. Renders:
`renders/octopusbeak-spending-insights-{zh,en}-{16x9,9x16}.mp4`. The 9:16 cut pans a 1080×1080
window across the recording to follow each step, so the charts read at about twice the size.

From the repository root (`DEMO_TODAY` moves the demo month forward; purchases run through 10/13):

```bash
DEMO_TODAY=2026-10-14 node --no-warnings --experimental-strip-types scripts/seed-spending-demo.ts /tmp/octopusbeak-spending-demo
OCTOPUSBEAK_USER_DATA=/tmp/octopusbeak-spending-demo OCTOPUSBEAK_CDP_PORT=9333 npm run desktop:dev -- --lang=zh-TW --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling
```

Then, in this directory (for English, set `localStorage["octopusbeak-locale"] = "en"`, reload, and
use `FRAMES_DIR=$PWD/frames-en/` and `CAPTION_LANG=en`):

```bash
node record.mjs
../octopusbeak-tour-recording/build.sh "$PWD/frames" "$PWD/raw-zh.mp4" 34
node captions.mjs
npx hyperframes media-use resolve --type bgm --intent "calm confident minimal tech underscore, at least 45 seconds, clean ending" --project .
./compose.sh raw-zh.mp4 cap-zh renders/octopusbeak-spending-insights-zh
```

The step windows in `compose.sh` and the 9:16 pan keyframes match the timings `record.mjs` holds to.
The music is a HeyGen library track, licensed for the published video only and not committed.
