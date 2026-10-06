# OctopusBeak social promo

A 30-second vertical (1080×1920) promo for Reels, Shorts, Threads, and TikTok, built with
[HyperFrames](https://hyperframes.heygen.com). The film is a bank passbook: twelve bank logos
are swallowed by the passbook cover, and each page prints one step of how the app works
(設定一次 → 一鍵同步 → 一頁看清) before the book closes on the privacy promise and the brand.

| Path | What it is |
| --- | --- |
| `BRIEF.md` | The confirmed brief and the chosen concept |
| `STORYBOARD.md` | Six frames with timed shot sequences and the shared passbook geometry |
| `compositions/frames/` | The zh-TW frames |
| `compositions/frames-en/` | The English frames: same timing and layout, translated text |
| `audio_meta.json` | Music bed and the 38 timed sound-effect cues |

## Render

The music bed and sound effects are HeyGen library media, licensed for use inside the
published video but not for redistribution, so they are not committed. Fetch them with
`heygen auth login --oauth`, then from this directory:

```bash
node ~/.claude/skills/product-launch-video/scripts/audio.mjs --storyboard ./STORYBOARD.md --hyperframes . --out ./audio_meta.json
```

`audio.mjs` rewrites `audio_meta.json`; restore the committed cue timings with
`git checkout audio_meta.json` afterwards.

`index.html` points at the zh-TW frames. Render each cut, switching the frame folder for
the English one:

```bash
npx hyperframes render --quality high --output renders/video-zh.mp4
sed -i '' 's#compositions/frames/#compositions/frames-en/#g' index.html
npx hyperframes render --quality high --output renders/video-en.mp4
git checkout index.html
```

Encode a social upload (about 19 MB) from each master:

```bash
ffmpeg -i renders/video-zh.mp4 -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 192k renders/octopusbeak-social-zh.mp4
```
