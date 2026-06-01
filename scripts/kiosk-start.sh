#!/bin/bash
# Kiosk launcher — auto-runs when Pi logs in (called from ~/.config/labwc/autostart).
# Starts the backend (Vite + serial bridge + Python model server) and opens
# Chromium full-screen at the web app. Camera + autoplay are pre-approved.

set -u

# Resolve project root from this script's location so it works for any
# user / install path (no hard-coded /home/intira).
PROJECT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
LOG=$PROJECT/kiosk.log
URL=http://localhost:5173/

cd "$PROJECT"

# Make sure logs don't grow forever — wipe on every boot
: > "$LOG"

# Start backend (vite + serial bridge + model server) in background.
# disown lets it survive after this script exits.
nohup npm run dev:all >>"$LOG" 2>&1 &
BACKEND_PID=$!
disown $BACKEND_PID
echo "[kiosk] backend pid=$BACKEND_PID" >> "$LOG"

# Wait up to 60s for Vite to respond before launching the browser.
# (If it never comes up we still launch — Chromium will show a connection
# error, which is more useful than failing silently.)
for i in $(seq 1 60); do
  if curl -fsS -m 1 "$URL" >/dev/null 2>&1; then
    echo "[kiosk] vite ready after ${i}s" >> "$LOG"
    break
  fi
  sleep 1
done

# Small extra delay so PipeWire / camera / font cache finish coming up
# (Chromium opening too early caused emojis to fall back to text glyphs
#  and getUserMedia to fail on the first session.)
sleep 3

# Launch Chromium kiosk. exec so this script's PID becomes Chromium —
# easier to kill / restart from the session manager.
#   --use-fake-ui-for-media-stream      auto-accept camera/mic prompt (real device)
#   --auto-accept-camera-and-microphone-capture  newer alias — covers Chromium ≥120
#   --enable-features=...               nudge Chromium 143 to use legacy media path
#   --autoplay-policy=...               sounds without user gesture
exec chromium \
  --start-fullscreen \
  --password-store=basic \
  --noerrdialogs \
  --disable-restore-session-state \
  --disable-session-crashed-bubble \
  --disable-infobars \
  --disable-features=TranslateUI,WebRtcPipeWireCamera \
  --no-first-run \
  --no-default-browser-check \
  --check-for-update-interval=31536000 \
  --autoplay-policy=no-user-gesture-required \
  --window-position=0,0 \
  "$URL"
