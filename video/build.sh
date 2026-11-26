#!/usr/bin/env bash
# Render the Nusantara trailer: capture frames from the live app, synthesise
# the soundtrack, then encode 1080p30 H.264 + AAC (web-ready, faststart).
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules ] || npm install --silent
node capture.mjs
python3 -I music.py
mkdir -p out
ffmpeg -v error -y -framerate 30 -i frames/%05d.jpg -i music.wav \
  -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -tune animation \
  -af "loudnorm=I=-16:TP=-1.5:LRA=11" -c:a aac -b:a 192k \
  -shortest -movflags +faststart out/nusantara-trailer.mp4
# poster image for players / social cards (frame from the advisors shot)
ffmpeg -v error -y -i out/nusantara-trailer.mp4 -ss 37.5 -frames:v 1 -q:v 2 out/nusantara-poster.jpg
ls -lh out/
