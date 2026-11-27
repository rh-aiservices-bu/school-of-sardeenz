#!/bin/sh
# Every Gigabyte: one-command build. Needs the Lemo-Opuscar library (core + voice tiers) and ffmpeg 7+.
#   LIB=/path/to/lemo-opuscar sh build.sh
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=${LIB:-$HOME/lemo-opuscar}
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the Lemo-Opuscar library folder"; exit 1; }
cd "$LIB"
[ -f "$HERE/voices/l01.wav" ] || "$LIB/.venv/bin/python" core/tts/tts.py "$HERE/voice/lines.json" "$HERE/voices"
node core/render/events.mjs "$HERE"
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
"$LIB/.venv/bin/python" "$HERE/mix.py"
"$LIB/.venv/bin/python" "$HERE/tools/srt.py"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/out/master.mp4" 24 0
# the page draws paper grain into every frame, so the master is large: re-encode the picture for the repository
ffmpeg -loglevel error -y -i "$HERE/out/master.mp4" -c:v libx264 -preset slow -crf 27 -pix_fmt yuv420p -movflags +faststart -c:a copy "$HERE/sardeenz-cannery.mp4"
ffmpeg -loglevel error -y -ss 35.5 -i "$HERE/sardeenz-cannery.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
