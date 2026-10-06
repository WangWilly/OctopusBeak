# OctopusBeak intro video

The 30-second motion graphic behind the landing page's 觀看介紹 card and modal, built with
[HyperFrames](https://hyperframes.heygen.com). One take follows a single TWD 1,444 charge from
its e-invoice and card statement, through 帳目合併, to the month's spending and the overview.

| File | What it holds |
|---|---|
| `BRIEF.md` | The confirmed brief: message, audience, length, concept |
| `STORYBOARD.md` | Six frames with timed shot sequences and the numeric handoffs between them |
| `frame.md` | The design system (cartesian preset remapped onto the site's brand tokens) |
| `compositions/frames/` | The zh-Hant frames |
| `compositions/frames-en/` | The English frames; the string table is `EN-STRINGS.md` |
| `assets/` | Reference plates exported from the Pencil design, site images, the banknote engraving defs |

## Update the site's videos

```bash
npm run site-video
```

This renders both cuts, encodes each to 720p H.264 with a poster frame, and writes
`site/assets/octopusbeak-demo{,-en}.mp4` and `…-poster.webp`. Pass `-- --out <dir>` to write
them somewhere else first. Everything under `renders/` is regenerated and not committed.

Preview while editing with `npx hyperframes preview --background`, and run `npm run check`
after changing a frame.

## Music

The bed is a HeyGen library track, licensed for use inside the published video but not for
redistribution, so `assets/bgm/` is not committed. To restore it, sign in with
`heygen auth login --oauth`, then:

```bash
node ~/.claude/skills/product-launch-video/scripts/audio.mjs --storyboard ./STORYBOARD.md --hyperframes . --out ./audio_meta.json
ffmpeg -ss 7 -t 30 -i assets/bgm/track.mp3 -af "afade=t=in:st=0:d=0.4,afade=t=out:st=28.5:d=1.5" -c:a libmp3lame -q:a 2 assets/bgm/track-30s.mp3
```

The retrieval query is the storyboard's `music:` line, recorded with the original pick in
`.media/manifest.jsonl` (`bgm_001`). The 7-second offset lands the track's own ending on the
video's last frame. A fresh retrieval may return a different track; check its loudness by
section before reusing that offset. Afterwards set `bgm.path` in `audio_meta.json` back to
`assets/bgm/track-30s.mp3`.
