# OctopusBeak 多帳戶盤點 promo

A 30-second vertical (1080×1920) promo for Reels, Shorts, Threads, and TikTok, built with
[HyperFrames](https://hyperframes.heygen.com). It takes the angle 「薪轉一間、繳卡費一間、買股票又一間。
你要確認自己有多少錢，得打開幾個 App？」 and turns the question into a sum: app tiles pile up while an
opened-apps counter climbs, then drop into a vertical addition whose amounts are all 「?」 until
OctopusBeak rolls them into real numbers and lands the total, TWD 2,148,216.

| Path | What it is |
| --- | --- |
| `BRIEF.md` | The confirmed brief and the chosen concept |
| `STORYBOARD.md` | Six frames with timed shot sequences and the shared ledger geometry |
| `compositions/frames/` | The zh-TW frames |
| `compositions/frames-en/` | The English frames: same timing and layout, translated text |
| `audio_meta.json` | Music bed and the 39 timed sound-effect cues |

The amounts come from the app screenshots in `assets/` (assets 3,479,538 − liabilities
1,331,322 = net worth 2,148,216); keep them in step if the screenshots change.

## Render

The music bed and sound effects are HeyGen library media, licensed for use inside the
published video but not for redistribution, so they are not committed. Fetch them with
`heygen auth login --oauth`, then from this directory:

```bash
node ~/.claude/skills/product-launch-video/scripts/audio.mjs --storyboard ./STORYBOARD.md --hyperframes . --out ./audio_meta.json
node ~/.claude/skills/product-launch-video/scripts/audio.mjs fetch-sfx --storyboard ./STORYBOARD.md --hyperframes .
git checkout audio_meta.json
```

The last command restores the committed cue timings, which `audio.mjs` overwrites.

`index.html` points at the zh-TW frames. Render each cut, switching the frame folder for
the English one:

```bash
npx hyperframes render --quality high --output renders/video-zh.mp4
sed -i '' 's#compositions/frames/#compositions/frames-en/#g' index.html
npx hyperframes render --quality high --output renders/video-en.mp4
git checkout index.html
```

Encode a social upload (about 25 MB) from each master:

```bash
ffmpeg -i renders/video-zh.mp4 -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 192k renders/octopusbeak-accounts-zh.mp4
```
