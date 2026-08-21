#!/bin/bash
# Kiosk launcher — auto-runs when Pi logs in (called from ~/.config/labwc/autostart).
# Starts the backend (Vite + WebSocket hub + Python model server) and opens
# Firefox full-screen (kiosk) at the web app. Camera + autoplay are pre-approved
# via /etc/firefox/policies/policies.json.

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
# (If it never comes up we still launch — Firefox will show a connection
# error, which is more useful than failing silently.)
for i in $(seq 1 60); do
  if curl -fsS -m 1 "$URL" >/dev/null 2>&1; then
    echo "[kiosk] vite ready after ${i}s" >> "$LOG"
    break
  fi
  sleep 1
done

# Small extra delay so PipeWire / camera / font cache finish coming up
# (opening the browser too early caused emojis to fall back to text glyphs
#  and getUserMedia to fail on the first session.)
sleep 3

# Dedicated kiosk profile, deliberately outside ~/.mozilla/firefox/ so Firefox
# never reads profiles.ini for this launch. That file had ShowSelector=1 set,
# which pops the profile-manager screen instead of the app on every boot, and
# left a trail of "Profile 1/2/3" dirs behind it. --profile <path> sidesteps the
# selector and the cross-profile lock clash in one go.
# Camera/mic + autoplay still apply: /etc/firefox/policies/policies.json is a
# system-wide enterprise policy, not per-profile.
FF_PROFILE="$HOME/.mozilla/firefox-kiosk"
mkdir -p "$FF_PROFILE"

# A kiosk bin gets unplugged rather than shut down, so Firefox rarely exits
# cleanly and the profile lock survives the reboot. Clear any leftover instance
# and its lock before claiming the profile.
pkill -f '/usr/lib/firefox/firefox' 2>/dev/null && sleep 2
rm -f "$FF_PROFILE/.parentlock" "$FF_PROFILE/lock"

# exec so this script's PID becomes Firefox — easier to kill / restart from the
# session manager.
#   --kiosk                fullscreen, no toolbars/chrome
#   MOZ_ENABLE_WAYLAND=1   native Wayland on labwc (proper fullscreen)
export MOZ_ENABLE_WAYLAND=1
exec firefox --kiosk --profile "$FF_PROFILE" "$URL"
