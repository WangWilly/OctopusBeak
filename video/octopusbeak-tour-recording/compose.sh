#!/bin/sh
# compose.sh <raw.mp4> <captionDir> <outPrefix>: burns the five step captions and the music bed into
# <outPrefix>-16x9.mp4 and <outPrefix>-9x16.mp4. Step windows: 0–6, 6–12, 12–18, 18–24, 24–end (seconds).
set -e
RAW="$1"; CAP="$2"; OUT="$3"
LEN=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$RAW")
BGM=$(ls .media/audio/bgm/*.wav | head -1)
# The track is 37 s; take its tail so its own ending lands on the video's last second.
START=$(python3 -c "print(max(0, 37 - $LEN))")
ffmpeg -v error -y -ss "$START" -t "$LEN" -i "$BGM" -af "afade=t=in:st=0:d=0.4,afade=t=out:st=$(python3 -c "print($LEN - 1.2)"):d=1.2,loudnorm=I=-16:TP=-1.5:LRA=11" -ar 48000 "$OUT-bgm.wav"
WIN="lt(t,6)|between(t,6,12)|between(t,12,18)|between(t,18,24)|gte(t,24)"
chain() { # $1 base label, $2 first caption input index, $3 caption prefix
  i=1; prev="$1"; out=""
  for w in $(echo "$WIN" | tr '|' ' '); do
    n=$(( $2 + i - 1 )); out="$out[$prev][$n]overlay=0:0:enable='$w'[s$3$i];"; prev="s$3$i"; i=$((i+1))
  done
  printf "%s" "$out"
}
F=$(chain v 2 w); WL=sw5
ffmpeg -v error -y -i "$RAW" -i "$OUT-bgm.wav" -loop 1 -i "$CAP/wide-1.png" -loop 1 -i "$CAP/wide-2.png" -loop 1 -i "$CAP/wide-3.png" -loop 1 -i "$CAP/wide-4.png" -loop 1 -i "$CAP/wide-5.png" \
  -filter_complex "[0]null[v];$F[$WL]format=yuv420p[o]" -map "[o]" -map 1:a -t "$LEN" -c:v libx264 -preset slow -crf 17 -c:a aac -b:a 192k -movflags +faststart "$OUT-16x9.mp4"
F=$(chain v 3 t); TL=st5
ffmpeg -v error -y -loop 1 -i "$CAP/tall-bg.png" -i "$RAW" -i "$OUT-bgm.wav" -loop 1 -i "$CAP/tall-1.png" -loop 1 -i "$CAP/tall-2.png" -loop 1 -i "$CAP/tall-3.png" -loop 1 -i "$CAP/tall-4.png" -loop 1 -i "$CAP/tall-5.png" \
  -filter_complex "[1]scale=1080:608:flags=lanczos[r];[0][r]overlay=0:640:shortest=1[v];$F[$TL]fps=30,format=yuv420p[o]" -map "[o]" -map 2:a -t "$LEN" -c:v libx264 -preset slow -crf 18 -c:a aac -b:a 192k -movflags +faststart "$OUT-9x16.mp4"
rm "$OUT-bgm.wav"
