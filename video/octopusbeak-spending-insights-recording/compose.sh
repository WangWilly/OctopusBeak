#!/bin/sh
# compose.sh <raw.mp4> <captionDir> <outPrefix>: 16:9 with lower pills, and a 9:16 cut whose 1080×1080 window
# pans across the recording to follow the step being shown. Step windows come from record.mjs marks.
set -e
cd "$(dirname "$0")"
RAW="$1"; CAP="$2"; OUT="$3"
LEN=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$RAW")
BGM=$(ls .media/audio/bgm/*.wav | head -1); BGMLEN=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$BGM")
ffmpeg -v error -y -ss "$(python3 -c "print(max(0, $BGMLEN - $LEN))")" -t "$LEN" -i "$BGM" -af "afade=t=in:st=0:d=0.4,afade=t=out:st=$(python3 -c "print($LEN - 1.3)"):d=1.3,loudnorm=I=-16:TP=-1.5:LRA=11" -ar 48000 "$OUT-bgm.wav"
# Step windows (s): 1 summary, 2 pace chart, 3 twelve months, 4 categories, 5 automatic sync.
S="0 4.4 12.4 20.0 28.2"
W="lt(t,4.4) between(t,4.4,12.4) between(t,12.4,20.0) between(t,20.0,28.2) gte(t,28.2)"
chain() { i=1; prev="$1"; out=""; for w in $W; do n=$(( $2 + i - 1 )); out="$out[$prev][$n]overlay=0:0:enable='$w'[s$3$i];"; prev="s$3$i"; i=$((i+1)); done; printf "%s" "$out"; }
F=$(chain v 2 w)
ffmpeg -v error -y -i "$RAW" -i "$OUT-bgm.wav" -loop 1 -i "$CAP/wide-1.png" -loop 1 -i "$CAP/wide-2.png" -loop 1 -i "$CAP/wide-3.png" -loop 1 -i "$CAP/wide-4.png" -loop 1 -i "$CAP/wide-5.png" \
  -filter_complex "[0]null[v];$F[sw5]format=yuv420p[o]" -map "[o]" -map 1:a -t "$LEN" -c:v libx264 -preset slow -crf 17 -c:a aac -b:a 192k -movflags +faststart "$OUT-16x9.mp4"
# Camera for 9:16: a 960 px square crop of the 1920×1080 recording, panned between per-step centres over 0.8 s.
CROPX=$(python3 - <<'PY'
keys = [(0, 460), (4.4, 280), (12.4, 940), (20.0, 900), (23.6, 420), (28.2, 940)]  # (time, left edge)
expr = str(keys[-1][1])
for (t0, x0), (t1, x1) in reversed(list(zip(keys, keys[1:]))):
    expr = f"if(lt(t,{t1}),{x0},if(lt(t,{t1 + 0.8}),{x0}+({x1}-{x0})*(0.5-0.5*cos(PI*(t-{t1})/0.8)),{expr}))"
print(expr)
PY
)
CROPY="if(lt(t,28.2),60,if(lt(t,29.0),60-60*(0.5-0.5*cos(PI*(t-28.2)/0.8)),0))"
F=$(chain v 3 t)
ffmpeg -v error -y -loop 1 -i "$CAP/tall-bg.png" -i "$RAW" -i "$OUT-bgm.wav" -loop 1 -i "$CAP/tall-1.png" -loop 1 -i "$CAP/tall-2.png" -loop 1 -i "$CAP/tall-3.png" -loop 1 -i "$CAP/tall-4.png" -loop 1 -i "$CAP/tall-5.png" \
  -filter_complex "[1]crop=w=960:h=960:x='$CROPX':y='$CROPY',scale=1080:1080:flags=lanczos[r];[0][r]overlay=0:430:shortest=1[v];$F[st5]fps=30,format=yuv420p[o]" \
  -map "[o]" -map 2:a -t "$LEN" -c:v libx264 -preset slow -crf 18 -c:a aac -b:a 192k -movflags +faststart "$OUT-9x16.mp4"
rm "$OUT-bgm.wav"
