#!/usr/bin/env bash
set -e

# Railway now runs only the Telegram coordinator, OCR and secure local-agent relay.
# DLD/Trakheesi browser automation runs on the office computer.
exec npm start
