# 帳目合併 screen recording

An 11–12 second recording of the real desktop app on the Spending page: open a suspected
duplicate → check the match → merge → the totals update. Renders: `renders/octopusbeak-merge-{16x9,9x16}{,-en}.mp4`.

The app runs on disposable demo data, never a real ledger. From the repository root:

```bash
node --no-warnings --experimental-strip-types scripts/seed-spending-demo.ts /tmp/octopusbeak-spending-demo
OCTOPUSBEAK_USER_DATA=/tmp/octopusbeak-spending-demo OCTOPUSBEAK_CDP_PORT=9333 npm run desktop:dev -- --lang=zh-TW --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling
```

Use `--lang=en-US` for the English cut on a freshly seeded profile. A merge cannot be redone, so
stop the app with Ctrl+C in its launch terminal and re-seed before every take. See the
[development lifecycle](../../docs/runbooks/desktop-development.md) for supervised cleanup;
closing the recording's CDP connection does not quit the app.

Then, in this directory:

```bash
node record.mjs                                   # frames/ from the running app over CDP
../octopusbeak-tour-recording/build.sh "$PWD/frames" "$PWD/raw-zh.mp4"
node cards.mjs                                    # cap-zh/: 9:16 background and step captions (CARDS_LANG=en for English)
```

`record.mjs` draws its own pointer, because the CDP screencast carries no OS cursor. The 9:16 cut
places the recording at 1080×608, y=640, over `cap-zh/bg.png`, with caption n shown across its
step. The music is a HeyGen library track (`npx hyperframes media-use resolve --type bgm`), cut
from its tail so the track's own ending lands on the last second, faded and loudness-normalized
to −16 LUFS. It is licensed for use in the published video only and is not committed.
