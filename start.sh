#!/usr/bin/env bash
set -e

export DISPLAY=:99

if [ -z "${VNC_PASSWORD:-}" ]; then
  echo "Missing VNC_PASSWORD environment variable"
  exit 1
fi

mkdir -p /root/.vnc
x11vnc -storepasswd "$VNC_PASSWORD" /root/.vnc/passwd >/dev/null

Xvfb :99 -screen 0 1440x900x24 -ac +extension GLX +render -noreset &
fluxbox >/tmp/fluxbox.log 2>&1 &
x11vnc -display :99 -forever -shared -rfbauth /root/.vnc/passwd -rfbport 5900 -localhost >/tmp/x11vnc.log 2>&1 &

NOVNC_PORT="${PORT:-8080}"
websockify --web=/usr/share/novnc/ "$NOVNC_PORT" localhost:5900 >/tmp/novnc.log 2>&1 &

exec npm start
