# 登入與同步 screen recording

A ~40-second recording of a real sync: pick 台北富邦銀行 in 登入資料, run one login and sync (the
waiting is fast-forwarded ×30 and labelled), then show the organized account and its transactions.
Renders: `renders/octopusbeak-sync-{16x9,9x16}{,-en}.mp4`.

Unlike the other recordings this one uses a **real profile and a real bank login**, because demo data
cannot sync. Treat it accordingly:

- Login values, passwords and CAPTCHAs never appear on screen: the sync runs in the App's headless
  browser. `record.mjs` still blurs the masked login fields, every amount, account numbers, dialog
  titles with account digits, and transaction descriptions (they can carry names) inside the page.
- Every take is one login to the bank. Frequent logins can fail verification (a take on 2026-10-13
  failed with `verification-failed` minutes after two earlier logins). Do not retry in a loop.
- Delete `frames/` and `frames-step3/` after editing; they hold the blurred recording of real data.
- Start the App with remote debugging only for the recording, then quit that process by its PID.

```bash
OCTOPUSBEAK_CDP_PORT=9333 npm run desktop:dev -- --lang=zh-TW --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling
node record.mjs          # full take: one real sync (about 4 minutes for deposit, card and loan)
node record-step3.mjs    # optional: re-take step 3 alone, without syncing
node captions.mjs        # cap-zh/ (CAP_LANG=en → cap-en/)
npx hyperframes media-use resolve --type bgm --intent "calm confident minimal tech underscore, at least 45 seconds, clean ending" --project .
./edit.sh zh             # or: ./edit.sh en
```

`edit.sh` expects both `frames/` and `frames-step3/`; record step 3 separately if the full take's
step 3 is unusable. The music is a HeyGen library track, licensed for the published video only.
