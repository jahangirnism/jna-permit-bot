#!/usr/bin/env bash
set -e

export DISPLAY=:99

Xvfb :99 -screen 0 1440x900x24 -ac +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &
fluxbox >/tmp/fluxbox.log 2>&1 &

if [ -n "${VNC_PASSWORD:-}" ]; then
  mkdir -p /root/.vnc
  x11vnc -storepasswd "$VNC_PASSWORD" /root/.vnc/passwd >/dev/null
  x11vnc -display :99 -forever -shared -rfbauth /root/.vnc/passwd -rfbport 5900 -localhost >/tmp/x11vnc.log 2>&1 &

  NOVNC_PORT="${PORT:-8080}"
  websockify --web=/usr/share/novnc/ "$NOVNC_PORT" localhost:5900 >/tmp/novnc.log 2>&1 &
  echo "noVNC enabled on port $NOVNC_PORT"
else
  echo "VNC_PASSWORD is not set; starting Telegram bot without remote browser access"
fi

exec npm start
