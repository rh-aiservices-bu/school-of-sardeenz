#!/bin/sh
# One command: voice → picture → sound → film.  LIB = the Lemo-Opuscar library (github.com/lemomo-ai/lemo-opuscar), with its core and voice tiers installed.
# Needs ffmpeg 7+ on PATH.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=${LIB:-$HOME/lemo-opuscar}
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the Lemo-Opuscar library folder"; exit 1; }
cd "$LIB"
[ -f "$HERE/voices/L1.wav" ] || "$LIB/.venv/bin/python" core/tts/tts.py "$HERE/lines.json" "$HERE/voices"
node core/render/events.mjs "$HERE"
node core/render/video.mjs "$HERE" --fps 24 --workers "${WORKERS:-2}" --out "$HERE/out/video.mp4"
"$LIB/.venv/bin/python" "$HERE/mix.py"
"$LIB/.venv/bin/python" "$HERE/tools/subs.py"
"$LIB/.venv/bin/python" core/render/srt.py "$HERE/out/srt.json" "$HERE/subtitles_en.srt"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/sardeenz-iso.mp4" 24 0
node core/render/still.mjs "$HERE" 36.8 --out "$HERE/out" && cp "$HERE/out/t_36.8.jpg" "$HERE/poster.jpg"
echo "done: $HERE/sardeenz-iso.mp4"
