#!/bin/sh
# Turns a frames dir (from record.mjs) into a constant-30fps 1080p MP4: build.sh <framesDir> <out.mp4> [totalSeconds]
# The screencast sends no frames while the screen is still, so the last frame is held to totalSeconds.
set -e
python3 - "$1" "${3:-0}" > "$1/concat.txt" <<'PY'
import json, sys
d = sys.argv[1].rstrip("/")
ts = json.load(open(f"{d}/timestamps.json"))
tail = max(0.5, float(sys.argv[2]) - (ts[-1] - ts[0]))
for i, t in enumerate(ts):
    print(f"file '{d}/f{i:05d}.jpg'\nduration {max(0.001, (ts[i+1]-t) if i+1 < len(ts) else tail):.4f}")
print(f"file '{d}/f{len(ts)-1:05d}.jpg'")
PY
ffmpeg -v error -y -f concat -safe 0 -i "$1/concat.txt" -vf "scale=1920:1080:flags=lanczos,fps=30,format=yuv420p" ${3:+-t $3} -c:v libx264 -preset slow -crf 16 -movflags +faststart "$2"
