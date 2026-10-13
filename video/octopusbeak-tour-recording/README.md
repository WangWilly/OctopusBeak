# 總覽 → 明細 screen recording

A 32-second recording of the real desktop app, five steps with captions: 總覽 (net worth) →
資產配置 → 資產 → 台北富邦 account → one transaction (10/06 全聯 TWD 1,286) → its source.
Renders: `renders/octopusbeak-tour-{zh,en}-{16x9,9x16}.mp4`.

The app has no per-transaction source view and no bank statement view (statements exist for
credit cards only), so step 5 switches on camera to the account's 歷史 view: the bank-reported
balance snapshot ("與回推結果一致") and the same transaction with its running balance.

The app runs on disposable demo data, never a real ledger. From the repository root:

```bash
node --no-warnings --experimental-strip-types scripts/seed-app-demo.ts /tmp/octopusbeak-spending-demo
OCTOPUSBEAK_USER_DATA=/tmp/octopusbeak-spending-demo OCTOPUSBEAK_CDP_PORT=9333 npm run desktop:dev -- --lang=zh-TW --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling
```

Keep the three `--disable-*` flags: without them a background window renders no frames. For the
English cut, set `localStorage["octopusbeak-locale"] = "en"` and reload (the profile remembers
the last locale). After recording, stop the demo app with Ctrl+C in its launch terminal.
The [development supervisor](../../docs/runbooks/desktop-development.md) cleans only that
launch's process group; closing the recording's CDP connection does not quit the app.

Then, in this directory (`TOUR_LANG=en` / `CAPTION_LANG=en` for English):

```bash
node record.mjs                                   # frames/ from the running app over CDP
./build.sh "$PWD/frames" "$PWD/raw-zh.mp4" 32     # constant 30 fps, last frame held to 32 s
node captions.mjs                                 # cap-zh/: 16:9 pills, 9:16 background and step cards
npx hyperframes media-use resolve --type bgm --intent "calm confident minimal tech underscore, at least 35 seconds, clean ending" --project .
./compose.sh raw-zh.mp4 cap-zh renders/octopusbeak-tour-zh
```

The music is a HeyGen library track, licensed for use in the published video only and not committed.
