#!/bin/sh
# edit.sh <zh|en>: cuts frames/ (full take) and frames-step3/ into one video, fast-forwards the sync ×30,
# and burns captions and music into renders/octopusbeak-sync-{16x9,9x16}[-en].mp4.
set -e
cd "$(dirname "$0")"
LANG_TAG="$1"; SUFFIX=""; CAP=cap-zh; [ "$LANG_TAG" = en ] && SUFFIX="-en" && CAP=cap-en
FAST=30
python3 - "$FAST" <<'PY'
import json, sys
fast = float(sys.argv[1])
A = json.load(open("frames/timestamps.json")); m = json.load(open("frames/marks.json")); B = json.load(open("frames-step3/timestamps.json"))
rel = lambda w: w - m["start"]
sync, synced = rel(m["sync"]), rel(m["synced"])
def seg(name, d, ts, lo, hi):
    idx = [i for i, t in enumerate(ts) if lo <= t - ts[0] < hi]
    with open(f"{name}.txt", "w") as f:
        for j, i in enumerate(idx):
            nxt = ts[idx[j + 1]] if j + 1 < len(idx) else ts[0] + hi
            f.write(f"file '{d}/f{i:05d}.jpg'\nduration {nxt - ts[i]:.4f}\n")
        f.write(f"file '{d}/f{idx[-1]:05d}.jpg'\n")
    return hi - lo
d1 = seg("seg-a1", "frames", A, 0, sync + 8.0)              # pick the source, start the sync, 8 s of 登入中
d2 = seg("seg-a2", "frames", A, sync + 8.0, synced - 0.5)   # the rest of the sync, sped up below
d3 = seg("seg-a3", "frames", A, synced - 0.5, synced + 3.2)  # 已完成 with the new timestamp
d4 = seg("seg-b", "frames-step3", B, 1.0, B[-1] - B[0] + 1.0)
w = {"sync": sync, "fast_start": d1, "fast_end": d1 + d2 / fast, "step3": d1 + d2 / fast + d3, "total": d1 + d2 / fast + d3 + d4}
json.dump(w, open("windows.json", "w")); print(w)
PY
for s in seg-a1 seg-a2 seg-a3 seg-b; do
  PTS="(PTS-STARTPTS)"; [ $s = seg-a2 ] && PTS="(PTS-STARTPTS)/$FAST"
  ffmpeg -v error -y -f concat -safe 0 -i $s.txt -vf "setpts=$PTS,scale=1920:1080:flags=lanczos,fps=30,format=yuv420p" -c:v libx264 -preset slow -crf 16 $s.mp4
done
printf "file 'seg-a1.mp4'\nfile 'seg-a2.mp4'\nfile 'seg-a3.mp4'\nfile 'seg-b.mp4'\n" > segs.txt
ffmpeg -v error -y -f concat -safe 0 -i segs.txt -c copy raw.mp4
eval "$(python3 -c "import json; w=json.load(open('windows.json')); print(' '.join(f'{k.upper()}={v:.2f}' for k,v in w.items()))")"
BGM=$(ls .media/audio/bgm/*.wav | head -1); BGMLEN=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$BGM")
ffmpeg -v error -y -ss "$(python3 -c "print(max(0, $BGMLEN - $TOTAL))")" -t "$TOTAL" -i "$BGM" -af "afade=t=in:st=0:d=0.4,afade=t=out:st=$(python3 -c "print($TOTAL - 1.3)"):d=1.3,loudnorm=I=-16:TP=-1.5:LRA=11" -ar 48000 bgm.wav
W1="lt(t,$SYNC)"; W2="between(t,$SYNC,$STEP3)"; W3="gte(t,$STEP3)"; WF="between(t,$FAST_START,$FAST_END)"
mkdir -p renders
ffmpeg -v error -y -i raw.mp4 -i bgm.wav -loop 1 -i $CAP/wide-1.png -loop 1 -i $CAP/wide-2.png -loop 1 -i $CAP/wide-3.png -loop 1 -i $CAP/wide-fast.png -loop 1 -i $CAP/wide-note.png \
  -filter_complex "[0][2]overlay=0:0:enable='$W1'[a];[a][3]overlay=0:0:enable='$W2'[b];[b][4]overlay=0:0:enable='$W3'[c];[c][5]overlay=0:0:enable='$WF'[d];[d][6]overlay=0:0,format=yuv420p[o]" \
  -map "[o]" -map 1:a -t "$TOTAL" -c:v libx264 -preset slow -crf 17 -c:a aac -b:a 192k -movflags +faststart "renders/octopusbeak-sync-16x9$SUFFIX.mp4"
ffmpeg -v error -y -loop 1 -i $CAP/tall-bg.png -i raw.mp4 -i bgm.wav -loop 1 -i $CAP/tall-1.png -loop 1 -i $CAP/tall-2.png -loop 1 -i $CAP/tall-3.png -loop 1 -i $CAP/tall-fast.png \
  -filter_complex "[1]scale=1080:608:flags=lanczos[r];[0][r]overlay=0:640:shortest=1[v];[v][3]overlay=0:0:enable='$W1'[a];[a][4]overlay=0:0:enable='$W2'[b];[b][5]overlay=0:0:enable='$W3'[c];[c][6]overlay=0:0:enable='$WF',fps=30,format=yuv420p[o]" \
  -map "[o]" -map 2:a -t "$TOTAL" -c:v libx264 -preset slow -crf 18 -c:a aac -b:a 192k -movflags +faststart "renders/octopusbeak-sync-9x16$SUFFIX.mp4"
rm -f seg-*.txt seg-*.mp4 segs.txt bgm.wav
